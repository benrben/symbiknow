import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasStore } from './storage.js';
import { SymbiIndexLifecycle } from './symbi-index-lifecycle.js';
import { ApiError } from './errors.js';
import type { JevStoreEvent } from './jev/events.js';
import type { JevEvaluationContext, JevInputDocument } from './jev/actions/context.js';
import type { SymbiRetrievalResult } from '../shared/symbi-contract.js';

const fixtures: Array<{ root: string; lifecycle: SymbiIndexLifecycle }> = [];
afterEach(async () => {
  for (const { root, lifecycle } of fixtures.splice(0)) {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-lifecycle-fixture-'));
  const store = new CanvasStore(root);
  await store.init();
  const workspaceId = (await store.listWorkspaces())[0].id;
  const canvas = await store.createCanvas(workspaceId, { name: 'Operations' });
  let saved!: (event: JevStoreEvent) => Promise<void>;
  const subscribe = store.onSaved.bind(store);
  store.onSaved = listener => { saved = listener; return subscribe(listener); };
  const lifecycle = await SymbiIndexLifecycle.open(store, path.join(root, 'missing-model'));
  fixtures.push({ root, lifecycle });
  const event = (kind: JevStoreEvent['kind'], blockIds: string[], canvasId = canvas.id): JevStoreEvent =>
    ({ workspaceId, canvasId, blockIds, kind, actor: 'fixture' });
  return { store, lifecycle, canvas, workspaceId, saved, event };
}

it('retries a source-save generation race after queued index reconciliation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-index-race-'));
  let lifecycle: SymbiIndexLifecycle | undefined;
  try {
    const store = new CanvasStore(root);
    await store.init();
    const canvas = await store.createCanvas((await store.listWorkspaces())[0].id, { name: 'Related docs' });
    const source = await store.createBlock(canvas.id, { title: 'Rollback', content: '# Rollback\nRestore previous release.' });
    lifecycle = await SymbiIndexLifecycle.open(store);
    await store.updateBlock(canvas.id, source.id, { content: '# Rollback\nRestore a previous release.' }, 'Human');
    const original = lifecycle.index.search.bind(lifecycle.index);
    let calls = 0;
    lifecycle.index.search = async (request, retry) => {
      calls++;
      if (calls === 1) throw new Error('Index changed during search; retry with current scope');
      return original(request, retry);
    };
    const expectedDocumentIds = await lifecycle.expectedDocumentIds([canvas.id], canvas.id);
    const result = await lifecycle.search({ query: 'previous release', mode: 'keyword', canvasId: canvas.id,
      allowedCanvasIds: [canvas.id], allowedDocumentIds: expectedDocumentIds, expectedDocumentIds });
    expect(calls).toBe(2);
    expect(result.version).toBe(1);
    expect(result.passages.every(passage => passage.canvasId === canvas.id)).toBe(true);
  } finally {
    if (lifecycle) await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not retry stale cursors, unrelated errors, or non-Error failures', async () => {
  const { lifecycle, canvas } = await fixture();
  const original = lifecycle.index.search.bind(lifecycle.index);
  const failure = vi.fn(async () => { throw new Error('Index changed during search'); });
  lifecycle.index.search = failure;
  const request = { query: 'release', mode: 'keyword' as const, canvasId: canvas.id };
  await expect(lifecycle.search({ ...request, cursor: 'old' })).rejects.toThrow('Index changed during search');
  expect(failure).toHaveBeenCalledTimes(1);
  lifecycle.index.search = vi.fn(async () => { throw new Error('Storage unavailable'); });
  await expect(lifecycle.search(request)).rejects.toThrow('Storage unavailable');
  lifecycle.index.search = vi.fn(async () => { throw 'non-Error failure'; });
  await expect(lifecycle.search(request)).rejects.toBe('non-Error failure');
  lifecycle.index.search = original;
});

it('reconciles missing files and reports other failures, then ignores callbacks after close', async () => {
  const { store, lifecycle, canvas, saved, event } = await fixture();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(saved(event('source', ['missing']))).resolves.toBeUndefined();
    const original = store.getCanvasBlock.bind(store);
    store.getCanvasBlock = async () => { throw new Error('Fixture disk fault'); };
    await expect(saved(event('metadata', ['broken']))).rejects.toThrow('Fixture disk fault');
    expect(errors).toHaveBeenCalledWith('Search index reconciliation failed:', expect.objectContaining({ message: 'Fixture disk fault' }));
    store.getCanvasBlock = original;
    await expect(saved(event('tasks', ['ignored']))).resolves.toBeUndefined();
    await expect(saved(event('move', []))).resolves.toBeUndefined();
    await expect(saved(event('delete', ['missing']))).resolves.toBeUndefined();
    expect(SymbiIndexLifecycle.forStore(store)).toBe(lifecycle);
    const markPending = vi.spyOn(lifecycle.index, 'markPending');
    await lifecycle.close();
    expect(SymbiIndexLifecycle.forStore(store)).toBeUndefined();
    await saved(event('source', ['late'], canvas.id));
    expect(markPending).not.toHaveBeenCalled();
  } finally { errors.mockRestore(); }
});

it('finds only expected IDs within authorized canvases before returning coverage', async () => {
  const { store, lifecycle, canvas, workspaceId } = await fixture();
  const second = await store.createCanvas(workspaceId, { name: 'Research' });
  const first = await store.createBlock(canvas.id, { title: 'Release', content: 'Release checklist.' });
  const privateBlock = await store.createBlock(second.id, { title: 'Private', content: 'Private notes.' });
  expect(await lifecycle.expectedDocumentIds([canvas.id])).toEqual([first.id]);
  expect(await lifecycle.expectedDocumentIds([canvas.id, second.id], undefined, [privateBlock.id])).toEqual([privateBlock.id]);
  expect(await lifecycle.expectedDocumentIds(undefined, second.id)).toEqual([privateBlock.id]);
  expect(await lifecycle.expectedDocumentIds([canvas.id], canvas.id, ['not-present'])).toEqual([]);
  await expect(lifecycle.expectedDocumentIds([canvas.id], second.id)).rejects.toMatchObject(
    { status: 404, message: 'Canvas not found' } satisfies Partial<ApiError>);
});

it('keeps Jev neighbors current, visible, and inside the source workspace', async () => {
  const { store, lifecycle, canvas, workspaceId } = await fixture();
  const sourceBlock = await store.createBlock(canvas.id, { title: 'Release', content: 'Release instructions.' });
  const neighborBlock = await store.createBlock(canvas.id, { title: 'Recovery', content: 'Recovery instructions.' });
  const staleBlock = await store.createBlock(canvas.id, { title: 'Old', content: 'Old recovery.' });
  const input = (block: typeof sourceBlock, hash = block.contentHash!, workspace = workspaceId): JevInputDocument => ({
    canvasId: canvas.id, block, snapshot: { workspaceId: workspace, canvasId: canvas.id, blockId: block.id,
      contentHash: hash, incarnation: 'fixture', sourceGeneration: 1, metadataRevision: 1 },
  });
  const source = input({ ...sourceBlock, tags: undefined });
  const neighbor = input(neighborBlock);
  const stale = input(staleBlock, 'current-hash');
  const context = { workspaceId, documents: [source, neighbor, stale,
    input({ ...neighborBlock, id: 'archived', archived: true }),
    input({ ...neighborBlock, id: 'excluded', processingExcluded: true }),
    input({ ...neighborBlock, id: 'foreign' }, undefined, 'other-workspace')],
  } as JevEvaluationContext;
  const passage = (document: JevInputDocument, hash = document.snapshot.contentHash) => ({
    canvasId: document.canvasId, blockId: document.block.id, contentHash: hash,
    startOffset: 0, endOffset: 8, excerpt: 'Recovery', score: 1,
  });
  const search = vi.spyOn(lifecycle.index, 'search').mockResolvedValue({ passages: [passage(source), passage(neighbor),
    passage(stale, 'stale-hash'), passage(input({ ...neighborBlock, id: 'archived' }))] } as SymbiRetrievalResult);
  expect((await lifecycle.neighbors(context, source)).map(item => item.blockId)).toEqual([neighborBlock.id]);
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ mode: 'hybrid', limit: 100,
    allowedCanvasIds: [canvas.id], allowedDocumentIds: [sourceBlock.id, neighborBlock.id, staleBlock.id],
    expectedDocumentIds: [sourceBlock.id, neighborBlock.id, staleBlock.id] }));
  expect(await lifecycle.neighbors(context, input({ ...sourceBlock, id: 'not-visible' }))).toEqual([]);
  expect(search).toHaveBeenCalledTimes(1);
});
