import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from '../storage.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';
import { pruneJevWorkspace, purgeJevOrphans } from './lifecycle.js';
import { groupLabels } from './group-labels.js';
import { sourceSnapshot } from './stamps.js';
let root: string; let store: CanvasStore; let workspaceId: string; let canvasId: string; let blockId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-lifecycle-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Keep sources' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Kept canvas' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Kept', content: '# Keep this source' })).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('removes orphan artifacts while preserving live drafts, unfamiliar filenames and canonical source data', async () => {
  const files = new JevWorkspaceFiles(root);
  const dir = path.join(root, 'jev');
  await mkdir(path.join(dir, 'workspaces', 'deleted-workspace'), { recursive: true });
  await mkdir(path.join(dir, 'workspaces', 'unknown name'), { recursive: true });
  await mkdir(path.join(dir, 'drafts', canvasId), { recursive: true });
  await mkdir(path.join(dir, 'drafts', 'deleted-canvas'), { recursive: true });
  await mkdir(path.join(dir, 'drafts', 'unknown name'), { recursive: true });
  const drafts = path.join(dir, 'drafts', canvasId);
  for (const name of [`${blockId}.json`, 'deleted-block.json', 'unknown name.json', 'notes.txt']) await writeFile(path.join(drafts, name), '{}');
  const journals = path.join(dir, 'parent-undo'); await mkdir(journals);
  const alive = path.join(journals, `${randomUUID()}.json`); const removed = path.join(journals, `${randomUUID()}.json`);
  await writeFile(alive, JSON.stringify({ workspaceId, canvasId }));
  await writeFile(removed, JSON.stringify({ workspaceId, canvasId: 'deleted-canvas' }));
  await writeFile(path.join(journals, 'unknown.json'), 'not JSON');
  await purgeJevOrphans(store, files);
  await expect(readFile(path.join(dir, 'workspaces', 'deleted-workspace', 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(drafts, 'deleted-block.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(removed)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const name of [`${blockId}.json`, 'unknown name.json', 'notes.txt']) expect(await readFile(path.join(drafts, name), 'utf8')).toBe('{}');
  expect(JSON.parse(await readFile(alive, 'utf8')).canvasId).toBe(canvasId);
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Keep this source');
});

it('does not treat an unreadable artifact directory as an empty successful cleanup', async () => {
  await mkdir(path.join(root, 'jev')); await writeFile(path.join(root, 'jev', 'workspaces'), 'unreadable directory');
  await expect(purgeJevOrphans(store, new JevWorkspaceFiles(root))).rejects.toMatchObject({ code: 'ENOTDIR' });
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Keep this source');
});

it('forgets removed profile sources while keeping current workspace summaries and unrelated document profiles', async () => {
  const removed = await store.createBlock(canvasId, { title: 'Remove', content: '# Removed source' });
  const missing = sourceSnapshot(workspaceId, canvasId, removed);
  const live = sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, blockId));
  const state = emptyJevWorkspace();
  state.profiles = { [`${canvasId}:${blockId}`]: { source: { ...live } }, [`${canvasId}:${removed.id}`]: { source: { ...missing } },
    'workspace:current': { scopedSources: [{ ...live }] }, 'workspace:removed-context': { scopedSources: [{ ...missing }] }, 'workspace:summary': { status: 'retained' } };
  await store.deleteBlock(canvasId, removed.id);
  expect(await pruneJevWorkspace(store, workspaceId, state)).toBe(true);
  expect(Object.keys(state.profiles).sort()).toEqual([`${canvasId}:${blockId}`, 'workspace:current', 'workspace:summary'].sort());
  expect(await pruneJevWorkspace(store, workspaceId, state)).toBe(false);
  expect(await pruneJevWorkspace(store, 'unknown-workspace', state)).toBe(false);
});

it('keeps native group membership readable when the optional display-label journal needs recovery', async () => {
  await store.updateBlock(canvasId, blockId, { group: 'custom:engineering/backend' });
  const canvas = await store.getCanvas(canvasId);
  const files = new JevWorkspaceFiles(root);
  await mkdir(path.dirname(files.file(workspaceId)), { recursive: true }); await writeFile(files.file(workspaceId), 'not JSON');
  expect(await groupLabels(root, canvas)).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBe('custom:engineering/backend');
  const state = emptyJevWorkspace(); state.vocabulary = [{ id: 'unused', kind: 'group', name: 'Unused', groupKey: 'custom:unused', definition: 'Other topic',
    aliases: [], members: [], state: 'active', version: 1 }];
  await files.write(workspaceId, state);
  expect(await groupLabels(root, canvas)).toBeUndefined();
  state.vocabulary.push({ ...state.vocabulary[0], id: 'engineering', name: 'Engineering', groupKey: 'custom:engineering',
    members: [{ canvasId, blockId }] });
  await files.write(workspaceId, state);
  expect(await groupLabels(root, canvas, [canvasId])).toEqual({ 'custom:engineering': 'Engineering' });
  expect(await groupLabels(root, canvas, [])).toBeUndefined();
});
