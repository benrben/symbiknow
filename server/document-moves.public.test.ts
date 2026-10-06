import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import type { CanvasBlock } from '../shared/types.js';
import { createApiServer } from './index.js';
import { blockStateHash } from './block-state.js';

let directory: string;
let store: CanvasStore;
let workspaceId: string;
let sourceId: string;
let targetId: string;
const servers: Server[] = [];
let capacityReferences: CanvasBlock[];
let capacityReader: CanvasBlock;
let capacityInbound: { moving: CanvasBlock; reader: CanvasBlock; links: Array<{canvasId: string; blockId: string}> };

beforeEach(async context => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-document-moves-'));
  store = new CanvasStore(directory);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Move checks' });
  workspaceId = workspace.id;
  sourceId = (await store.createCanvas(workspaceId, { name: 'Source' })).id;
  targetId = (await store.createCanvas(workspaceId, { name: 'Destination' })).id;
  if (context.task.name.startsWith('refuses a move that converts 21 outgoing links')) {
    capacityReferences = [];
    for (let index = 0; index < 21; index++) capacityReferences.push(await store.createBlock(sourceId, { title: `Outgoing ${index}` }));
    capacityReader = await store.createBlock(sourceId, { title: 'Moving reader', links: capacityReferences.map(block => block.id) });
  }
  if (context.task.name.startsWith('preflights the inbound reader cross-link limit')) {
    const moving = await store.createBlock(sourceId, { title: 'Referenced moving document' });
    const reader = await store.createBlock(sourceId, { title: 'Reader', links: [moving.id] });
    const remote = await store.createCanvas(workspaceId, { name: 'Remote references' });
    const links = [];
    for (let index = 0; index < 20; index++) {
      const block = await store.createBlock(remote.id, { title: `Remote ${index}` });
      links.push({ canvasId: remote.id, blockId: block.id });
    }
    await store.updateBlock(sourceId, reader.id, { crossLinks: links });
    capacityInbound = { moving, reader, links };
  }
}, 20000);
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

async function hiddenReference() {
  const moving = await store.createBlock(sourceId, { title: 'Moving document' });
  const archived = await store.createBlock(sourceId, { title: 'Temporarily archived target' });
  const readerCanvas = await store.createCanvas(workspaceId, { name: 'Reader' });
  const reader = await store.createBlock(readerCanvas.id, { title: 'Stored reference' });
  const crossLinks = [{ canvasId: sourceId, blockId: archived.id, relation: 'implements' as const, confidence: 0.9 }];
  await store.updateBlock(readerCanvas.id, reader.id, { crossLinks });
  await store.updateBlock(sourceId, archived.id, { archived: true });
  return { moving, archived, readerCanvas, crossLinks, readerFile: path.join(directory, 'canvases', readerCanvas.id + '.json') };
}

it('preserves unrelated stored cross-links hidden by archived targets and restores them after unarchive and restart', async () => {
  const { moving, archived, readerCanvas, crossLinks, readerFile } = await hiddenReference();
  expect((await store.getCanvas(readerCanvas.id)).blocks[0].crossLinks).toBeUndefined();
  expect(JSON.parse(await readFile(readerFile, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
  await store.moveBlockToCanvas(sourceId, moving.id, targetId);
  expect(JSON.parse(await readFile(readerFile, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
  await store.updateBlock(sourceId, archived.id, { archived: false });
  expect((await new CanvasStore(directory).getCanvas(readerCanvas.id)).blocks[0].crossLinks).toEqual(crossLinks);
  expect((await new CanvasStore(directory).getCanvas(targetId)).blocks[0].id).toBe(moving.id);
});

it('retains hidden references in rollback snapshots when a native task-file obstruction happens after preflight', async () => {
  const { moving, archived, readerCanvas, crossLinks, readerFile } = await hiddenReference();
  const before = await store.getCanvas(sourceId, true);
  const targetTasks = path.join(directory, 'tasks', targetId + '.json');
  await mkdir(path.dirname(targetTasks), { recursive: true });
  // A named pipe lets the real read finish only after the destination becomes unwritable.
  await promisify(execFile)('mkfifo', [targetTasks]);
  const pending = store.moveBlockToCanvas(sourceId, moving.id, targetId);
  const rejected = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY)$/) });
  const writer = await open(targetTasks, 'w');
  try {
    await writer.writeFile('[]');
    await rename(targetTasks, targetTasks + '.fifo');
    await mkdir(targetTasks);
  } finally { await writer.close(); }
  await rejected;
  expect(await new CanvasStore(directory).getCanvas(sourceId, true)).toEqual(before);
  expect((await new CanvasStore(directory).getCanvas(targetId)).blocks).toEqual([]);
  expect(JSON.parse(await readFile(readerFile, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
  await rm(targetTasks, { recursive: true });
  await writeFile(targetTasks, '[]');
  await rm(targetTasks + '.fifo');
  await store.updateBlock(sourceId, archived.id, { archived: false });
  expect((await new CanvasStore(directory).getCanvas(readerCanvas.id)).blocks[0].crossLinks).toEqual(crossLinks);
  await store.moveBlockToCanvas(sourceId, moving.id, targetId);
  expect((await new CanvasStore(directory).getCanvas(targetId)).blocks[0].id).toBe(moving.id);
});

it('retains the moving document’s saved outgoing references when their destination is temporarily archived', async () => {
  const remote = await store.createCanvas(workspaceId, { name: 'Reference destination' });
  const reference = await store.createBlock(remote.id, { title: 'Archived reference' });
  const moving = await store.createBlock(sourceId, { title: 'Moving reader' });
  const crossLinks = [{ canvasId: remote.id, blockId: reference.id, relation: 'prerequisite' as const }];
  await store.updateBlock(sourceId, moving.id, { crossLinks });
  await store.updateBlock(remote.id, reference.id, { archived: true });
  await store.moveBlockToCanvas(sourceId, moving.id, targetId);
  const saved = JSON.parse(await readFile(path.join(directory, 'canvases', targetId + '.json'), 'utf8'));
  expect(saved.blocks[0].crossLinks).toEqual(crossLinks);
  expect((await store.getCanvas(targetId)).blocks[0].crossLinks).toBeUndefined();
  await store.updateBlock(remote.id, reference.id, { archived: false });
  expect((await new CanvasStore(directory).getCanvas(targetId)).blocks[0].crossLinks).toEqual(crossLinks);
});

it('remaps typed and untyped links, third-canvas portals and task context over HTTP without changing document content or Git history', async () => {
  const plain = await store.createBlock(sourceId, { title: 'Untyped outgoing' });
  const typed = await store.createBlock(sourceId, { title: 'Typed outgoing' });
  const moving = await store.createBlock(sourceId, { title: 'Moving document', content: '# Durable content', links: [plain.id, typed.id] }, 'Creator');
  await store.updateBlock(sourceId, moving.id, { linkTypes: { [typed.id]: 'prerequisite' } });
  const sourceReader = await store.createBlock(sourceId, { title: 'Typed reader', links: [moving.id, plain.id] });
  await store.updateBlock(sourceId, sourceReader.id, { linkTypes: { [moving.id]: 'implements', [plain.id]: 'related' } });
  const untypedReader = await store.createBlock(sourceId, { title: 'Untyped reader', links: [moving.id] });
  const localTyped = await store.createBlock(targetId, { title: 'New local typed reference' });
  const localPlain = await store.createBlock(targetId, { title: 'New local untyped reference' });
  const remote = await store.createCanvas(workspaceId, { name: 'Third canvas' });
  const remoteTarget = await store.createBlock(remote.id, { title: 'Remote target' });
  const portal = await store.createBlock(remote.id, { title: 'Inbound portal' });
  await store.updateBlock(remote.id, portal.id, { crossLinks: [{ canvasId: sourceId, blockId: moving.id, relation: 'same_topic', confidence: 0.91 },
    { canvasId: sourceId, blockId: plain.id }] });
  const targetReader = await store.createBlock(targetId, { title: 'Destination reader', links: [localPlain.id] });
  await store.updateBlock(targetId, targetReader.id, { linkTypes: { [localPlain.id]: 'example_of' },
    crossLinks: [{ canvasId: sourceId, blockId: moving.id, relation: 'decision_for' }] });
  await store.updateBlock(sourceId, moving.id, { crossLinks: [
    { canvasId: targetId, blockId: localTyped.id, relation: 'implements' }, { canvasId: targetId, blockId: localPlain.id },
    { canvasId: remote.id, blockId: remoteTarget.id, confidence: 0.8 },
  ] });
  const sourceTask = await store.createTask(sourceId, { title: 'Review moved context', detail: 'Keep owner and deadline', status: 'in_progress',
    assignee: 'Reviewer', dueDate: '2026-12-01', blockIds: [moving.id, plain.id] }, 'Planner');
  const unaffected = await store.createTask(sourceId, { title: 'Keep source work', blockIds: [typed.id] }, 'Planner');
  const targetTask = await store.createTask(targetId, { title: 'Keep target work', blockIds: [localPlain.id] }, 'Planner');
  const history = await store.documentHistory(sourceId, moving.id);
  const base = await api();
  const response = await fetch(base + `/api/canvases/${sourceId}/blocks/${moving.id}/move`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Mover' }, body: JSON.stringify({ targetCanvasId: targetId }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ fromCanvasId: sourceId, toCanvasId: targetId, blockId: moving.id });
  const restarted = new CanvasStore(directory);
  const target = await restarted.getCanvas(targetId);
  const moved = target.blocks.find(block => block.id === moving.id)!;
  expect(moved).toMatchObject({ content: moving.content, file: moving.file, links: [localTyped.id, localPlain.id], linkTypes: { [localTyped.id]: 'implements' },
    crossLinks: [{ canvasId: remote.id, blockId: remoteTarget.id, confidence: 0.8 }, { canvasId: sourceId, blockId: plain.id },
      { canvasId: sourceId, blockId: typed.id, relation: 'prerequisite' }] });
  expect(target.blocks.find(block => block.id === targetReader.id)).toMatchObject({ links: [localPlain.id, moving.id],
    linkTypes: { [localPlain.id]: 'example_of', [moving.id]: 'decision_for' } });
  const source = await restarted.getCanvas(sourceId);
  expect(source.blocks.find(block => block.id === moving.id)).toBeUndefined();
  expect(source.blocks.find(block => block.id === sourceReader.id)).toMatchObject({ links: [plain.id], linkTypes: { [plain.id]: 'related' },
    crossLinks: [{ canvasId: targetId, blockId: moving.id, relation: 'implements' }] });
  expect(source.blocks.find(block => block.id === untypedReader.id)).toMatchObject({ links: [], crossLinks: [{ canvasId: targetId, blockId: moving.id }] });
  expect((await restarted.getCanvas(remote.id)).blocks.find(block => block.id === portal.id)?.crossLinks).toEqual([
    { canvasId: targetId, blockId: moving.id, relation: 'same_topic', confidence: 0.91 }, { canvasId: sourceId, blockId: plain.id },
  ]);
  const sourceTasks = await restarted.listTasks(sourceId);
  expect(sourceTasks.find(task => task.id === unaffected.id)).toEqual(unaffected);
  expect(sourceTasks.find(task => task.id === sourceTask.id)).toMatchObject({ blockIds: [plain.id], updatedBy: 'Mover',
    comments: [{ author: 'Mover', text: expect.stringContaining('related work continues there') }] });
  const targetTasks = await restarted.listTasks(targetId);
  expect(targetTasks[0]).toEqual(targetTask);
  expect(targetTasks[1]).toMatchObject({ title: sourceTask.title, detail: sourceTask.detail, status: sourceTask.status, assignee: sourceTask.assignee,
    dueDate: sourceTask.dueDate, blockIds: [moving.id], createdBy: 'Mover', comments: [{ author: 'Mover', text: expect.stringContaining(sourceTask.id) }] });
  expect(await readFile(path.join(directory, moving.file), 'utf8')).toBe(moving.content);
  expect(await restarted.documentHistory(targetId, moving.id)).toEqual(history);
});

it('refuses a move that converts 21 outgoing links, preserves all files, and accepts the 20-link boundary after review', async () => {
  const references = capacityReferences;
  const moving = capacityReader;
  const before = await store.getCanvas(sourceId);
  const history = await store.documentHistory(sourceId, moving.id);
  await expect(store.moveBlockToCanvas(sourceId, moving.id, targetId)).rejects.toMatchObject({ status: 409,
    message: 'Moving this document would exceed the cross-canvas link limit. Review its links first.' });
  expect(await new CanvasStore(directory).getCanvas(sourceId)).toEqual(before);
  expect((await new CanvasStore(directory).getCanvas(targetId)).blocks).toEqual([]);
  expect(await store.documentHistory(sourceId, moving.id)).toEqual(history);
  await store.updateBlock(sourceId, moving.id, { links: references.slice(0, 20).map(block => block.id) });
  await store.moveBlockToCanvas(sourceId, moving.id, targetId);
  expect((await new CanvasStore(directory).getCanvas(targetId)).blocks[0].crossLinks)
    .toEqual(references.slice(0, 20).map(block => ({ canvasId: sourceId, blockId: block.id })));
});

it('preflights the inbound reader cross-link limit before moving and preserves its existing references at the boundary', async () => {
  const { moving, reader, links } = capacityInbound;
  const before = await store.getCanvas(sourceId);
  await expect(store.moveBlockToCanvas(sourceId, moving.id, targetId)).rejects.toMatchObject({ status: 409 });
  expect(await new CanvasStore(directory).getCanvas(sourceId)).toEqual(before);
  await store.updateBlock(sourceId, reader.id, { crossLinks: links.slice(0, 19) });
  await store.moveBlockToCanvas(sourceId, moving.id, targetId);
  expect((await new CanvasStore(directory).getCanvas(sourceId)).blocks[0].crossLinks)
    .toEqual([...links.slice(0, 19), { canvasId: targetId, blockId: moving.id }]);
});

it('refuses task overflow before changing the canvases and copies the linked task after one destination slot is freed', async () => {
  const moving = await store.createBlock(sourceId, { title: 'Moving task context' });
  await store.createTask(sourceId, { title: 'Follow document', blockIds: [moving.id] }, 'Planner');
  const seed = await store.createTask(targetId, { title: 'Existing destination work' }, 'Planner');
  // A native persisted workspace with 500 valid records avoids hundreds of identical fixture writes.
  const tasks = Array.from({ length: 500 }, (_, index) => ({ ...seed, id: randomUUID(), title: `Existing ${index}` }));
  const taskFile = path.join(directory, 'tasks', targetId + '.json');
  await writeFile(taskFile, JSON.stringify(tasks));
  const before = await store.getCanvas(sourceId);
  await expect(store.moveBlockToCanvas(sourceId, moving.id, targetId)).rejects.toMatchObject({ status: 409,
    message: 'The destination canvas cannot hold the tasks attached to this document.' });
  expect(await new CanvasStore(directory).getCanvas(sourceId)).toEqual(before);
  expect(await new CanvasStore(directory).listTasks(targetId)).toEqual(tasks);
  await store.deleteTask(targetId, tasks[0].id);
  await store.moveBlockToCanvas(sourceId, moving.id, targetId);
  const restarted = new CanvasStore(directory);
  expect(await restarted.listTasks(targetId)).toHaveLength(500);
  expect((await restarted.listTasks(targetId))[499]).toMatchObject({ title: 'Follow document', blockIds: [moving.id], createdBy: 'api' });
  expect((await restarted.listTasks(sourceId))[0]).toMatchObject({ blockIds: [], updatedBy: 'api' });
});

it('rejects stale review hashes before remapping native references or task context', async () => {
  const moving = await store.createBlock(sourceId, { title: 'Reviewed document' });
  await store.createTask(sourceId, { title: 'Review context', blockIds: [moving.id] }, 'Planner');
  const oldHash = blockStateHash(moving);
  await store.updateBlock(sourceId, moving.id, { tags: ['changed'] });
  const before = await store.getCanvas(sourceId);
  const tasks = await store.listTasks(sourceId);
  await expect(store.moveBlockToCanvas(sourceId, moving.id, targetId, 'Reviewer', oldHash)).rejects.toMatchObject({ status: 409, message: 'Document changed since review' });
  expect(await new CanvasStore(directory).getCanvas(sourceId)).toEqual(before);
  expect(await new CanvasStore(directory).listTasks(sourceId)).toEqual(tasks);
  await store.moveBlockToCanvas(sourceId, moving.id, targetId, 'Reviewer', blockStateHash(before.blocks[0]));
  expect((await new CanvasStore(directory).getCanvas(targetId)).blocks[0]).toMatchObject({ id: moving.id, tags: ['changed'] });
});

it('drops legacy self-references during localization without converting them to typed self-links', async () => {
  const moving = await store.createBlock(sourceId, { title: 'Legacy reference' });
  const file = path.join(directory, 'canvases', sourceId + '.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.blocks[0].crossLinks = [{ canvasId: targetId, blockId: moving.id, relation: 'implements' }];
  await writeFile(file, JSON.stringify(saved));
  expect((await store.getCanvas(sourceId)).blocks[0].crossLinks).toBeUndefined();
  await store.moveBlockToCanvas(sourceId, moving.id, targetId);
  const moved = (await new CanvasStore(directory).getCanvas(targetId)).blocks[0];
  expect(moved.links).toEqual([]);
  expect(moved.linkTypes).toBeUndefined();
  expect(moved.crossLinks).toBeUndefined();
});
