import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSymbiIndex, type SymbiIndexOptions } from './symbi-index.js';
import type { SymbiEmbedder } from './symbi-embedding.js';
import { symbiFixtureDocuments, symbiFixtureExpectations } from './symbi-index.fixture.js';
import { chunkDocument } from './symbi-retrieval.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

class FixtureEmbedder implements SymbiEmbedder {
  readonly modelVersion = 'fixture-vector-v1';
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += texts.length;
    return texts.map((text) => {
      const lower = text.toLowerCase();
      if (/recover|failed deployment|restore|rollback|health checks/.test(lower)) return [1, 0, 0];
      if (/employee|onboarding|benefits/.test(lower)) return [0, 1, 0];
      if (/release|deploy|production/.test(lower)) return [0.5, 0, 0.8];
      return [0, 0, 1];
    });
  }
}

async function fixture(options: Partial<SymbiIndexOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'symbi-index-test-'));
  dirs.push(dataDir);
  const embedder = new FixtureEmbedder();
  const index = await createSymbiIndex({ dataDir, embedder, ...options });
  return { index, embedder, dataDir };
}

it('finds paraphrases and metadata with exact source references, scoped before retrieval', async () => {
  const { index } = await fixture();
  try {
    expect(index.storageStats()).toBeNull();
    for (const doc of symbiFixtureDocuments) await index.upsert(doc);
    for (const expected of symbiFixtureExpectations.retrieval) {
      const result = await index.search({ query: expected.query, limit: 5, allowedCanvasIds: ['operations', 'people'], mode: 'hybrid' });
      expect(result.passages[0]?.blockId).toBe(expected.topBlockId);
      expect(result.coverage).toMatchObject({ status: 'ready', checkedDocuments: 5, eligibleDocuments: 5, pendingDocuments: 0 });
      const source = symbiFixtureDocuments.find((doc) => doc.blockId === result.passages[0].blockId)!;
      expect(source.content.slice(result.passages[0].startOffset, result.passages[0].endOffset)).toBe(result.passages[0].excerpt);
    }
    const restricted = await index.search({ query: 'employee account', principal: 'limited', allowedCanvasIds: ['operations'] });
    expect(restricted.passages.every((passage) => passage.canvasId === 'operations')).toBe(true);
    expect(restricted.coverage.eligibleDocuments).toBe(4);
    const oneDocument = await index.search({ query: 'rollback', principal: 'limited', allowedCanvasIds: ['operations'],
      allowedDocumentIds: ['release-plan'], expectedDocumentIds: ['rollback', 'release-plan'] });
    expect(oneDocument.passages.every((passage) => passage.blockId === 'release-plan')).toBe(true);
    expect(oneDocument.coverage.eligibleDocuments).toBe(1);
    await expect(index.search({ query: 'employee account', principal: 'limited' })).rejects.toThrow('Authorized canvas scope');
  } finally { await index.close(); }
});

it('recovers from malformed metadata types without widening the authorized search scope', async () => {
  const { index, embedder, dataDir } = await fixture();
  await index.upsert(symbiFixtureDocuments[0]);
  await index.close();
  const moduleName = 'better-sqlite3';
  const { default: Database } = await import(moduleName) as { default: new (file: string) => {
    prepare(sql: string): { run(...values: unknown[]): void }; close(): void } };
  const database = new Database(join(dataDir, 'symbi-index.sqlite'));
  database.prepare('UPDATE index_documents SET tags=?,links=? WHERE block_id=?')
    .run(Buffer.from('not-json'), JSON.stringify({ unexpected: 'shape' }), 'rollback');
  database.close();
  const reopened = await createSymbiIndex({ dataDir, embedder });
  try {
    const scoped = await reopened.search({ query: 'rollback', mode: 'keyword', allowedCanvasIds: ['operations'] });
    expect(scoped.passages[0]?.blockId).toBe('rollback');
    const denied = await reopened.search({ query: 'rollback', principal: 'limited', allowedCanvasIds: ['people'] });
    expect(denied.passages).toEqual([]);
  } finally { await reopened.close(); }
});

it('indexes every part of a long document and reuses unchanged embeddings', async () => {
  const { index, embedder } = await fixture();
  try {
    const content = `${'Overview of routine deployment. '.repeat(80)}\n${'Final recovery instruction: restore snapshot. '.repeat(80)}`;
    const doc = { ...symbiFixtureDocuments[0], blockId: 'long', content, contentHash: 'long-v1' };
    const first = await index.upsert(doc);
    expect(first.embeddedChunks).toBe(chunkDocument(content).length);
    expect(chunkDocument(content).map((chunk) => chunk.excerpt).join('')).toBe(content);
    expect(chunkDocument('a'.repeat(221)).map((chunk) => chunk.excerpt.length)).toEqual([110, 111]);
    const calls = embedder.calls;
    const second = await index.upsert({ ...doc, tags: ['new-tag'], metadataRevision: 2 });
    expect(second.reusedChunks).toBe(first.embeddedChunks);
    expect(embedder.calls).toBe(calls);
    const result = await index.search({ query: 'Final recovery instruction', mode: 'keyword' });
    expect(result.passages.some((passage) => passage.startOffset > 1000)).toBe(true);
    expect(result.passages).toHaveLength(3);
  } finally { await index.close(); }
});

it('cleans deleted files, reconciles restart, and reports pending or degraded coverage', async () => {
  const { index, embedder, dataDir } = await fixture();
  await index.upsert(symbiFixtureDocuments[0]);
  index.markPending({ ...symbiFixtureDocuments[1] });
  const pending = await index.search({ query: 'release', expectedDocumentIds: ['rollback', 'release-plan', 'not-indexed'] });
  expect(pending.coverage).toMatchObject({ status: 'pending', checkedDocuments: 1, pendingDocuments: 2, eligibleDocuments: 3 });
  await index.close();
  const reopened = await createSymbiIndex({ dataDir, embedder });
  try {
    await reopened.rebuild([symbiFixtureDocuments[1]]);
    const result = await reopened.search({ query: 'rollback', allowedCanvasIds: ['operations'] });
    expect(result.passages.every((passage) => passage.blockId !== 'rollback')).toBe(true);
    expect(result.coverage).toMatchObject({ status: 'ready', eligibleDocuments: 1 });
    await reopened.remove('operations', 'release-plan');
    const deleted = await reopened.search({ query: 'deploy' });
    expect(deleted.passages).toEqual([]);
  } finally { await reopened.close(); }
});

it('keeps keyword evidence when the local model is unavailable and invalidates cursors after edits', async () => {
  const { index } = await fixture({ embedder: {
    modelVersion: 'unavailable', embed: async () => { throw new Error('offline model missing'); },
  } });
  try {
    const firstDoc = { ...symbiFixtureDocuments[0], content: 'Rollback steps. '.repeat(200), contentHash: 'many-passages' };
    const update = await index.upsert(firstDoc);
    expect(update.status).toBe('degraded');
    const first = await index.search({ query: 'rollback', limit: 1 });
    expect(first.passages).toHaveLength(1);
    expect(first.coverage.status).toBe('degraded');
    expect(first.nextCursor).toBeDefined();
    await index.upsert({ ...firstDoc, contentHash: 'many-passages-v2', content: `${firstDoc.content} New step.` });
    await expect(index.search({ query: 'rollback', cursor: first.nextCursor })).rejects.toThrow('stale');
  } finally { await index.close(); }
});

it('reports incomplete and non-Error embedding failures while preserving scoped keyword evidence', async () => {
  const { index } = await fixture({ embedder: {
    modelVersion: 'partial-fixture',
    embed: async (texts) => {
      if (texts[0]?.toLowerCase().includes('incomplete')) return [];
      return Promise.reject('offline worker interrupted');
    },
  } });
  try {
    const incomplete = await index.upsert({ ...symbiFixtureDocuments[0], blockId: 'incomplete',
      content: 'Incomplete rollback instructions.', contentHash: 'incomplete-v1' });
    expect(incomplete).toMatchObject({ status: 'degraded', reason: 'Embedding worker returned incomplete batch' });
    const interrupted = await index.upsert({ ...symbiFixtureDocuments[1], blockId: 'interrupted',
      content: 'Deployment interrupted.', contentHash: 'interrupted-v1' });
    expect(interrupted).toMatchObject({ status: 'degraded', reason: 'offline worker interrupted' });
    const keyword = await index.search({ query: 'rollback', mode: 'keyword', allowedCanvasIds: ['operations'] });
    expect(keyword.passages.some((passage) => passage.blockId === 'incomplete')).toBe(true);
    expect(keyword.coverage.status).toBe('degraded');
    expect((await index.search({ query: 'the and', mode: 'keyword' })).passages).toEqual([]);
  } finally { await index.close(); }
});

it('marks a query embedding failure degraded while retaining direct keyword support', async () => {
  const { index } = await fixture({ embedder: {
    modelVersion: 'query-failure-fixture',
    embed: async (texts) => {
      if (texts[0] === 'rollback') return Promise.reject('query worker failed');
      if (texts[0] === 'release') return Promise.reject(new Error('query model unavailable'));
      return texts.map(() => [1, 0]);
    },
  } });
  try {
    await index.upsert(symbiFixtureDocuments[0]);
    const result = await index.search({ query: 'rollback', mode: 'hybrid' });
    expect(result.coverage).toMatchObject({ status: 'degraded', reason: 'query worker failed' });
    expect(result.passages[0]?.blockId).toBe('rollback');
    const errorResult = await index.search({ query: 'release', mode: 'hybrid' });
    expect(errorResult.coverage).toMatchObject({ status: 'degraded', reason: 'query model unavailable' });
    expect(errorResult.passages[0]?.blockId).toBe('rollback');
  } finally { await index.close(); }
});

it('does not publish an outdated embedding after a newer file revision is marked pending', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { index } = await fixture({ embedder: {
    modelVersion: 'slow-fixture', embed: async (texts) => { await gate; return texts.map(() => [1, 0]); },
  } });
  try {
    const old = symbiFixtureDocuments[0];
    const update = index.upsert(old);
    await new Promise((resolve) => setTimeout(resolve, 0));
    index.markPending({ ...old, contentHash: 'newer-hash' });
    release();
    await expect(update).rejects.toThrow('superseded');
    const during = await index.search({ query: 'rollback', expectedDocumentIds: [old.blockId] });
    expect(during.coverage.status).toBe('pending');
    expect(during.passages).toEqual([]);
    const newer = { ...old, contentHash: 'newer-hash', content: 'New rollback revision.' };
    await index.upsert(newer);
    const after = await index.search({ query: 'new rollback revision' });
    expect(after.passages[0]?.contentHash).toBe('newer-hash');
  } finally { release(); await index.close(); }
});

it('drops a deleted source when deletion happens during query embedding', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const { index } = await fixture({ embedder: {
    modelVersion: 'deletion-fixture',
    embed: async (texts) => {
      calls += 1;
      if (calls > 1) await gate;
      return texts.map(() => [1, 0]);
    },
  } });
  try {
    await index.upsert(symbiFixtureDocuments[0]);
    const pendingSearch = index.search({ query: 'rollback', mode: 'semantic' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await index.remove('operations', 'rollback');
    release();
    const result = await pendingSearch;
    expect(result.passages).toEqual([]);
    expect(result.coverage.eligibleDocuments).toBe(0);
  } finally { release(); await index.close(); }
});

it('rejects an unpinned local model and keeps keyword search available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symbi-model-check-'));
  dirs.push(root);
  const modelRoot = join(root, 'models');
  const modelDir = join(modelRoot, 'Xenova', 'all-MiniLM-L6-v2');
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, 'model_int8.onnx'), 'wrong model bytes');
  const index = await createSymbiIndex({ dataDir: join(root, 'index'), modelRoot });
  try {
    const update = await index.upsert(symbiFixtureDocuments[0]);
    expect(update.status).toBe('degraded');
    expect(update.reason).toContain('checksum mismatch');
    const search = await index.search({ query: 'rollback', mode: 'keyword' });
    expect(search.passages[0]?.blockId).toBe('rollback');
    expect(search.coverage.status).toBe('degraded');
  } finally { await index.close(); }
});

it('reports logical storage work and performs no writes for an unchanged source', async () => {
  const { index } = await fixture({ trackStorage: true });
  try {
    const before = index.storageStats()!;
    await index.upsert(symbiFixtureDocuments[0]);
    const cold = index.storageStats()!;
    expect(cold.writeOperations).toBeGreaterThan(before.writeOperations);
    expect(cold.bytesBoundForWrites).toBeGreaterThan(0);
    await index.upsert(symbiFixtureDocuments[0]);
    const warm = index.storageStats()!;
    expect(warm.writeOperations).toBe(cold.writeOperations);
    await index.search({ query: 'rollback' });
    expect(index.storageStats()!.readOperations).toBeGreaterThan(warm.readOperations);
  } finally { await index.close(); }
});

it('treats explicit empty authorization scopes as empty and rejects malformed pagination cursors', async () => {
  const { index } = await fixture();
  try {
    await index.upsert({ ...symbiFixtureDocuments[0], content: 'Rollback procedure. '.repeat(180),
      contentHash: 'cursor-fixture' });
    const denied = await index.search({ query: 'rollback', principal: 'scoped', allowedCanvasIds: [] });
    expect(denied.passages).toEqual([]);
    expect(denied.coverage.eligibleDocuments).toBe(0);
    const missingDocument = await index.search({ query: 'rollback', documentIds: [],
      allowedDocumentIds: [], canvasId: 'operations' });
    expect(missingDocument.passages).toEqual([]);
    const first = await index.search({ query: 'rollback', mode: 'keyword', limit: 1 });
    expect(first.nextCursor).toBeDefined();
    await expect(index.search({ query: 'rollback', mode: 'keyword', cursor: 'not-json' })).rejects.toThrow('invalid');
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const negative = Buffer.from(JSON.stringify({ ...decoded, offset: -1 })).toString('base64url');
    await expect(index.search({ query: 'rollback', mode: 'keyword', cursor: negative })).rejects.toThrow('invalid');
  } finally { await index.close(); }
});

it('ignores malformed rebuildable metadata while keeping keyword evidence available', async () => {
  const { index, embedder, dataDir } = await fixture();
  await index.upsert(symbiFixtureDocuments[0]);
  await index.close();
  const moduleName = 'better-sqlite3';
  const { default: Database } = await import(moduleName) as { default: new (file: string) => {
    prepare(sql: string): { run(...values: string[]): void }; close(): void } };
  const database = new Database(join(dataDir, 'symbi-index.sqlite'));
  database.prepare('UPDATE index_documents SET tags=?,links=? WHERE block_id=?')
    .run('{bad-json', JSON.stringify(['valid-link', 42]), 'rollback');
  database.close();
  const reopened = await createSymbiIndex({ dataDir, embedder });
  try {
    const result = await reopened.search({ query: 'rollback', mode: 'keyword' });
    expect(result.passages[0]).toMatchObject({ blockId: 'rollback' });
    expect(result.coverage.status).toBe('ready');
  } finally { await reopened.close(); }
});

it('updates full-text search when only a document title changes', async () => {
  const { index, dataDir } = await fixture();
  try {
    const original = { ...symbiFixtureDocuments[0], title: 'Old heading' };
    await index.upsert(original);
    const renamed = { ...original, title: 'Emergency checkpoint' };
    await index.upsert(renamed);
    const result = await index.search({ query: 'emergency checkpoint', mode: 'keyword' });
    expect(result.passages[0]?.blockId).toBe(original.blockId);
    const moduleName = 'better-sqlite3';
    const { default: Database } = await import(moduleName) as { default: new (file: string) => {
      prepare(sql: string): { get(): { title: string } }; close(): void } };
    const database = new Database(join(dataDir, 'symbi-index.sqlite'));
    try { expect(database.prepare('SELECT title FROM passage_fts LIMIT 1').get().title).toBe('Emergency checkpoint'); }
    finally { database.close(); }
  } finally { await index.close(); }
});

it('does not fill hybrid results from weak semantic similarity and one incidental keyword', async () => {
  const unrelated = ['restaurant status for tax filing', 'Olympic task medals',
    'bike board retailers', 'sourdough update recipe'];
  const { index } = await fixture({ embedder: {
    modelVersion: 'confidence-fixture',
    embed: async (texts) => texts.map((text) => {
      if (unrelated.includes(text)) return [0.25, Math.sqrt(1 - 0.25 ** 2)];
      if (text === 'task status columns') return [0, 1];
      return [1, 0];
    }),
  } });
  try {
    await index.upsert({ ...symbiFixtureDocuments[0], blockId: 'task-board', title: 'Task board',
      content: 'Task status columns and board updates move cards across lanes.', contentHash: 'confidence-document' });
    for (const query of unrelated) {
      const result = await index.search({ query, mode: 'hybrid' });
      expect(result.passages, query).toEqual([]);
    }
    const semantic = await index.search({ query: 'Move cards across lanes', mode: 'semantic' });
    expect(semantic.passages[0]?.blockId).toBe('task-board');
    const lexical = await index.search({ query: 'task status columns', mode: 'hybrid' });
    expect(lexical.passages[0]?.blockId).toBe('task-board');
    const explicitKeyword = await index.search({ query: unrelated[0], mode: 'keyword' });
    expect(explicitKeyword.passages[0]?.blockId).toBe('task-board');
  } finally { await index.close(); }
});

it('reconciles the same source concurrently across two index instances', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'symbi-index-concurrent-'));
  dirs.push(dataDir);
  let entered = 0;
  let release!: () => void;
  let bothEntered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const inEmbedding = new Promise<void>((resolve) => { bothEntered = resolve; });
  const makeEmbedder = (): SymbiEmbedder => ({ modelVersion: 'two-instance-fixture',
    embed: async (texts) => {
      entered += 1;
      if (entered === 2) bothEntered();
      await gate;
      return texts.map(() => [1, 0]);
    } });
  const first = await createSymbiIndex({ dataDir, embedder: makeEmbedder() });
  const second = await createSymbiIndex({ dataDir, embedder: makeEmbedder() });
  try {
    const doc = symbiFixtureDocuments[0];
    const writes = [first.upsert(doc), second.upsert(doc)];
    await inEmbedding;
    release();
    const results = await Promise.all(writes);
    expect(results.map((result) => result.status)).toEqual(['ready', 'ready']);
    const search = await second.search({ query: 'rollback', mode: 'keyword' });
    expect(search.passages[0]?.blockId).toBe(doc.blockId);
    expect((await first.search({ query: 'rollback', mode: 'keyword' })).passages[0]?.blockId).toBe(doc.blockId);
    const moduleName = 'better-sqlite3';
    const { default: Database } = await import(moduleName) as { default: new (file: string) => {
      prepare(sql: string): { get(): { count: number } }; close(): void } };
    const database = new Database(join(dataDir, 'symbi-index.sqlite'));
    try {
      const count = database.prepare('SELECT count(*) AS count FROM index_passages').get().count;
      expect(count).toBe(chunkDocument(doc.content).length);
      expect(database.prepare('SELECT count(*) AS count FROM passage_fts').get().count).toBe(count);
    } finally { database.close(); }
    await second.remove(doc.canvasId, doc.blockId);
    expect((await first.search({ query: 'rollback', mode: 'keyword' })).passages).toEqual([]);
  } finally { release(); await Promise.all([first.close(), second.close()]); }
});

it('repairs a corrupt rebuildable vector during restart reconciliation without source changes', async () => {
  const { index, embedder, dataDir } = await fixture();
  const doc = symbiFixtureDocuments[0];
  await index.upsert(doc);
  await index.close();
  const moduleName = 'better-sqlite3';
  const { default: Database } = await import(moduleName) as { default: new (file: string) => {
    prepare(sql: string): { run(...values: unknown[]): void; get(...values: unknown[]): { bytes: number } }; close(): void } };
  const database = new Database(join(dataDir, 'symbi-index.sqlite'));
  database.prepare('UPDATE index_passages SET vector=? WHERE block_id=?').run(Buffer.from([1, 2, 3]), doc.blockId);
  database.close();
  const reopened = await createSymbiIndex({ dataDir, embedder });
  try {
    const beforeCalls = embedder.calls;
    await reopened.rebuild([doc]);
    expect(embedder.calls).toBeGreaterThan(beforeCalls);
    const reader = new Database(join(dataDir, 'symbi-index.sqlite'));
    try {
      const bytes = reader.prepare('SELECT length(vector) AS bytes FROM index_passages WHERE block_id=?')
        .get(doc.blockId).bytes;
      expect(bytes).toBeGreaterThan(3);
      expect(bytes % 4).toBe(0);
    } finally { reader.close(); }
    expect((await reopened.search({ query: 'rollback', mode: 'semantic' })).passages[0]?.blockId).toBe(doc.blockId);
    expect((await reopened.upsert(doc)).storageWrites).toBe(0);
    const nullWriter = new Database(join(dataDir, 'symbi-index.sqlite'));
    nullWriter.prepare('UPDATE index_passages SET vector=NULL WHERE block_id=?').run(doc.blockId);
    nullWriter.close();
    expect((await reopened.search({ query: 'rollback', mode: 'semantic' })).passages[0]?.blockId).toBe(doc.blockId);
    const callsBeforeNullRepair = embedder.calls;
    await reopened.rebuild([doc]);
    expect(embedder.calls).toBeGreaterThan(callsBeforeNullRepair);
  } finally { await reopened.close(); }
});

it('reembeds a stable source when the pinned model version changes without replacing its passage identity', async () => {
  const { index, dataDir } = await fixture();
  const doc = symbiFixtureDocuments[0];
  await index.upsert(doc);
  await index.close();
  const moduleName = 'better-sqlite3';
  const { default: Database } = await import(moduleName) as { default: new (file: string) => {
    prepare(sql: string): { get(...values: unknown[]): { rowid: number; model_version: string } }; close(): void } };
  const beforeDb = new Database(join(dataDir, 'symbi-index.sqlite'));
  const before = beforeDb.prepare('SELECT rowid,model_version FROM index_passages WHERE block_id=?').get(doc.blockId);
  beforeDb.close();
  let modelCalls = 0;
  const nextModel = { modelVersion: 'fixture-vector-v2', embed: async (texts: string[]) => {
    modelCalls += texts.length;
    return texts.map(() => [0, 1, 0]);
  } };
  const reopened = await createSymbiIndex({ dataDir, embedder: nextModel });
  try {
    await reopened.rebuild([doc]);
    const afterDb = new Database(join(dataDir, 'symbi-index.sqlite'));
    try {
      const after = afterDb.prepare('SELECT rowid,model_version FROM index_passages WHERE block_id=?').get(doc.blockId);
      expect(after.rowid).toBe(before.rowid);
      expect(after.model_version).toBe(nextModel.modelVersion);
      expect(after.model_version).not.toBe(before.model_version);
    } finally { afterDb.close(); }
    expect((await reopened.upsert(doc)).storageWrites).toBe(0);
    const afterChange = modelCalls;
    await reopened.rebuild([doc]);
    expect(modelCalls).toBe(afterChange);
  } finally { await reopened.close(); }
});

it('treats a legacy document without a metadata revision as stable across upsert and restart', async () => {
  const { index, embedder, dataDir } = await fixture();
  const doc = { ...symbiFixtureDocuments[0], blockId: 'legacy-no-revision', metadataRevision: undefined };
  await index.upsert(doc);
  expect((await index.upsert(doc)).storageWrites).toBe(0);
  await index.close();
  const reopened = await createSymbiIndex({ dataDir, embedder, trackStorage: true });
  try {
    const before = reopened.storageStats()!;
    await reopened.rebuild([doc]);
    const after = reopened.storageStats()!;
    expect(after.writeOperations).toBe(before.writeOperations);
    expect((await reopened.search({ query: 'rollback', mode: 'keyword' })).passages[0]?.blockId).toBe(doc.blockId);
  } finally { await reopened.close(); }
});

it('bounds search cache memory and remains usable after idempotent close', async () => {
  let queryEmbeddings = 0;
  const { index } = await fixture({ cacheBytes: 1, embedder: {
    modelVersion: 'bounded-cache-fixture',
    embed: async (texts) => {
      if (texts.length === 1 && texts[0] === 'rollback') queryEmbeddings += 1;
      return texts.map(() => [1, 0]);
    },
  } });
  await index.upsert(symbiFixtureDocuments[0]);
  await index.search({ query: 'rollback', mode: 'semantic' });
  await index.search({ query: 'rollback', mode: 'semantic' });
  expect(queryEmbeddings).toBe(2);
  await index.close();
  await index.close();
  await expect(index.search({ query: 'rollback' })).rejects.toThrow('closed');
  await expect(index.upsert(symbiFixtureDocuments[0])).rejects.toThrow('closed');
});

it('evicts the oldest cached query while keeping a recent query reusable', async () => {
  const calls: string[] = [];
  const { index } = await fixture({ cacheBytes: 400, embedder: {
    modelVersion: 'cache-eviction-fixture',
    embed: async (texts) => {
      calls.push(...texts);
      return texts.map(() => [1, 0]);
    },
  } });
  try {
    await index.upsert(symbiFixtureDocuments[0]);
    await index.search({ query: 'rollback', mode: 'semantic' });
    await index.search({ query: 'rollback', mode: 'semantic' });
    expect(calls.filter((text) => text === 'rollback')).toHaveLength(1);
    await index.search({ query: 'restore', mode: 'semantic' });
    await index.search({ query: 'restore', mode: 'semantic' });
    expect(calls.filter((text) => text === 'restore')).toHaveLength(1);
    await index.search({ query: 'rollback', mode: 'semantic' });
    expect(calls.filter((text) => text === 'rollback')).toHaveLength(2);
  } finally { await index.close(); }
});

it('fails a repeatedly superseded search after bounded retries while preserving its source', async () => {
  const scope: { index?: Awaited<ReturnType<typeof createSymbiIndex>> } = {};
  let queryCalls = 0;
  const opened = await fixture({ embedder: {
    modelVersion: 'retry-bound-fixture',
    embed: async (texts) => {
      if (texts[0] === 'retry-loop') {
        queryCalls += 1;
        scope.index!.markPending({ canvasId: 'other', blockId: `concurrent-${queryCalls}`,
          contentHash: `revision-${queryCalls}`, title: 'Unrelated concurrent document' });
      }
      return texts.map(() => [1, 0]);
    },
  } });
  const index = opened.index;
  scope.index = index;
  try {
    await index.upsert(symbiFixtureDocuments[0]);
    await expect(index.search({ query: 'retry-loop', mode: 'semantic', allowedCanvasIds: ['operations'] }))
      .rejects.toThrow('Index changed during search');
    expect(queryCalls).toBe(3);
    expect((await index.search({ query: 'rollback', mode: 'keyword' })).passages[0]?.blockId).toBe('rollback');
  } finally { await index.close(); }
});

it('rejects a pagination cursor when an unrelated edit lands during its uncached query', async () => {
  const scope: { index?: Awaited<ReturnType<typeof createSymbiIndex>> } = {};
  let queryCalls = 0;
  const opened = await fixture({ cacheBytes: 1, embedder: {
    modelVersion: 'cursor-race-fixture',
    embed: async (texts) => {
      if (texts[0] === 'rollback') {
        queryCalls += 1;
        if (queryCalls === 2) scope.index!.markPending({ canvasId: 'other', blockId: 'edited',
          contentHash: 'edited-v2', title: 'Unrelated edit' });
      }
      return texts.map(() => [1, 0]);
    },
  } });
  const index = opened.index;
  scope.index = index;
  try {
    await index.upsert({ ...symbiFixtureDocuments[0], content: 'Rollback recovery steps. '.repeat(70),
      contentHash: 'cursor-race-source' });
    const first = await index.search({ query: 'rollback', mode: 'semantic', limit: 1 });
    expect(first.nextCursor).toBeDefined();
    await expect(index.search({ query: 'rollback', mode: 'semantic', limit: 1, cursor: first.nextCursor }))
      .rejects.toThrow('stale');
    expect(queryCalls).toBe(2);
  } finally { await index.close(); }
});
