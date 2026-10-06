import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSymbiIndex, type SymbiIndex } from './symbi-index.js';
import { MINILM_MODEL_VERSION, type SymbiEmbedder } from './symbi-embedding.js';
import { symbiFixtureDocuments, symbiFixtureExpectations } from './symbi-index.fixture.js';

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

export async function sizeOf(dir: string): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const item = await stat(path);
    bytes += item.isDirectory() ? await sizeOf(path) : item.size;
  }
  return bytes;
}

export async function benchmarkSymbiIndex(modelRoot: string,
  options: { embedderFactory?: () => SymbiEmbedder } = {}): Promise<Record<string, unknown>> {
  const dataDir = await mkdtemp(join(tmpdir(), 'symbi-index-benchmark-'));
  const beforeCpu = process.cpuUsage();
  const beforeRam = process.memoryUsage().rss;
  let peakRam = beforeRam;
  const memorySample = setInterval(() => { peakRam = Math.max(peakRam, process.memoryUsage().rss); }, 10);
  const started = performance.now();
  const embedder = options.embedderFactory?.();
  let index: SymbiIndex | undefined;
  try {
    index = await createSymbiIndex({ dataDir, modelRoot, embedder });
    const coldResults = [];
    for (const doc of symbiFixtureDocuments) coldResults.push(await index.upsert(doc));
    const coldMs = performance.now() - started;
    const warmStarted = performance.now();
    const warmResults = [];
    for (const doc of symbiFixtureDocuments) warmResults.push(await index.upsert(doc));
    const warmMs = performance.now() - warmStarted;
    const queries = [];
    for (const fixture of symbiFixtureExpectations.retrieval) {
      const queryStarted = performance.now();
      const semantic = await index.search({ query: fixture.query, mode: 'semantic', limit: 5 });
      const semanticMs = performance.now() - queryStarted;
      const keyword = await index.search({ query: fixture.query, mode: 'keyword', limit: 5 });
      queries.push({ query: fixture.query, expected: fixture.topBlockId,
        semanticTop: semantic.passages[0]?.blockId, keywordTop: keyword.passages[0]?.blockId,
        semanticMs, semanticCoverage: semantic.coverage });
    }
    return {
      coldMs, warmMs, coldResults, warmResults, queries,
      coldExecutionMs: { p50: percentile(coldResults.map((result) => result.durationMs), 0.5),
        p95: percentile(coldResults.map((result) => result.durationMs), 0.95),
        max: Math.max(...coldResults.map((result) => result.durationMs)) },
      coldQueueWaitMs: coldResults.map((result) => result.queueWaitMs),
      coldStorageWrites: coldResults.reduce((sum, result) => sum + result.storageWrites, 0),
      warmStorageWrites: warmResults.reduce((sum, result) => sum + result.storageWrites, 0),
      cpuMicros: process.cpuUsage(beforeCpu),
      ramRssBefore: beforeRam, ramRssAfter: process.memoryUsage().rss,
      ramRssSampledPeak: Math.max(peakRam, process.memoryUsage().rss),
      storageBytes: await sizeOf(dataDir), providerRequests: 0,
      embeddingModel: embedder?.modelVersion ?? MINILM_MODEL_VERSION,
      limitations: [
        ...(embedder ? ['An injected offline embedder was used; CPU/RAM timings do not measure MiniLM inference.'] : []),
        ...(coldResults.some((result) => result.status === 'degraded')
          ? ['The local model was unavailable; degraded keyword fallback timings do not measure MiniLM inference.'] : []),
      ],
    };
  } finally {
    clearInterval(memorySample);
    await index?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('symbi-index-benchmark.ts')) {
  const modelRoot = process.argv[2];
  if (!modelRoot) throw new Error('Usage: tsx server/symbi-index-benchmark.ts MODEL_ROOT');
  console.log(JSON.stringify(await benchmarkSymbiIndex(modelRoot), null, 2));
}
