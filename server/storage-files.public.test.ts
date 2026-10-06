import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

let directory: string;
let store: CanvasStore;
let workspaceId: string;
let canvasId: string;
const servers: Server[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-storage-files-'));
  store = new CanvasStore(directory);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Filesystem checks' });
  workspaceId = workspace.id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Documents' })).id;
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await rm(directory, { recursive: true, force: true });
});

async function api() {
  const server = await createApiServer({ dataDir: directory });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}

async function references() {
  const targetCanvas = await store.createCanvas(workspaceId, { name: 'Reference targets' });
  const first = await store.createBlock(targetCanvas.id, { title: 'First target' });
  const second = await store.createBlock(targetCanvas.id, { title: 'Second target' });
  const source = await store.createBlock(canvasId, { title: 'Reader' });
  const crossLinks = [first, second].map(block => ({ canvasId: targetCanvas.id, blockId: block.id }));
  await store.updateBlock(canvasId, source.id, { crossLinks });
  return { targetCanvas, first, second, source, crossLinks };
}

it('discards the real merge snapshots of a deleted inbound-reference canvas without deleting the surviving documents', async () => {
  const keeper = await store.createBlock(canvasId, { title: 'Keeper', content: '# Original' });
  const merging = await store.createBlock(canvasId, { title: 'Source', content: '# Additional' });
  const portalCanvas = await store.createCanvas(workspaceId, { name: 'Inbound references' });
  const portal = await store.createBlock(portalCanvas.id, { title: 'Portal' });
  await store.updateBlock(portalCanvas.id, portal.id, { crossLinks: [{ canvasId, blockId: merging.id }] });
  const merged = await store.mergeDocuments(canvasId, { keepBlockId: keeper.id, mergeBlockIds: [merging.id],
    content: '# Combined', expectedContentHashes: { [keeper.id]: keeper.contentHash, [merging.id]: merging.contentHash } });
  const journalFile = path.join(directory, 'jev-merges', merged.mergeId + '.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  expect(journal).toMatchObject({ canvasId, otherCanvases: [{ id: portalCanvas.id }] });
  expect(journal.otherCanvases[0].before.blocks[0].content).toBeUndefined();
  const surviving = await store.getCanvas(canvasId, true);
  const history = await store.documentHistory(canvasId, keeper.id);
  await store.deleteCanvas(portalCanvas.id);
  await expect(stat(journalFile)).rejects.toMatchObject({ code: 'ENOENT' });
  const restarted = new CanvasStore(directory);
  expect(await restarted.getCanvas(canvasId, true)).toEqual(surviving);
  expect(await restarted.documentHistory(canvasId, keeper.id)).toEqual(history);
  await expect(restarted.getCanvas(portalCanvas.id)).rejects.toMatchObject({ status: 404 });
  await expect(restarted.undoMerge(merged.mergeId)).rejects.toMatchObject({ status: 404, message: 'Merge not found' });
});

it('filters missing cross-link targets without rewriting the saved references and restores them after the native file is repaired', async () => {
  const { targetCanvas, crossLinks } = await references();
  const sourceFile = path.join(directory, 'canvases', canvasId + '.json');
  const savedSource = await readFile(sourceFile, 'utf8');
  const targetFile = path.join(directory, 'canvases', targetCanvas.id + '.json');
  await rename(targetFile, targetFile + '.backup');
  expect((await store.getCanvas(canvasId)).blocks[0].crossLinks).toBeUndefined();
  expect(await readFile(sourceFile, 'utf8')).toBe(savedSource);
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0].crossLinks).toBeUndefined();
  await rename(targetFile + '.backup', targetFile);
  expect((await store.getCanvas(canvasId)).blocks[0].crossLinks).toEqual(crossLinks);
});

it.each(['directory', 'invalid JSON'])('reports a %s cross-link target failure over HTTP and recovers without dropping saved references', async obstruction => {
  const { targetCanvas, crossLinks } = await references();
  const targetFile = path.join(directory, 'canvases', targetCanvas.id + '.json');
  const original = await readFile(targetFile, 'utf8');
  const sourceFile = path.join(directory, 'canvases', canvasId + '.json');
  const savedSource = await readFile(sourceFile, 'utf8');
  const base = await api();
  expect((await fetch(base + `/api/canvases/${canvasId}`).then(response => response.json())).blocks[0].crossLinks).toEqual(crossLinks);
  await rm(targetFile);
  if (obstruction === 'directory') await mkdir(targetFile);
  else await writeFile(targetFile, '{malformed');
  const failure = await fetch(base + `/api/canvases/${canvasId}`);
  expect(failure.status).toBe(500);
  expect(await failure.json()).toEqual({ error: 'Internal server error' });
  expect(await readFile(sourceFile, 'utf8')).toBe(savedSource);
  await rm(targetFile, { recursive: true });
  await writeFile(targetFile, original);
  const recovered = await fetch(base + `/api/canvases/${canvasId}`);
  expect(recovered.status).toBe(200);
  expect((await recovered.json()).blocks[0].crossLinks).toEqual(crossLinks);
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0].crossLinks).toEqual(crossLinks);
});

it('ignores self and foreign-workspace references in legacy persisted metadata while retaining live same-workspace destinations', async () => {
  const { first, second, source, targetCanvas, crossLinks } = await references();
  await store.updateBlock(targetCanvas.id, second.id, { archived: true });
  const foreignWorkspace = await store.createWorkspace({ name: 'Other workspace' });
  const foreignCanvas = await store.createCanvas(foreignWorkspace.id, { name: 'Foreign targets' });
  const foreign = await store.createBlock(foreignCanvas.id, { title: 'Foreign reference' });
  const file = path.join(directory, 'canvases', canvasId + '.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.blocks[0].crossLinks.push({ canvasId, blockId: source.id },
    { canvasId: foreignCanvas.id, blockId: foreign.id }, { canvasId: targetCanvas.id, blockId: 'missing-target' });
  await writeFile(file, JSON.stringify(saved));
  const legacy = await readFile(file, 'utf8');
  expect((await store.getCanvas(canvasId)).blocks[0].crossLinks).toEqual([{ canvasId: targetCanvas.id, blockId: first.id }]);
  expect(await readFile(file, 'utf8')).toBe(legacy);
  await store.updateBlock(targetCanvas.id, second.id, { archived: false });
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0].crossLinks).toEqual(crossLinks);
});

it.each(['directory obstruction', 'corrupt journal'])('preflights a %s before deleting any durable canvas state and permits a later retry', async obstruction => {
  const block = await store.createBlock(canvasId, { title: 'Recoverable document', content: '# Keep me' });
  const before = await store.getCanvas(canvasId);
  const workspaces = await readFile(path.join(directory, 'workspaces.json'), 'utf8');
  const journalDirectory = path.join(directory, 'jev-merges');
  if (obstruction === 'directory obstruction') await writeFile(journalDirectory, 'not a directory');
  else {
    await mkdir(journalDirectory);
    await writeFile(path.join(journalDirectory, 'broken.json'), '{broken');
  }
  await expect(store.deleteCanvas(canvasId)).rejects.toThrow();
  expect(await new CanvasStore(directory).getCanvas(canvasId)).toEqual(before);
  expect(await readFile(path.join(directory, block.file), 'utf8')).toBe(block.content);
  expect(await readFile(path.join(directory, 'workspaces.json'), 'utf8')).toBe(workspaces);
  expect((await store.documentHistory(canvasId, block.id)).commits[0].message).toBe('Create Recoverable document');
  await rm(journalDirectory, { recursive: true });
  await store.deleteCanvas(canvasId);
  await expect(new CanvasStore(directory).getCanvas(canvasId)).rejects.toMatchObject({ status: 404 });
  await expect(stat(path.join(directory, block.file))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes historical run snapshot shapes on deletion while preserving unrelated journals and incomplete temporary files', async () => {
  await store.createBlock(canvasId, { title: 'Journal subject', content: '# Subject' });
  const journalDirectory = path.join(directory, 'jev-runs');
  await mkdir(journalDirectory);
  // Saved journals have used direct changes, nested applied steps, and suggestions.
  const journals = [
    { changes: [{ canvasId }] }, { steps: [{ change: { canvasId } }] }, { suggestions: [{ canvasId }] },
    { otherCanvases: [{ canvasId }] },
  ];
  for (const [index, journal] of journals.entries()) await writeFile(path.join(journalDirectory, index + '.json'), JSON.stringify(journal));
  const unrelated = { canvasId: 'another-canvas', changes: [null, { id: canvasId }, { change: { canvasId: 'another-canvas' } }],
    steps: 'malformed legacy field', suggestions: [] };
  await writeFile(path.join(journalDirectory, 'unrelated.json'), JSON.stringify(unrelated));
  await writeFile(path.join(journalDirectory, 'pending.tmp'), '{unfinished');
  await store.deleteCanvas(canvasId);
  expect((await readdir(journalDirectory)).sort()).toEqual(['pending.tmp', 'unrelated.json']);
  expect(JSON.parse(await readFile(path.join(journalDirectory, 'unrelated.json'), 'utf8'))).toEqual(unrelated);
});

it('returns exact externally edited files under cache pressure, refreshes replacements and deletes cached and uncached documents together', async () => {
  const blocks = await Promise.all(['First', 'Second', 'Oversized'].map(title => store.createBlock(canvasId, { title, content: '# Initial' })));
  const contents = ['# First\n' + ' '.repeat(9 * 1024 * 1024), '# Second\n' + ' '.repeat(9 * 1024 * 1024),
    '# Oversized\n' + ' '.repeat(16 * 1024 * 1024)];
  for (const [index, block] of blocks.entries()) await writeFile(path.join(directory, block.file), contents[index]);
  const read = await store.getCanvas(canvasId);
  expect(read.blocks.map(block => block.content)).toEqual(contents);
  expect((await store.getCanvas(canvasId)).blocks.map(block => block.contentHash)).toEqual(read.blocks.map(block => block.contentHash));
  const replacement = path.join(directory, blocks[0].file + '.replacement');
  await writeFile(replacement, '# Replacement');
  await rename(replacement, path.join(directory, blocks[0].file));
  const refreshed = await store.getCanvas(canvasId);
  expect(refreshed.blocks[0].content).toBe('# Replacement');
  expect(refreshed.blocks[0].contentHash).not.toBe(read.blocks[0].contentHash);
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks.map(block => block.content)).toEqual(['# Replacement', contents[1], contents[2]]);
  await store.deleteCanvas(canvasId);
  for (const block of blocks) await expect(stat(path.join(directory, block.file))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await store.search('Replacement')).toEqual([]);
  await expect(new CanvasStore(directory).getCanvas(canvasId)).rejects.toMatchObject({ status: 404 });
});
