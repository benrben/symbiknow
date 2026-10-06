import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasTask } from '../shared/types.js';
import { atomicJson } from './storage-files.js';
import { CanvasStore, contentHash } from './storage.js';
import { storedBlock, type StoredCanvas } from './storage-shapes.js';
import { initializeJevStamp } from './jev/stamps.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './jev/workspace.js';

let root: string; let store: CanvasStore; let workspaceId: string; let canvasId: string;
const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const canvasFile = () => path.join(root, 'canvases', `${canvasId}.json`);
const rawCanvas = async () => JSON.parse(await readFile(canvasFile(), 'utf8')) as StoredCanvas;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbiknow-storage-performance-'));
  store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Large knowledge workspace' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: '158 source documents' })).id;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function nativeSources(count: number) {
  const body = '# Source knowledge\n' + 'A substantive project requirement and its supporting evidence.\n'.repeat(400);
  const blocks: CanvasBlock[] = Array.from({ length: count }, (_, index) => initializeJevStamp({
    id: `performance-source-${index}`, title: `Source ${index}`, file: `docs/performance-source-${index}.md`, kind: 'markdown',
    content: body, x: index * 20, y: 80, width: 400, height: 320, group: 'custom:knowledge', links: [],
  }));
  await Promise.all(blocks.map(block => writeFile(path.join(root, block.file), block.content)));
  await atomicJson(canvasFile(), { ...(await rawCanvas()), blocks: blocks.map(storedBlock) });
  return blocks;
}
function nativeTask(blockIds: string[]): CanvasTask {
  return { id: 'native-work', title: 'Keep manual work', detail: 'A manually maintained task', status: 'in_progress',
    assignee: 'owner', reviewer: 'reviewer', blockIds, createdBy: 'Owner', updatedBy: 'Owner',
    createdAt: '2026-10-04T08:00:00Z', updatedAt: '2026-10-04T08:01:00Z', revision: 4, comments: [] };
}

it('checks stamps and tasks for 158 documents without reading source bodies or the Reflex analysis ledger', async () => {
  const sources = await nativeSources(158); const task = nativeTask([sources[0].id, sources[157].id]);
  await atomicJson(path.join(root, 'tasks', `${canvasId}.json`), [task]);
  const files = new JevWorkspaceFiles(root); await mkdir(path.dirname(files.file(workspaceId)), { recursive: true });
  await writeFile(files.file(workspaceId), '{ unavailable analysis ledger');
  await rm(path.join(root, sources[80].file));
  const saved = await readFile(canvasFile(), 'utf8'); const warn = warnings();
  await store.ensureJevStamps(canvasId);
  expect(await store.listTasks(canvasId)).toEqual([task]);
  expect((await store.getCanvasSummary(canvasId)).blocks).toHaveLength(158);
  expect((await store.getCanvasSummary(canvasId)).blocks[80].contentVersion).toBeUndefined();
  expect(await readFile(canvasFile(), 'utf8')).toBe(saved);
  expect(warn).not.toHaveBeenCalled();
  await expect(store.getCanvas(canvasId, true, false)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('initializes legacy source identity from native metadata while preserving explicit manual pins and stale saved references', async () => {
  const sources = await nativeSources(2); const canvas = await rawCanvas();
  const legacy = canvas.blocks[0];
  delete legacy.incarnation; delete legacy.sourceGeneration; delete legacy.metadataRevision; delete legacy.jevOwnership;
  legacy.tags = ['Manual label']; legacy.crossLinks = [{ canvasId: 'missing-canvas', blockId: 'missing-document' }];
  canvas.blocks[1].sourceGeneration = 31; canvas.blocks[1].metadataRevision = 92;
  await atomicJson(canvasFile(), canvas); await rm(path.join(root, sources[0].file));
  const warn = warnings(); await store.ensureJevStamps(canvasId);
  const stamped = await new CanvasStore(root).getCanvasSummary(canvasId);
  expect(stamped.blocks[0]).toMatchObject({ id: legacy.id, group: legacy.group, tags: legacy.tags, x: legacy.x, y: legacy.y,
    incarnation: expect.any(String), sourceGeneration: 1, metadataRevision: 1 });
  expect(stamped.blocks[0].jevOwnership?.pins).toEqual(expect.arrayContaining(['group', 'tags', 'crossLinks']));
  expect((await rawCanvas()).blocks[0].crossLinks).toEqual(legacy.crossLinks);
  expect((await rawCanvas()).blocks[1]).toEqual(canvas.blocks[1]);
  const saved = await readFile(canvasFile(), 'utf8'); await store.ensureJevStamps(canvasId);
  expect(await readFile(canvasFile(), 'utf8')).toBe(saved); expect(warn).not.toHaveBeenCalled();
});

it('keeps default display labels while internal knowledge reads omit them and observe fresh source edits', async () => {
  const sources = await nativeSources(2); const files = new JevWorkspaceFiles(root); const state = emptyJevWorkspace();
  state.vocabulary = [{ id: 'knowledge-term', kind: 'group', name: 'Shared knowledge', groupKey: 'custom:knowledge',
    definition: 'Substantive source knowledge', aliases: [], state: 'active', version: 1, members: [{ canvasId, blockId: sources[0].id }] }];
  await files.write(workspaceId, state);
  expect((await store.getCanvas(canvasId)).groupLabels).toEqual({ 'custom:knowledge': 'Shared knowledge' });
  const knowledge = await store.getCanvas(canvasId, true, false);
  expect(knowledge.groupLabels).toBeUndefined(); expect(knowledge.blocks[0].content).toBe(sources[0].content);
  expect(knowledge.blocks[0].contentHash).toBe(contentHash(sources[0].content));
  const beforeSummary = await store.getCanvasSummary(canvasId);
  const beforeBody = await store.getCanvasBlock(canvasId, sources[0].id);
  expect(beforeBody.contentVersion).toBe(beforeSummary.blocks[0].contentVersion);
  expect(beforeBody.contentVersion).toEqual(expect.any(String));
  await writeFile(path.join(root, sources[0].file), '# Source edited outside the application');
  const fresh = await store.getCanvas(canvasId, true, false);
  expect(fresh.blocks[0].content).toBe('# Source edited outside the application');
  expect(fresh.blocks[0].contentHash).not.toBe(knowledge.blocks[0].contentHash);
  const afterSummary = await store.getCanvasSummary(canvasId);
  expect(afterSummary.blocks[0].contentVersion).not.toBe(beforeSummary.blocks[0].contentVersion);
  const afterBody = await new CanvasStore(root).getCanvasBlock(canvasId, sources[0].id);
  expect(afterBody.contentVersion).toBe(afterSummary.blocks[0].contentVersion);
  expect(afterBody.contentHash).toBe(contentHash('# Source edited outside the application'));
  expect((await rawCanvas()).blocks[0]).not.toHaveProperty('contentVersion');
  expect((await store.getCanvas(canvasId)).groupLabels).toEqual({ 'custom:knowledge': 'Shared knowledge' });
});

it('surfaces native stat failures instead of accepting an inaccessible source version as unchanged', async () => {
  const sources = await nativeSources(1); const file = path.join(root, sources[0].file);
  await rm(file); await symlink(path.basename(file), file);
  await expect(store.getCanvasSummary(canvasId)).rejects.toMatchObject({ code: 'ELOOP' });
  await expect(store.listTasks(canvasId)).rejects.toMatchObject({ code: 'ELOOP' });
  await rm(file); await writeFile(file, '# Repaired source');
  expect((await store.getCanvasSummary(canvasId)).blocks[0].contentVersion).toEqual(expect.any(String));
  expect((await store.getCanvasBlock(canvasId, sources[0].id)).content).toBe('# Repaired source');
});

it('keeps internal canonical metadata writes independent of the optional damaged display-label ledger', async () => {
  const sources = await nativeSources(2); const files = new JevWorkspaceFiles(root);
  await mkdir(path.dirname(files.file(workspaceId)), { recursive: true }); await writeFile(files.file(workspaceId), '{ damaged labels');
  const warn = warnings(); await store.updateBlock(canvasId, sources[0].id, { tags: ['A direct correction'] }, 'Owner');
  expect((await rawCanvas()).blocks[0].tags).toEqual(['A direct correction']);
  expect(warn).not.toHaveBeenCalled();
  const publicCanvas = await store.getCanvas(canvasId);
  expect(publicCanvas.groupLabels).toBeUndefined(); expect(warn).toHaveBeenCalledTimes(1);
  expect(publicCanvas.blocks[0].content).toBe(sources[0].content);
});

it('retains native ID, missing-canvas and corrupt-metadata failures for metadata-only operations', async () => {
  await expect(store.getCanvasBlock(canvasId, '../outside')).rejects.toMatchObject({ status: 400 });
  await expect(store.getCanvasBlock(canvasId, 'missing-source')).rejects.toMatchObject({ status: 404 });
  for (const operation of [() => store.ensureJevStamps('../outside'), () => store.listTasks('../outside')]) {
    await expect(operation()).rejects.toMatchObject({ status: 400 });
  }
  for (const operation of [() => store.ensureJevStamps('missing-canvas'), () => store.listTasks('missing-canvas')]) {
    await expect(operation()).rejects.toMatchObject({ status: 404 });
  }
  await writeFile(canvasFile(), '{ unreadable canvas metadata');
  await expect(store.ensureJevStamps(canvasId)).rejects.toBeInstanceOf(SyntaxError);
  await expect(store.listTasks(canvasId)).rejects.toBeInstanceOf(SyntaxError);
});
