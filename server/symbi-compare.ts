import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import type { SymbiIndexDocument } from '../shared/symbi-contract.js';
import { searchCandidates } from './search-candidates.js';
import { createSymbiIndex, type SymbiIndex } from './symbi-index.js';
import type { SymbiEmbedder } from './symbi-embedding.js';
import { embeddingModelVersion, injectedEmbedderLimit } from './symbi-retrieval-final.js';

interface CopiedProbe {
  canvasId: string;
  documents: { id: string; title: string; content: string }[];
}

interface QueryFixture {
  name: string;
  query: string;
  expectedTitles: string[];
  category: 'specific' | 'ambiguous' | 'missing';
}

const queries: QueryFixture[] = [
  { name: 'recovery paraphrase', query: 'How do we recover after a production rollout fails?',
    expectedTitles: ['Rollback procedure'], category: 'specific' },
  { name: 'preflight checks', query: 'What checks happen before an Atlas deployment?',
    expectedTitles: ['Release checklist'], category: 'specific' },
  { name: 'post release checks', query: 'Which smoke tests and latency checks follow deployment?',
    expectedTitles: ['Release validation'], category: 'specific' },
  { name: 'least privilege', query: 'Who grants a new worker only the access their job requires?',
    expectedTitles: ['New hire access'], category: 'specific' },
  { name: 'first week', query: 'When does a newcomer meet the team and security buddy?',
    expectedTitles: ['First-week onboarding'], category: 'specific' },
  { name: 'ambiguous onboarding', query: 'new employee onboarding',
    expectedTitles: ['New hire access', 'First-week onboarding'], category: 'ambiguous' },
  { name: 'missing evidence', query: 'Where are the tax invoice retention rules?',
    expectedTitles: [], category: 'missing' },
  { name: 'lexical distractors', query: 'deployment recovery',
    expectedTitles: ['Rollback procedure'], category: 'specific' },
];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function distribution(values: number[]): { p50: number; p95: number; max: number } {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(0, ...values) };
}

function indexDocument(canvasId: string, doc: CopiedProbe['documents'][number]): SymbiIndexDocument {
  return { canvasId, blockId: doc.id, title: doc.title, content: doc.content, contentHash: digest(doc.content) };
}

function canvasFor(documents: SymbiIndexDocument[], canvasId: string): CanvasDocument {
  const blocks: CanvasBlock[] = documents.map((doc) => ({
    id: doc.blockId, title: doc.title, content: doc.content, contentHash: doc.contentHash,
    file: `${doc.blockId}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300,
    links: doc.links ?? [], tags: doc.tags, group: doc.group, purpose: doc.purpose,
  }));
  return { id: canvasId, name: 'Copied offline probe', workspaceId: 'offline-comparison', blocks };
}

function distractors(canvasId: string): SymbiIndexDocument[] {
  return Array.from({ length: 12 }, (_, index) => {
    const label = String(index + 1).padStart(2, '0');
    const content = `Meeting calendar item ${label}. Marketing reviewed webinar invitations, visual assets, and guest seating. No service procedure was recorded.`;
    return { canvasId, blockId: `synthetic-distractor-${label}`, title: `Deployment recovery calendar ${label}`,
      content, contentHash: digest(content), tags: ['meeting calendar'], purpose: 'Track marketing event logistics' };
  });
}

export async function comparisonDirectoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const entry = await stat(child);
    total += entry.isDirectory() ? await comparisonDirectoryBytes(child) : entry.size;
  }
  return total;
}

export interface ArmResult {
  arm: string;
  latencyMs: { p50: number; p95: number; max: number };
  cpuMicros: NodeJS.CpuUsage;
  hits: { name: string; expectedTitles: string[]; titles: string[]; expectedRank: number | null;
    precisionAt4: number; hasDistractor: boolean }[];
  recallAtBudget: number;
  top1ExactMatchRate: number;
  meanExactTitlePrecisionAt4: number;
  missingEvidenceReturned: number;
  sourceBytesScannedEstimate?: number;
}

function scoreHits(name: string, titles: string[], expectedTitles: string[]): ArmResult['hits'][number] {
  const rank = titles.findIndex((title) => expectedTitles.includes(title));
  return { name, expectedTitles, titles, expectedRank: rank < 0 ? null : rank + 1,
    precisionAt4: titles.slice(0, 4).filter((title) => expectedTitles.includes(title)).length
      / Math.max(1, Math.min(4, titles.length)),
    hasDistractor: titles.some((title) => title.startsWith('Deployment recovery calendar')) };
}

export function summarize(arm: string, samples: { ms: number; hit: ArmResult['hits'][number] }[],
  cpuMicros: NodeJS.CpuUsage, sourceBytesScannedEstimate?: number): ArmResult {
  const considered = samples.filter((sample) => sample.hit.expectedTitles.length);
  if (!considered.length) throw new Error('Comparison arm requires at least one expected document');
  return { arm, latencyMs: distribution(samples.map((sample) => sample.ms)), cpuMicros,
    hits: samples.map((sample) => sample.hit),
    recallAtBudget: considered.filter((sample) => sample.hit.expectedRank !== null).length / considered.length,
    top1ExactMatchRate: considered.filter((sample) => sample.hit.expectedRank === 1).length / considered.length,
    meanExactTitlePrecisionAt4: considered.reduce((sum, sample) => sum + sample.hit.precisionAt4, 0) / considered.length,
    missingEvidenceReturned: samples.find((sample) => sample.hit.name === 'missing evidence')?.hit.titles.length ?? 0,
    ...(sourceBytesScannedEstimate === undefined ? {} : { sourceBytesScannedEstimate }),
  };
}

function benchmarkLegacy(canvas: CanvasDocument, limit: number): ArmResult {
  searchCandidates([canvas], queries[0].query, { limit });
  const beforeCpu = process.cpuUsage();
  const samples = queries.map((fixture) => {
    const started = performance.now();
    const titles = searchCandidates([canvas], fixture.query, { limit }).map((hit) => hit.title);
    return { ms: performance.now() - started, hit: scoreHits(fixture.name, titles, fixture.expectedTitles) };
  });
  const bytes = canvas.blocks.reduce((sum, block) => sum + Buffer.byteLength(block.content), 0) * queries.length;
  return summarize(`existing lexical limit ${limit}`, samples, process.cpuUsage(beforeCpu), bytes);
}

async function benchmarkHybrid(index: SymbiIndex, titleById: Map<string, string>, limit: number,
  modelVersion: string): Promise<ArmResult> {
  const beforeCpu = process.cpuUsage();
  const samples = [];
  for (const fixture of queries) {
    const started = performance.now();
    const result = await index.search({ query: fixture.query, mode: 'hybrid', limit });
    const titles = [...new Set(result.passages.map((passage) => indexedTitle(titleById, passage.blockId)))];
    samples.push({ ms: performance.now() - started, hit: scoreHits(fixture.name, titles, fixture.expectedTitles) });
  }
  return summarize(`SQLite FTS5 + ${modelVersion} hybrid limit ${limit}`, samples, process.cpuUsage(beforeCpu));
}

export function indexedTitle(titleById: Map<string, string>, blockId: string): string {
  const title = titleById.get(blockId);
  if (title === undefined) throw new Error(`Indexed passage ${blockId} is absent from the copied fixture`);
  return title;
}

export async function compareRetrieval(modelRoot: string, copiedFixturePath: string,
  options: { embedderFactory?: () => SymbiEmbedder; indexFactory?: typeof createSymbiIndex } = {}): Promise<Record<string, unknown>> {
  const copied = JSON.parse(await readFile(copiedFixturePath, 'utf8')) as CopiedProbe;
  const retained = copied.documents.map((doc) => indexDocument(copied.canvasId, doc));
  const augmented = [...retained, ...distractors(copied.canvasId)];
  const dataDir = await mkdtemp(join(tmpdir(), 'symbi-retrieval-compare-'));
  let peakRss = process.memoryUsage().rss;
  const memorySample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  const beforeRss = peakRss;
  const beforeCpu = process.cpuUsage();
  const embedder = options.embedderFactory?.();
  const modelVersion = embeddingModelVersion(embedder);
  const openIndex = options.indexFactory ?? createSymbiIndex;
  let index: SymbiIndex | undefined;
  try {
    index = await openIndex({ dataDir, modelRoot, embedder });
    const coldStarted = performance.now();
    const cold = [];
    for (const doc of retained) cold.push(await index.upsert(doc));
    const retainedColdMs = performance.now() - coldStarted;
    const retainedBytes = await comparisonDirectoryBytes(dataDir);
    const augmentedStarted = performance.now();
    const added = [];
    for (const doc of augmented.slice(retained.length)) added.push(await index.upsert(doc));
    const augmentedMs = performance.now() - augmentedStarted;
    const warmStarted = performance.now();
    const warm = [];
    for (const doc of augmented) warm.push(await index.upsert(doc));
    const warmMs = performance.now() - warmStarted;
    const canvas = canvasFor(augmented, copied.canvasId);
    const titleById = new Map(augmented.map((doc) => [doc.blockId, doc.title]));
    const arms = [benchmarkLegacy(canvas, 4), benchmarkLegacy(canvas, 16),
      await benchmarkHybrid(index, titleById, 16, modelVersion)];
    const indexedBytes = await comparisonDirectoryBytes(dataDir);
    return {
      fixture: { source: copiedFixturePath, copiedDocuments: retained.length, syntheticDistractors: augmented.length - retained.length,
        expectedQueries: queries.length, note: 'Copied five-document provider probe plus explicitly synthetic distractors; not a full retained workspace.' },
      embeddingModel: modelVersion,
      arms, indexing: { retainedColdMs, addedDistractorsMs: augmentedMs, warmMs,
        retainedExecutionMs: distribution(cold.map((result) => result.durationMs)),
        augmentedExecutionMs: distribution([...cold, ...added].map((result) => result.durationMs)),
        warmExecutionMs: distribution(warm.map((result) => result.durationMs)),
        queueWaitMs: distribution([...cold, ...added].map((result) => result.queueWaitMs)),
        storageWrites: { cold: cold.reduce((sum, result) => sum + result.storageWrites, 0),
          added: added.reduce((sum, result) => sum + result.storageWrites, 0),
          warm: warm.reduce((sum, result) => sum + result.storageWrites, 0) },
        storageBytes: { retained: retainedBytes, augmented: indexedBytes },
      },
      resources: { cpuMicros: process.cpuUsage(beforeCpu), rssBefore: beforeRss,
        rssAfter: process.memoryUsage().rss, sampledPeakRss: Math.max(peakRss, process.memoryUsage().rss) },
      providerRequests: 0,
      sharedQuestionReuse: { measured: false, reason: 'This read-only retrieval fixture does not run Jev automatic actions or provider questions.' },
      limitations: ['Query judgments are manually specified for the small copied probe, not a broad relevance set.',
        'Exact-title precision counts only the designated target document; other genuinely useful results may be scored as non-targets.',
        'The 4-to-16 limit arm covers general lexical search, not six-action candidate generation or Jev judgment precision.',
        'Lexical source bytes scanned are an estimate; SQLite disk read bytes are not instrumented.',
        'Model startup timing depends on operating-system file cache; no cache was cleared.',
        'The fixture is already copied; upload-to-durable time, provider rounds, and retained full-workspace behavior are outside this benchmark.',
        ...injectedEmbedderLimit(embedder)],
    };
  } finally {
    clearInterval(memorySample);
    try { await index?.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  }
}

if (process.argv[1]?.endsWith('symbi-compare.ts')) {
  const modelRoot = process.argv[2];
  if (!modelRoot) throw new Error('Usage: node --import tsx server/symbi-compare.ts MODEL_ROOT [OUTPUT_JSON]');
  const source = resolve('work/jev-live-20261005/five-documents.json');
  const output = process.argv[3] && resolve(process.argv[3]);
  const result = await compareRetrieval(modelRoot, source);
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
}
