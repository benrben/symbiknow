import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';

let root: string;
let store: CanvasStore;
let canvasId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-field-contract-'));
  store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Field contracts' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Release' })).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('normalizes and clears saved freshness without changing source bytes or generation', async () => {
  const source = await store.createBlock(canvasId, { title: 'Review schedule', content: '# Review schedule\nReview before release.' });
  await store.updateBlock(canvasId, source.id, { freshness: { reviewAt: '2026-10-03', expiresAt: '2026-10-05T12:00:00+03:00' } });
  const saved = await new CanvasStore(root).getCanvasBlock(canvasId, source.id);
  expect(saved.freshness).toEqual({ reviewAt: '2026-10-03T00:00:00.000Z', expiresAt: '2026-10-05T09:00:00.000Z' });
  await store.updateBlock(canvasId, source.id, { headline: 'Review before release.' });
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).freshness).toEqual(saved.freshness);
  await store.updateBlock(canvasId, source.id, { freshness: {} });
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).freshness).toEqual({});
  await store.updateBlock(canvasId, source.id, { freshness: null });
  const cleared = await new CanvasStore(root).getCanvasBlock(canvasId, source.id);
  expect(cleared.freshness).toBeUndefined();
  expect(cleared.content).toBe(source.content); expect(cleared.sourceGeneration).toBe(source.sourceGeneration);
});

it('rejects malformed freshness before any canonical change', async () => {
  const source = await store.createBlock(canvasId, { title: 'Source', content: '# Source' });
  const before = await new CanvasStore(root).getCanvasBlock(canvasId, source.id);
  for (const freshness of [false, 0, 'tomorrow', [], { reviewAt: null }, { expiresAt: 2 }, { effectiveAt: 'not-a-date' }]) {
    await expect(store.updateBlock(canvasId, source.id, { freshness })).rejects.toMatchObject({ status: 400 });
    expect(await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).toEqual(before);
  }
});

it('persists planning fields, preserves omitted values, and explicitly clears them', async () => {
  let task = await store.createTask(canvasId, { title: 'Ship the release', priority: 'high', reviewer: 'reviewer',
    acceptanceCriteria: [{ id: 'release-checked', text: '  Release has been checked.  ' }] }, 'Owner');
  expect((await new CanvasStore(root).listTasks(canvasId))[0]).toMatchObject({ priority: 'high', reviewer: 'reviewer',
    acceptanceCriteria: [{ id: 'release-checked', text: 'Release has been checked.' }] });
  task = await store.updateTask(canvasId, task.id, { title: 'Ship the checked release' }, 'Owner');
  expect(task).toMatchObject({ priority: 'high', reviewer: 'reviewer', acceptanceCriteria: [{ id: 'release-checked', text: 'Release has been checked.' }] });
  task = await store.updateTask(canvasId, task.id, { priority: null, reviewer: null, acceptanceCriteria: null }, 'Owner');
  expect(task.priority).toBeUndefined(); expect(task.reviewer).toBeUndefined(); expect(task.acceptanceCriteria).toBeUndefined();
  task = await store.updateTask(canvasId, task.id, { reviewer: '', acceptanceCriteria: [] }, 'Owner');
  expect(task.reviewer).toBeUndefined(); expect(task.acceptanceCriteria).toEqual([]);
  const fifty = Array.from({ length: 50 }, (_, index) => ({ id: `criterion-${index}`, text: `Check ${index}` }));
  task = await store.updateTask(canvasId, task.id, { acceptanceCriteria: fifty }, 'Owner');
  expect((await new CanvasStore(root).listTasks(canvasId))[0]).toEqual(task);
  expect(task.acceptanceCriteria).toEqual(fifty);
});

it('rejects invalid planning fields and criteria without changing the saved task', async () => {
  const task = await store.createTask(canvasId, { title: 'Reviewed work' }, 'Owner');
  const invalid = [
    { priority: 'critical' }, { reviewer: 8 }, { reviewer: 'x'.repeat(121) },
    { acceptanceCriteria: {} }, { acceptanceCriteria: Array.from({ length: 51 }, (_, index) => ({ id: `c-${index}`, text: 'Check' })) },
    ...[null, 'invalid', { id: 1, text: 'Check' }, { id: '', text: 'Check' }, { id: 'c', text: 1 },
      { id: 'c', text: ' ' }, { id: 'c', text: 'x'.repeat(2001) }].map(entry => ({ acceptanceCriteria: [entry] })),
    { acceptanceCriteria: [{ id: 'same', text: 'First' }, { id: 'same', text: 'Second' }] },
  ];
  for (const patch of invalid) {
    await expect(store.updateTask(canvasId, task.id, patch, 'Owner')).rejects.toMatchObject({ status: 400 });
    expect(await new CanvasStore(root).listTasks(canvasId)).toEqual([task]);
  }
});
