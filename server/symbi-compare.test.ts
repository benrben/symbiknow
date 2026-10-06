import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SymbiEmbedder } from './symbi-embedding.js';
import { compareRetrieval, comparisonDirectoryBytes, indexedTitle, percentile, summarize } from './symbi-compare.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function copiedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'symbi-comparison-case-'));
  roots.push(root);
  const source = join(root, 'copied.json');
  await writeFile(source, JSON.stringify({ canvasId: 'offline', documents: [
    { id: 'rollback', title: 'Rollback procedure', content: 'Restore the previous release after a failed rollout.' },
    { id: 'checklist', title: 'Release checklist', content: 'Verify the deployment before production.' },
    { id: 'validation', title: 'Release validation', content: 'Run smoke tests and compare error rates.' },
    { id: 'access', title: 'New hire access', content: 'Grant each worker only needed access.' },
    { id: 'onboarding', title: 'First-week onboarding', content: 'Meet the team in the first week.' },
  ] }));
  return { root, source };
}

const embedder: SymbiEmbedder = { modelVersion: 'offline-fixture', embed: async texts => texts.map(() => [1, 0]) };

it('reports empty latency and nested disk usage without inventing extra samples', async () => {
  expect(percentile([], 0.95)).toBe(0);
  expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
  const root = await mkdtemp(join(tmpdir(), 'symbi-comparison-bytes-'));
  roots.push(root);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'source.md'), Buffer.alloc(13));
  await writeFile(join(root, 'index.bin'), Buffer.alloc(7));
  expect(await comparisonDirectoryBytes(root)).toBe(20);
});

it('reports zero missing-evidence hits when the measured query set contains none', () => {
  const result = summarize('single checked query', [{ ms: 4, hit: {
    name: 'rollback', expectedTitles: ['Rollback procedure'], titles: ['Rollback procedure'],
    expectedRank: 1, precisionAt4: 1, hasDistractor: false,
  } }], { user: 10, system: 5 });
  expect(result).toMatchObject({ recallAtBudget: 1, top1ExactMatchRate: 1,
    meanExactTitlePrecisionAt4: 1, missingEvidenceReturned: 0, latencyMs: { p50: 4, p95: 4, max: 4 } });
  expect(result).not.toHaveProperty('sourceBytesScannedEstimate');
  expect(() => summarize('missing-only query', [{ ms: 4, hit: {
    name: 'missing evidence', expectedTitles: [], titles: [], expectedRank: null,
    precisionAt4: 0, hasDistractor: false,
  } }], { user: 0, system: 0 })).toThrow('requires at least one expected document');
});

it('fails clearly if a ranked index row is absent from the copied source map', () => {
  const titles = new Map([['known', 'Known source']]);
  expect(indexedTitle(titles, 'known')).toBe('Known source');
  expect(() => indexedTitle(titles, 'stale')).toThrow('Indexed passage stale is absent');
});

it('cleans the isolated index directory if opening SQLite fails', async () => {
  const { root, source } = await copiedFixture();
  const current = async () => (await readdir(tmpdir())).filter(name => name.startsWith('symbi-retrieval-compare-')).sort();
  const before = await current();
  await expect(compareRetrieval(join(root, 'unused-model'), source, {
    embedderFactory: () => embedder,
    indexFactory: async () => { throw new Error('isolated index could not open'); },
  })).rejects.toThrow('isolated index could not open');
  expect(await current()).toEqual(before);
});
