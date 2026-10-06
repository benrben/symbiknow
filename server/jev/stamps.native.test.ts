import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from '../storage.js';
import { sourceSnapshot } from './stamps.js';
let root: string; let store: CanvasStore; let workspaceId: string; let canvasId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-ownership-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Ownership' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('persists managed edge ownership and retains later manual removals across reload', async () => {
  const from = await store.createBlock(canvasId, { title: 'Specification', content: '# Specification' });
  const target = await store.createBlock(canvasId, { title: 'Implementation', content: '# Implementation' });
  const otherCanvas = (await store.createCanvas(workspaceId, { name: 'Other sources' })).id;
  const cross = await store.createBlock(otherCanvas, { title: 'Shared contract', content: '# Contract' });
  const manualCross = await store.createBlock(otherCanvas, { title: 'Reviewer context', content: '# Reviewer context' });
  const mutation = { kind: 'document' as const, canvasId, blockId: from.id, patch: { links: [target.id], crossLinks: [{ canvasId: otherCanvas, blockId: cross.id }], tags: ['review'] } };
  const result = await store.jevExecutor.execute(mutation, [sourceSnapshot(workspaceId, canvasId, from)], 'managed-links', 'Symbi Reflex', true,
    async preparation => { await writeFile(path.join(root, 'checked-preparation.json'), JSON.stringify(preparation)); });
  let saved = await new CanvasStore(root).getCanvasBlock(canvasId, from.id);
  expect(saved.jevOwnership?.managed).toEqual(expect.arrayContaining([`link:${canvasId}:${target.id}`, `link:${otherCanvas}:${cross.id}`]));
  expect(result.sourcesAfter[0].sourceGeneration).toBe(from.sourceGeneration);
  await store.jevExecutor.execute(mutation, [sourceSnapshot(workspaceId, canvasId, saved)], 'repeat-links', 'Symbi Reflex', true,
    async preparation => { await writeFile(path.join(root, 'repeat-preparation.json'), JSON.stringify(preparation)); });
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, from.id)).jevOwnership?.managed).toEqual(saved.jevOwnership?.managed);
  await store.updateBlock(canvasId, from.id, { crossLinks: [{ canvasId: otherCanvas, blockId: cross.id }, { canvasId: otherCanvas, blockId: manualCross.id }] });
  await store.updateBlock(canvasId, from.id, { links: [], crossLinks: [], tags: [] });
  saved = await new CanvasStore(root).getCanvasBlock(canvasId, from.id);
  expect(saved.jevOwnership?.removedLinks).toEqual([target.id, `${otherCanvas}:${cross.id}`, `${otherCanvas}:${manualCross.id}`]);
  expect(saved.jevOwnership?.removedLabels).toEqual(['review']);
  expect(saved.jevOwnership?.pins).toEqual(expect.arrayContaining(['links', 'crossLinks', 'tags']));
  expect(saved.jevMutationId).toBeUndefined();
  expect(saved.content).toBe(from.content);
});

it('preserves the mutation marker on an unchanged save and supports checked restoration of absent label metadata', async () => {
  const from = await store.createBlock(canvasId, { title: 'Source', content: '# Source' });
  await store.jevExecutor.execute({ kind: 'document', canvasId, blockId: from.id, patch: { tags: ['review'] } },
    [sourceSnapshot(workspaceId, canvasId, from)], 'labels', 'Symbi Reflex', true,
    async preparation => { await writeFile(path.join(root, 'label-preparation.json'), JSON.stringify(preparation)); });
  const saved = await store.getCanvasBlock(canvasId, from.id);
  await store.updateBlock(canvasId, from.id, {});
  expect((await store.getCanvasBlock(canvasId, from.id)).jevMutationId).toBe('labels');
  await store.jevExecutor.execute({ kind: 'document', canvasId, blockId: from.id, patch: { tags: null } },
    [sourceSnapshot(workspaceId, canvasId, saved)], 'restore-labels', 'Reviewer', false,
    async preparation => { await writeFile(path.join(root, 'inverse-preparation.json'), JSON.stringify(preparation)); });
  const restored = await store.getCanvasBlock(canvasId, from.id);
  expect(restored.tags).toBeUndefined();
  expect(restored.jevOwnership?.removedLabels).toEqual(['review']);
  expect(restored.content).toBe(from.content);
  expect(() => sourceSnapshot(workspaceId, canvasId, { ...restored, incarnation: undefined })).toThrowError(expect.objectContaining({ status: 409 }));
});
