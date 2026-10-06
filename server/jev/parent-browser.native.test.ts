import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { undoBrowserParent } from './parent-browser.js';
import type { JevParentUndo } from './parent-undo.js';

const owner: JevPrincipal = { id: 'browser-owner', kind: 'user', access: 'write', canApprove: true };
let root: string; let store: CanvasStore; let workspaceId: string; let canvasId: string; let block: CanvasBlock;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-browser-parent-'));
  store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Parent review' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Browser sources' })).id;
  block = await store.createBlock(canvasId, { title: 'Release source', content: '# Exact release source' });
  block = await store.getCanvasBlock(canvasId, block.id);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const read = () => new CanvasStore(root).getCanvasBlock(canvasId, block.id);

it.each([null, {}, { kind: 'other' }, { kind: 'created', after: { id: 'bad' } }, { kind: 'edited', after: { id: 'bad', incarnation: 'stamp' }, before: { id: 'different' } }])
('rejects malformed browser parents before any native mutation: %j', async input => {
  await expect(undoBrowserParent(store, workspaceId, canvasId, input as JevParentUndo, owner)).rejects.toMatchObject({ status: 400 });
  expect(await read()).toEqual(block);
});
it('accepts an unchanged legacy created snapshot without a hash and derives it only from exact saved bytes', async () => {
  const legacy = { ...block }; delete legacy.contentHash;
  expect(await undoBrowserParent(store, workspaceId, canvasId, { kind: 'created', after: legacy }, owner)).toBeNull();
  expect((await store.getCanvas(canvasId, true)).blocks).toEqual([]);
});
it('rejects a hashless created snapshot with changed bytes or a missing saved document', async () => {
  const legacy = { ...block, content: '# Different source' }; delete legacy.contentHash;
  await expect(undoBrowserParent(store, workspaceId, canvasId, { kind: 'created', after: legacy }, owner)).rejects.toMatchObject({ status: 409 });
  expect(await read()).toEqual(block);
  await store.deleteBlock(canvasId, block.id, 'Browser');
  await expect(undoBrowserParent(store, workspaceId, canvasId, { kind: 'created', after: legacy }, owner)).rejects.toMatchObject({ status: 409 });
});
it('restores edited source bytes and historical absent metadata defaults through a checked native write', async () => {
  const before = block;
  const after = await store.updateBlock(canvasId, block.id, { content: '# Revised source', headline: 'Revised', tags: ['generated'] }, 'Symbi');
  const restored = await undoBrowserParent(store, workspaceId, canvasId, { kind: 'edited', before, after }, owner);
  expect(restored).toMatchObject({ content: before.content, archived: false, stale: false, tags: [] });
  expect(restored?.crossLinks ?? []).toEqual([]);
  expect(restored?.headline).toBeUndefined();
  expect(restored?.sourceGeneration).toBeGreaterThan(after.sourceGeneration!);
  expect((await read()).content).toBe(before.content);
});
it('requires a complete edited after snapshot and holds quality-changing edits for document history', async () => {
  const after = await store.updateBlock(canvasId, block.id, { content: '# Revised source' }, 'Symbi');
  const saved = await read();
  const missingHash = { ...after }; delete missingHash.contentHash;
  await expect(undoBrowserParent(store, workspaceId, canvasId, { kind: 'edited', before: block, after: missingHash }, owner)).rejects.toMatchObject({ status: 409 });
  const changedQuality = { ...after, quality: { score: 2, at: new Date().toISOString() } };
  await expect(undoBrowserParent(store, workspaceId, canvasId, { kind: 'edited', before: block, after: changedQuality }, owner)).rejects.toMatchObject({ status: 409 });
  expect(await read()).toEqual(saved);
});
it('preserves a later human edit instead of overwriting it with browser Undo', async () => {
  const after = await store.updateBlock(canvasId, block.id, { content: '# Revised source' }, 'Symbi');
  const human = await store.updateBlock(canvasId, block.id, { content: '# Human correction' }, 'Browser');
  const saved = await read();
  await expect(undoBrowserParent(store, workspaceId, canvasId, { kind: 'edited', before: block, after }, owner)).rejects.toMatchObject({ status: 409 });
  expect(await read()).toEqual(saved); expect((await read()).content).toBe(human.content);
});
