import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { jevChatTools } from './jev-chat-tools.js';
import { CanvasStore } from './storage.js';
import { SymbiIndexLifecycle } from './symbi-index-lifecycle.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-chat-tool-boundary-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const workspace = (await store.listWorkspaces())[0];
  const canvas = await store.createCanvas(workspace.id, { name: 'Scoped sources' });
  const target = await store.createBlock(canvas.id, { title: 'Ledger target', content: '# Ledger target\nRelevant ledger evidence',
    group: 'custom:finance', tags: ['ledger'] });
  const stale = await store.createBlock(canvas.id, { title: 'Stale target', content: '# Stale target\nOld evidence' });
  const wrongExcerpt = await store.createBlock(canvas.id, { title: 'Wrong excerpt', content: '# Wrong excerpt\nOther evidence' });
  const source = await store.createBlock(canvas.id, { title: 'Ledger source', content: '# Ledger source\nQuestion',
    group: 'custom:finance', tags: ['ledger'], purpose: 'ledger review', links: [target.id] });
  const inbound = await store.createBlock(canvas.id, { title: 'Inbound reference', content: '# Inbound reference', links: [source.id] });
  return { store, canvas, source, target, stale, wrongExcerpt, inbound };
}

async function invoke(store: CanvasStore, canvasId: string, name: string, input: Record<string, unknown>) {
  const selected = jevChatTools(store, canvasId).find(candidate => candidate.name === name)!;
  return JSON.parse(String(await selected.invoke(input))) as Record<string, unknown>;
}

it('searches ordinary scoped files when the index is unavailable and handles empty read requests', async () => {
  const f = await fixture();
  const found = await invoke(f.store, f.canvas.id, 'find_by', { query: 'Relevant ledger evidence' });
  expect(found).toHaveProperty(`${f.canvas.id}:${f.target.id}`);
  expect(found[`${f.canvas.id}:${f.target.id}`]).toMatchObject({ title: 'Ledger target', contentHash: '' });
  expect(await invoke(f.store, f.canvas.id, 'find_by', { query: '   ' })).toEqual({});
  expect(await invoke(f.store, f.canvas.id, 'related', {})).toEqual([]);
});

it('uses only current exact index passages and explains linked, group, topic, and source similarity', async () => {
  const f = await fixture();
  const passage = (block: typeof f.target, excerpt = block.content, contentHash = block.contentHash!) => ({
    canvasId: f.canvas.id, blockId: block.id, contentHash, startOffset: 0, endOffset: block.content.length, excerpt,
  });
  const search = vi.fn(async () => ({ version: 1 as const,
    passages: [passage(f.target), passage(f.stale, f.stale.content, 'obsolete-hash'), passage(f.wrongExcerpt, 'not the source')],
    coverage: { status: 'ready' as const, checkedDocuments: 5, eligibleDocuments: 5, pendingDocuments: 0 } }));
  const expectedDocumentIds = vi.fn(async () => [f.target.id, f.stale.id, f.wrongExcerpt.id, f.source.id, f.inbound.id]);
  vi.spyOn(SymbiIndexLifecycle, 'forStore').mockReturnValue({ search, expectedDocumentIds } as unknown as SymbiIndexLifecycle);

  const found = await invoke(f.store, f.canvas.id, 'find_by', { query: 'ledger' });
  expect(Object.keys(found)).toEqual([`${f.canvas.id}:${f.target.id}`]);
  expect(found[`${f.canvas.id}:${f.target.id}`]).toMatchObject({
    title: f.target.title, excerpt: f.target.content, contentHash: f.target.contentHash,
  });
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'ledger', mode: 'hybrid', canvasId: f.canvas.id,
    allowedCanvasIds: [f.canvas.id], allowedDocumentIds: await expectedDocumentIds(),
    expectedDocumentIds: await expectedDocumentIds(), limit: 40 }));

  const related = await invoke(f.store, f.canvas.id, 'related', { blockId: f.source.id }) as unknown as
    Array<{ blockId: string; reasons: string[] }>;
  expect(related).toEqual([
    expect.objectContaining({ blockId: f.target.id,
      reasons: ['linked', 'same group', 'same topic', 'source similarity'] }),
    expect.objectContaining({ blockId: f.inbound.id, reasons: ['linked'] }),
  ]);
  expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'Ledger source ledger review ledger' }));
  const inboundRelated = await invoke(f.store, f.canvas.id, 'related', { blockId: f.inbound.id }) as unknown as
    Array<{ blockId: string; reasons: string[] }>;
  expect(inboundRelated).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: f.source.id, reasons: ['linked'] })]));
  expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'Inbound reference' }));
});
