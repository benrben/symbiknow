import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import type { JevCanonicalPreparation } from './storage-jev-executor.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'task-audit-integration-')); roots.push(root);
  const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  const workspace = await store.createWorkspace({ name: 'Audit integration' });
  const source = await store.createCanvas(workspace.id, { name: 'Source' });
  return { root, store, source };
}

it('records both sides of a document move and refuses task Undo that would restore a foreign document reference', async () => {
  const { root, store, source } = await fixture();
  const target = await store.createCanvas(source.workspaceId, { name: 'Target' });
  const block = await store.createBlock(source.id, { title: 'Reference', content: '# Reference' });
  const task = await store.createTask(source.id, { title: 'Move linked work', blockIds: [block.id] }, 'Creator');
  await store.moveBlockToCanvas(source.id, block.id, target.id, 'Mover');
  const origin = (await store.listTaskHistory(source.id, task.id)).items;
  expect(origin.map(event => event.kind)).toEqual(['updated', 'created']);
  expect(origin[0]).toMatchObject({ actor: 'Mover', before: { blockIds: [block.id] }, after: { blockIds: [] } });
  const copy = (await store.listTasks(target.id)).find(item => item.blockIds.includes(block.id));
  expect(copy).toBeDefined();
  expect((await store.listTaskHistory(target.id, copy!.id)).items[0]).toMatchObject({ kind: 'created', actor: 'Mover' });
  const restarted = new CanvasStore(root); await restarted.init();
  expect((await restarted.listTaskHistory(source.id, task.id)).items).toEqual(origin);
  await expect(restarted.undoTask(source.id, task.id, origin[0].eventId!, origin[0].after!.revision!, 'Reviewer'))
    .rejects.toMatchObject({ status: 409 });
  expect((await restarted.listTasks(source.id)).find(item => item.id === task.id)?.blockIds).toEqual([]);
});

it('records merge task reference changes and their durable inverse on merge Undo', async () => {
  const { root, store, source } = await fixture();
  const keeper = await store.createBlock(source.id, { title: 'Keeper', content: '# Keeper' });
  const merged = await store.createBlock(source.id, { title: 'Merged', content: '# Merged' });
  const task = await store.createTask(source.id, { title: 'Review merged source', blockIds: [merged.id] }, 'Creator');
  const operation = await store.mergeDocuments(source.id, { keepBlockId: keeper.id, mergeBlockIds: [merged.id],
    content: '# Combined', expectedContentHashes: { [keeper.id]: keeper.contentHash, [merged.id]: merged.contentHash } }, 'Merger');
  expect((await store.listTasks(source.id)).find(item => item.id === task.id)?.blockIds).toEqual([keeper.id]);
  expect((await store.listTaskHistory(source.id, task.id)).items[0]).toMatchObject({ kind: 'updated', actor: 'Merger',
    before: { blockIds: [merged.id] }, after: { blockIds: [keeper.id] } });
  await store.undoMerge(operation.mergeId, 'Reviewer');
  expect((await new CanvasStore(root).listTasks(source.id)).find(item => item.id === task.id)?.blockIds).toEqual([merged.id]);
  expect((await new CanvasStore(root).listTaskHistory(source.id, task.id)).items[0]).toMatchObject({ kind: 'updated', actor: 'Reviewer',
    before: { blockIds: [keeper.id] }, after: { blockIds: [merged.id] } });
});

it('records reviewed Jev task artifacts once across canonical recovery replay', async () => {
  const { root, store, source } = await fixture();
  const result = await store.jevExecutor.execute({ kind: 'task_create', canvasId: source.id,
    task: { title: 'Reviewed task', detail: 'Exact source-grounded work' } }, [], 'reviewed-task-op', 'Reviewer', false,
  async () => undefined);
  const task = (await store.listTasks(source.id))[0];
  const first = (await store.listTaskHistory(source.id, task.id)).items;
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ kind: 'created', actor: 'Reviewer', after: { id: task.id } });
  await store.jevExecutor.recover(result.artifacts);
  expect((await new CanvasStore(root).listTaskHistory(source.id, task.id)).items).toEqual(first);
});

it('retains the original reviewer in a task audit event completed by Jev recovery', async () => {
  const { store, source } = await fixture();
  let prepared: JevCanonicalPreparation | undefined;
  await expect(store.jevExecutor.execute({ kind: 'task_create', canvasId: source.id,
    task: { title: 'Interrupted task', detail: 'Recovered checked work' } }, [], 'interrupted-task-op', 'Original reviewer', false,
  async plan => { prepared = plan; throw new Error('Fixture interruption before artifact write'); }))
    .rejects.toThrow('Fixture interruption');
  expect(await store.listTasks(source.id)).toEqual([]);
  expect(prepared).toBeDefined();
  await store.jevExecutor.recover(prepared!.artifacts);
  const task = (await store.listTasks(source.id))[0];
  expect((await store.listTaskHistory(source.id, task.id)).items[0]).toMatchObject({ kind: 'created', actor: 'Original reviewer' });
});
