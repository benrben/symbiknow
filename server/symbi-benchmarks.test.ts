import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SymbiEmbedder } from './symbi-embedding.js';
import { compareRetrieval } from './symbi-compare.js';
import { directoryBytes, durationDistribution, embeddingModelVersion, injectedEmbedderLimit,
  modelArtifactBytes, proveRetrievalRecovery, rejectsUnscopedPrincipal, storageDelta } from './symbi-retrieval-final.js';
import { createSymbiIndex, type SymbiStorageStats } from './symbi-index.js';
import { MINILM_MODEL_VERSION } from './symbi-embedding.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'symbi-benchmark-test-'));
  roots.push(root);
  const source = join(root, 'copied-documents.json');
  await writeFile(source, JSON.stringify({ canvasId: 'copied-probe', documents: [
    { id: 'rollback', title: 'Rollback procedure',
      content: 'If a production rollout fails, restore the verified snapshot and check service health.' },
    { id: 'checklist', title: 'Release checklist',
      content: 'Before an Atlas deployment, verify approval, staging health, and the release checklist.' },
    { id: 'validation', title: 'Release validation',
      content: 'After deployment, run smoke tests and compare latency and error rates.' },
    { id: 'access', title: 'New hire access',
      content: 'The access owner grants each new worker only the permissions their job requires.' },
    { id: 'onboarding', title: 'First-week onboarding',
      content: 'A newcomer meets the team and security buddy during the first week.' },
  ] }));
  return { root, source };
}

function fixtureEmbedder(): SymbiEmbedder {
  return { modelVersion: 'offline-fixture-vector-v1', embed: async (texts) => texts.map((text) => {
    const lower = text.toLowerCase();
    if (/rollback|recover|restore|snapshot/.test(lower)) return [1, 0, 0];
    if (/hire|onboard|worker|access/.test(lower)) return [0, 1, 0];
    return [0, 0, 1];
  }) };
}

it('compares existing lexical, larger candidate, and SQLite hybrid retrieval on an isolated copied fixture', async () => {
  const { root, source } = await fixture();
  const report = await compareRetrieval(join(root, 'unused-model'), source, { embedderFactory: fixtureEmbedder });
  expect(report).toMatchObject({ providerRequests: 0, embeddingModel: 'offline-fixture-vector-v1',
    fixture: { copiedDocuments: 5, syntheticDistractors: 12, expectedQueries: 8 },
    indexing: { storageWrites: { warm: 0 } },
    sharedQuestionReuse: { measured: false } });
  const arms = report.arms as Array<{ arm: string; hits: Array<{ name: string; expectedRank: number | null }>; recallAtBudget: number }>;
  expect(arms).toHaveLength(3);
  expect(arms.map((arm) => arm.arm)).toEqual([
    'existing lexical limit 4', 'existing lexical limit 16', 'SQLite FTS5 + offline-fixture-vector-v1 hybrid limit 16',
  ]);
  expect(arms.every((arm) => Number.isFinite(arm.recallAtBudget))).toBe(true);
  expect(arms[2].hits.find((hit) => hit.name === 'recovery paraphrase')?.expectedRank).not.toBeNull();
  expect(report.limitations).toEqual(expect.arrayContaining([expect.stringContaining('injected embedder')]));
});

it('proves restart, stale-source, deletion, permissions, and long-tail retrieval using ordinary fixture files', async () => {
  const { root, source } = await fixture();
  const report = await proveRetrievalRecovery(join(root, 'unused-model'), source,
    { embedderFactory: fixtureEmbedder });
  expect(report).toMatchObject({ providerRequests: 0, embeddingModel: 'offline-fixture-vector-v1',
    modelArtifactBytes: null,
    fixture: { copiedDocuments: 5, syntheticLongDocuments: 1, sourceFilesAreOrdinaryMarkdown: true } });
  expect(Object.values(report.proof as Record<string, boolean>).every(Boolean)).toBe(true);
  expect((report.sourceReads as { operations: number; bytes: number }).operations).toBeGreaterThan(6);
  expect((report.cold as { storage: { writeOperations: number } }).storage.writeOperations).toBeGreaterThan(0);
  expect(report.limits).toEqual(expect.arrayContaining([expect.stringContaining('injected embedder')]));
});

it('keeps proof measurements explicit for empty samples, missing counters, and nested disk bytes', async () => {
  expect(durationDistribution([])).toEqual({ p50: 0, p95: 0, max: 0 });
  expect(durationDistribution([4, 1, 3, 2])).toEqual({ p50: 2, p95: 4, max: 4 });
  const before: SymbiStorageStats = { readOperations: 1, rowsRead: 2, bytesReturned: 3,
    writeOperations: 4, bytesBoundForWrites: 5 };
  const after: SymbiStorageStats = { readOperations: 3, rowsRead: 5, bytesReturned: 10,
    writeOperations: 9, bytesBoundForWrites: 15 };
  expect(storageDelta(before, after)).toEqual({ readOperations: 2, rowsRead: 3, bytesReturned: 7,
    writeOperations: 5, bytesBoundForWrites: 10 });
  expect(() => storageDelta(null, after)).toThrow('requires storage counters');
  expect(() => storageDelta(before, null)).toThrow('requires storage counters');
  const { root } = await fixture();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'model.bin'), Buffer.alloc(7));
  expect(await directoryBytes(join(root, 'nested'))).toBe(7);
  expect(await directoryBytes(root)).toBeGreaterThan(7);
});

it('identifies injected versus local models without loading a model or calling a provider', async () => {
  const { root } = await fixture();
  const embedder = fixtureEmbedder();
  expect(embeddingModelVersion(embedder)).toBe('offline-fixture-vector-v1');
  expect(embeddingModelVersion()).toBe(MINILM_MODEL_VERSION);
  expect(injectedEmbedderLimit(embedder)).toEqual([expect.stringContaining('do not measure MiniLM')]);
  expect(injectedEmbedderLimit()).toEqual([]);
  expect(await modelArtifactBytes(root, embedder)).toBeNull();
  const artifact = join(root, 'Xenova', 'all-MiniLM-L6-v2');
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, 'model_int8.onnx'), Buffer.alloc(19));
  expect(await modelArtifactBytes(root)).toBe(19);
});

it('fails the recovery proof if a scoped principal can search without an authorized scope', async () => {
  const { root, source } = await fixture();
  expect(await rejectsUnscopedPrincipal({ search: async () => ({}) as never })).toBe(false);
  expect(await rejectsUnscopedPrincipal({ search: async () => { throw new Error('scope required'); } })).toBe(true);
  await expect(proveRetrievalRecovery(join(root, 'unused-model'), source, {
    embedderFactory: fixtureEmbedder,
    indexFactory: async (options) => {
      const index = await createSymbiIndex(options);
      const search = index.search.bind(index);
      index.search = async (request, retry) => search(request.principal === 'scoped-agent' && !request.allowedCanvasIds
        ? { ...request, allowedCanvasIds: ['copied-probe'] } : request, retry);
      return index;
    },
  })).rejects.toThrow('Retrieval recovery proof failed: missingPermissionRejected');
});

it('removes its temporary source copy if the derived index cannot open', async () => {
  const { root, source } = await fixture();
  const temporaryProofs = async () => (await readdir(tmpdir())).filter(name => name.startsWith('symbi-retrieval-final-')).sort();
  const before = await temporaryProofs();
  await expect(proveRetrievalRecovery(join(root, 'unused-model'), source, {
    embedderFactory: fixtureEmbedder,
    indexFactory: async () => { throw new Error('isolated SQLite open failed'); },
  })).rejects.toThrow('isolated SQLite open failed');
  expect(await temporaryProofs()).toEqual(before);
});
