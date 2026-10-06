import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SymbiEmbedder } from './symbi-embedding.js';
import { benchmarkSymbiIndex, percentile, sizeOf } from './symbi-index-benchmark.js';
import { symbiFixtureDocuments, symbiFixtureExpectations } from './symbi-index.fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fixtureEmbedder(): SymbiEmbedder {
  return { modelVersion: 'offline-benchmark-fixture-v1', embed: async (texts) => texts.map((text) => {
    const lower = text.toLowerCase();
    if (/onboard|employee|account|benefits/.test(lower)) return [0, 1, 0];
    if (/recover|failed|restore|rollback/.test(lower)) return [1, 0, 0];
    return [0, 0, 1];
  }) };
}

it('measures a complete isolated cold/warm index run and retrieval with explicit fixture-vector provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symbi-index-benchmark-test-'));
  roots.push(root);
  const report = await benchmarkSymbiIndex(join(root, 'model-not-used'), { embedderFactory: fixtureEmbedder });
  const cold = report.coldResults as Array<{ status: string; embeddedChunks: number; durationMs: number }>;
  const warm = report.warmResults as Array<{ status: string; storageWrites: number; durationMs: number }>;
  const queries = report.queries as Array<{ query: string; expected: string; semanticTop?: string;
    keywordTop?: string; semanticMs: number; semanticCoverage: { status: string } }>;
  expect(cold).toHaveLength(symbiFixtureDocuments.length);
  expect(cold.every((result) => result.status === 'ready' && result.embeddedChunks > 0)).toBe(true);
  expect(warm).toHaveLength(symbiFixtureDocuments.length);
  expect(warm.every((result) => result.status === 'ready' && result.storageWrites === 0)).toBe(true);
  expect(report.warmStorageWrites).toBe(0);
  expect(report.coldStorageWrites).toEqual(expect.any(Number));
  expect(report.coldStorageWrites).toBeGreaterThan(0);
  expect(report.coldExecutionMs).toMatchObject({ p50: expect.any(Number), p95: expect.any(Number), max: expect.any(Number) });
  expect(report.coldQueueWaitMs).toHaveLength(symbiFixtureDocuments.length);
  expect(queries).toHaveLength(symbiFixtureExpectations.retrieval.length);
  expect(queries.every((query) => query.semanticCoverage.status === 'ready' && query.semanticMs >= 0)).toBe(true);
  expect(queries[0]).toMatchObject({ expected: 'rollback', semanticTop: 'rollback' });
  expect(queries[1]).toMatchObject({ expected: 'onboarding', semanticTop: 'onboarding' });
  expect(report).toMatchObject({ providerRequests: 0, embeddingModel: 'offline-benchmark-fixture-v1',
    limitations: [expect.stringContaining('injected offline embedder')],
    cpuMicros: { user: expect.any(Number), system: expect.any(Number) },
    ramRssBefore: expect.any(Number), ramRssAfter: expect.any(Number), ramRssSampledPeak: expect.any(Number),
    storageBytes: expect.any(Number) });
  expect(report.storageBytes).toBeGreaterThan(0);
});

it('counts nested index files and computes stable timing percentiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symbi-index-size-test-'));
  roots.push(root);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'main.sqlite'), Buffer.alloc(8));
  await writeFile(join(root, 'nested', 'wal'), Buffer.alloc(5));
  expect(await sizeOf(root)).toBe(13);
  expect(percentile([9, 1, 5], 0.5)).toBe(5);
  expect(percentile([9, 1, 5], 0.95)).toBe(9);
  expect(percentile([], 0.95)).toBe(0);
});

it('labels missing offline model results as degraded instead of MiniLM performance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symbi-index-benchmark-missing-model-'));
  roots.push(root);
  const report = await benchmarkSymbiIndex(join(root, 'uninstalled-model'));
  const cold = report.coldResults as Array<{ status: string; reason?: string }>;
  expect(cold).toHaveLength(symbiFixtureDocuments.length);
  expect(cold.every((result) => result.status === 'degraded'
    && result.reason?.includes('Offline INT8 MiniLM model is missing'))).toBe(true);
  expect(report).toMatchObject({ providerRequests: 0,
    limitations: [expect.stringContaining('degraded keyword fallback')] });
  expect((report.queries as Array<{ semanticCoverage: { status: string } }>).every(
    (query) => query.semanticCoverage.status === 'degraded')).toBe(true);
});
