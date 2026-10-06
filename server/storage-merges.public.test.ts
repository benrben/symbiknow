import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import type { CanvasDocument, CrossLink } from '../shared/types.js';
import { atomicJson } from './storage-files.js';
import { storedBlock } from './storage-shapes.js';
import { initializeJevStamp } from './jev/stamps.js';

let directory: string;
let store: CanvasStore;
let canvasId: string;
let crossLinkBoundary: Awaited<ReturnType<typeof documents>> & { links: CrossLink[] };

beforeEach(async context => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-storage-merges-'));
  store = new CanvasStore(directory);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Merge checks' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Documents' })).id;
  if (context.task.name.startsWith('checks the union of cross-canvas references')) crossLinkBoundary = await crossLinkFixture();
}, 20000);
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });


function expectRestoredCanvas(current: CanvasDocument, previous: CanvasDocument) {
  const withoutClocks = (canvas: CanvasDocument) => ({ ...canvas, blocks: canvas.blocks.map(source => { const block = { ...source }; delete block.sourceGeneration; delete block.metadataRevision; return block; }) });
  expect(withoutClocks(current)).toEqual(withoutClocks(previous));
  for (const block of current.blocks) {
    const old = previous.blocks.find(item => item.id === block.id)!;
    expect(block.sourceGeneration).toBeGreaterThanOrEqual(old.sourceGeneration ?? 0);
    expect(block.metadataRevision).toBeGreaterThanOrEqual(old.metadataRevision ?? 0);
  }
}
function expectRestoredTasks(current: Awaited<ReturnType<CanvasStore['listTasks']>>, previous: Awaited<ReturnType<CanvasStore['listTasks']>>) {
  const withoutRevision = (tasks: typeof current) => tasks.map(source => { const task = { ...source }; delete task.revision; return task; });
  expect(withoutRevision(current)).toEqual(withoutRevision(previous));
  for (const task of current) expect(task.revision).toBeGreaterThanOrEqual(previous.find(item => item.id === task.id)!.revision ?? 0);
}

async function documents() {
  const keeper = await store.createBlock(canvasId, { title: 'Keeper', content: '# Keeper\nOriginal context' });
  const merging = await store.createBlock(canvasId, { title: 'Folded source', content: '# Source\nAdditional context' });
  const input = { keepBlockId: keeper.id, mergeBlockIds: [merging.id], content: '# Combined\nOriginal and additional context',
    expectedContentHashes: { [keeper.id]: keeper.contentHash, [merging.id]: merging.contentHash } };
  return { keeper, merging, input };
}

it('keeps outgoing typed and cross-canvas references from the folded document and restores both documents on undo', async () => {
  const { keeper, merging, input } = await documents();
  const target = await store.createBlock(canvasId, { title: 'Local prerequisite' });
  const workspaceId = (await store.getCanvas(canvasId)).workspaceId;
  const references = await store.createCanvas(workspaceId, { name: 'References' });
  const reference = await store.createBlock(references.id, { title: 'Remote reference' });
  await store.updateBlock(canvasId, merging.id, { links: [target.id], linkTypes: { [target.id]: 'prerequisite' },
    crossLinks: [{ canvasId: references.id, blockId: reference.id, relation: 'implements', confidence: 0.91 }] });
  const before = await store.getCanvas(canvasId, true);
  const result = await store.mergeDocuments(canvasId, input, 'Merger');
  const saved = await new CanvasStore(directory).getCanvas(canvasId);
  expect(saved.blocks.find(block => block.id === keeper.id)).toMatchObject({ links: [target.id],
    linkTypes: { [target.id]: 'prerequisite' }, crossLinks: [{ canvasId: references.id, blockId: reference.id, relation: 'implements', confidence: 0.91 }] });
  await store.undoMerge(result.mergeId, 'Merger');
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
});

it('rejects corrupt task state before changing document content, canvas metadata or Git history', async () => {
  const { keeper, input } = await documents();
  await store.createTask(canvasId, { title: 'Review merged context' }, 'Reviewer');
  const taskFile = path.join(directory, 'tasks', canvasId + '.json');
  const tasks = await readFile(taskFile, 'utf8');
  const before = await store.getCanvas(canvasId, true);
  const history = await store.documentHistory(canvasId, keeper.id);
  await writeFile(taskFile, '{broken');
  await expect(store.mergeDocuments(canvasId, input)).rejects.toBeInstanceOf(SyntaxError);
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
  expect(await readFile(path.join(directory, keeper.file), 'utf8')).toBe(keeper.content);
  expect(await store.documentHistory(canvasId, keeper.id)).toEqual(history);
  await writeFile(taskFile, tasks);
  const merged = await store.mergeDocuments(canvasId, input);
  await store.undoMerge(merged.mergeId);
  expectRestoredCanvas(await store.getCanvas(canvasId, true), before);
});

it('requires a durable undo journal before changing the stored documents and can retry after an obstruction is removed', async () => {
  const { keeper, input } = await documents();
  const before = await store.getCanvas(canvasId, true);
  const history = await store.documentHistory(canvasId, keeper.id);
  const journalDir = path.join(directory, 'jev-merges');
  await writeFile(journalDir, 'blocked');
  await expect(store.mergeDocuments(canvasId, input)).rejects.toMatchObject({ code: 'EEXIST' });
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
  expect(await store.documentHistory(canvasId, keeper.id)).toEqual(history);
  await rm(journalDir);
  const merged = await store.mergeDocuments(canvasId, input);
  await store.undoMerge(merged.mergeId);
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
});

function shellPath(file: string): string { return `'${file.replaceAll("'", "'\\''")}'`; }
async function toggleObstruction(keeperId: string, file: string): Promise<string> {
  const hook = path.join(directory, '.versions', keeperId, '.git', 'hooks', 'post-commit');
  const target = shellPath(file);
  const backup = shellPath(file + '.backup');
  await writeFile(hook, `#!/bin/sh\nif [ -d ${target} ]; then\n  rmdir ${target}\n  mv ${backup} ${target}\nelse\n  mv ${target} ${backup}\n  mkdir ${target}\nfi\n`, { mode: 0o755 });
  return hook;
}

it('restores every written canvas, task and document after a later task-file failure and records the Git rollback', async () => {
  const { keeper, merging, input } = await documents();
  await store.createTask(canvasId, { title: 'Review context', blockIds: [merging.id] }, 'Reviewer');
  const canvas = await store.getCanvas(canvasId);
  const other = await store.createCanvas(canvas.workspaceId, { name: 'Inbound reference' });
  const portal = await store.createBlock(other.id, { title: 'Portal' });
  await store.updateBlock(other.id, portal.id, { crossLinks: [{ canvasId, blockId: merging.id }] });
  const before = await store.getCanvas(canvasId, true);
  const otherBefore = await store.getCanvas(other.id);
  const tasksBefore = await store.listTasks(canvasId);
  const hook = await toggleObstruction(keeper.id, path.join(directory, 'tasks', canvasId + '.json'));
  await expect(store.mergeDocuments(canvasId, input, 'Merger')).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY)$/) });
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
  expectRestoredCanvas(await store.getCanvas(other.id), otherBefore);
  expect((await store.getCanvas(other.id)).blocks[0].id).toBe(portal.id);
  expectRestoredTasks(await store.listTasks(canvasId), tasksBefore);
  expect((await store.documentHistory(canvasId, keeper.id)).commits[0]).toMatchObject({ message: 'Rollback failed merge', author: 'Merger' });
  expect(await readdir(path.join(directory, 'jev-merges'))).toEqual([]);
  await rm(hook);
  const merged = await store.mergeDocuments(canvasId, input, 'Merger');
  expect((await stat(path.join(directory, 'jev-merges', merged.mergeId + '.json'))).mode & 0o777).toBe(0o600);
  await store.undoMerge(merged.mergeId, 'Merger');
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
});

it('restores the applied merge and keeps Undo retryable when writing the undone journal fails', async () => {
  const { keeper, input } = await documents();
  const merged = await store.mergeDocuments(canvasId, input, 'Merger');
  const applied = await store.getCanvas(canvasId, true);
  const journal = path.join(directory, 'jev-merges', merged.mergeId + '.json');
  const hook = await toggleObstruction(keeper.id, journal);
  await expect(store.undoMerge(merged.mergeId, 'Merger')).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY)$/) });
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), applied);
  expect(JSON.parse(await readFile(journal, 'utf8')).undone).toBeUndefined();
  expect((await store.documentHistory(canvasId, keeper.id)).commits[0]).toMatchObject({ message: 'Rollback failed Undo merge' });
  await rm(hook);
  expect(await store.undoMerge(merged.mergeId, 'Merger')).toEqual({ mergeId: merged.mergeId, reverted: true });
  await expect(store.undoMerge(merged.mergeId, 'Merger')).rejects.toMatchObject({ status: 409, message: 'Merge already undone' });
});

it('retains the durable original snapshots and reports both errors if the Git repository prevents rollback', async () => {
  const { keeper, input } = await documents();
  const before = await store.getCanvas(canvasId, true);
  const hook = path.join(directory, '.versions', keeper.id, '.git', 'hooks', 'post-commit');
  const lock = path.join(directory, '.versions', keeper.id, '.git', 'index.lock');
  const tasks = path.join(directory, 'tasks', canvasId + '.json');
  await store.createTask(canvasId, { title: 'Review' }, 'Reviewer');
  await writeFile(hook, `#!/bin/sh\n: > ${shellPath(lock)}\nmv ${shellPath(tasks)} ${shellPath(tasks + '.backup')}\nmkdir ${shellPath(tasks)}\n`, { mode: 0o755 });
  await expect(store.mergeDocuments(canvasId, input)).rejects.toMatchObject({ name: 'AggregateError',
    message: expect.stringContaining('Original snapshots remain') });
  const files = await readdir(path.join(directory, 'jev-merges'));
  expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(directory, 'jev-merges', files[0]), 'utf8')).beforeContent).toBe(keeper.content);
  await rm(lock);
  await rm(hook);
  await rm(tasks, { recursive: true });
  await rename(tasks + '.backup', tasks);
  const mergeId = files[0].replace(/\.json$/, '');
  expect(await new CanvasStore(directory).undoMerge(mergeId)).toEqual({ mergeId, reverted: true });
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
});

it('remaps typed local references and mixed inbound cross links while preserving the keeper relation on outgoing duplicates', async () => {
  const { keeper, merging, input } = await documents();
  const target = await store.createBlock(canvasId, { title: 'Local target' });
  const inbound = await store.createBlock(canvasId, { title: 'Local reader', links: [merging.id, target.id] });
  await store.updateBlock(canvasId, inbound.id, { linkTypes: { [merging.id]: 'prerequisite', [target.id]: 'implements' } });
  const workspaceId = (await store.getCanvas(canvasId)).workspaceId;
  const remote = await store.createCanvas(workspaceId, { name: 'Remote' });
  const reference = await store.createBlock(remote.id, { title: 'Reference' });
  const otherRemote = await store.createCanvas(workspaceId, { name: 'Unrelated' });
  const unrelated = await store.createBlock(otherRemote.id, { title: 'Unrelated reference' });
  const portal = await store.createBlock(remote.id, { title: 'Reader' });
  await store.updateBlock(remote.id, portal.id, { crossLinks: [
    { canvasId, blockId: merging.id, relation: 'related' }, { canvasId, blockId: keeper.id, relation: 'implements' },
    { canvasId: otherRemote.id, blockId: unrelated.id, relation: 'prerequisite' }, { canvasId, blockId: target.id },
  ] });
  await store.updateBlock(canvasId, keeper.id, { links: [merging.id, target.id], linkTypes: { [merging.id]: 'related', [target.id]: 'implements' },
    crossLinks: [{ canvasId: remote.id, blockId: reference.id, relation: 'implements' }] });
  await store.updateBlock(canvasId, merging.id, { links: [target.id], linkTypes: { [target.id]: 'prerequisite' },
    crossLinks: [{ canvasId: remote.id, blockId: reference.id, relation: 'prerequisite' }] });
  const result = await store.mergeDocuments(canvasId, input);
  const saved = await new CanvasStore(directory).getCanvas(canvasId);
  expect(saved.blocks.find(block => block.id === keeper.id)).toMatchObject({ links: [target.id],
    linkTypes: { [target.id]: 'implements' }, crossLinks: [{ canvasId: remote.id, blockId: reference.id, relation: 'implements' }] });
  expect(saved.blocks.find(block => block.id === inbound.id)).toMatchObject({ links: [keeper.id, target.id],
    linkTypes: { [keeper.id]: 'prerequisite', [target.id]: 'implements' } });
  expect((await store.getCanvas(remote.id)).blocks.find(block => block.id === portal.id)?.crossLinks).toEqual([
    { canvasId, blockId: keeper.id, relation: 'implements' }, { canvasId: otherRemote.id, blockId: unrelated.id, relation: 'prerequisite' },
    { canvasId, blockId: target.id },
  ]);
  await store.undoMerge(result.mergeId);
  expect((await store.getCanvas(canvasId)).blocks.find(block => block.id === inbound.id)?.links).toEqual([merging.id, target.id]);
});

async function crossLinkFixture() {
  const { keeper, merging, input } = await documents();
  const remote = await store.createCanvas((await store.getCanvas(canvasId)).workspaceId, { name: 'References' });
  const template = await store.createBlock(remote.id, { title: 'Reference 0' });
  // Restore unrelated reference sources in one batch; only the merged documents need Git history.
  const targets = [template, ...Array.from({ length: 20 }, (_, index) => {
    const id = randomUUID(); const title = `Reference ${index + 1}`;
    return initializeJevStamp({ ...template, id, title, content: `# ${title}\n`, file: `docs/${id}.md`,
      incarnation: undefined, x: 100 + (index + 1) * 500 });
  })];
  await Promise.all(targets.slice(1).map(block => writeFile(path.join(directory, block.file), block.content)));
  const restored = { ...await store.getCanvas(remote.id, true), blocks: targets.map(storedBlock) };
  await atomicJson(path.join(directory, 'canvases', remote.id + '.json'), restored);
  expect((await new CanvasStore(directory).getCanvas(remote.id)).blocks.map(block => block.id)).toEqual(targets.map(block => block.id));
  const links = targets.map(block => ({ canvasId: remote.id, blockId: block.id }));
  await store.updateBlock(canvasId, keeper.id, { crossLinks: links.slice(0, 20) });
  await store.updateBlock(canvasId, merging.id, { crossLinks: links.slice(20) });
  return { keeper, merging, input, links };
}

it('checks the union of cross-canvas references before writing and accepts exactly twenty distinct references', async () => {
  const { keeper, input, links } = crossLinkBoundary;
  const before = await store.getCanvas(canvasId, true);
  const history = await store.documentHistory(canvasId, keeper.id);
  await expect(store.mergeDocuments(canvasId, input)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('link limit') });
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
  expect(await store.documentHistory(canvasId, keeper.id)).toEqual(history);
  await store.updateBlock(canvasId, keeper.id, { crossLinks: links.slice(0, 19) });
  const merged = await store.mergeDocuments(canvasId, input);
  expect((await store.getCanvas(canvasId)).blocks.find(block => block.id === keeper.id)?.crossLinks).toEqual([...links.slice(0, 19), links[20]]);
  await store.undoMerge(merged.mergeId);
});

it.each(['missing', 'archived'])('refuses a %s merge source without changing content or history', async kind => {
  const { keeper, merging, input } = await documents();
  if (kind === 'archived') await store.updateBlock(canvasId, merging.id, { archived: true });
  const before = await store.getCanvas(canvasId, true);
  const mergeBlockIds = kind === 'missing' ? ['missing-source'] : [merging.id];
  await expect(store.mergeDocuments(canvasId, { ...input, mergeBlockIds })).rejects.toMatchObject({ status: 404 });
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
  expect(await readFile(path.join(directory, keeper.file), 'utf8')).toBe(keeper.content);
});

it('supports legacy journals without cross-canvas snapshots and surfaces corrupt journals without losing retryability', async () => {
  const { input } = await documents();
  const workspacesFile = path.join(directory, 'workspaces.json');
  const workspaces = await readFile(workspacesFile, 'utf8');
  await writeFile(workspacesFile, '[]');
  const merged = await store.mergeDocuments(canvasId, input);
  await writeFile(workspacesFile, workspaces);
  const file = path.join(directory, 'jev-merges', merged.mergeId + '.json');
  const journal = JSON.parse(await readFile(file, 'utf8'));
  delete journal.otherCanvases;
  await writeFile(file, '{invalid');
  await expect(store.undoMerge(merged.mergeId)).rejects.toBeInstanceOf(SyntaxError);
  await writeFile(file, JSON.stringify(journal));
  expect(await new CanvasStore(directory).undoMerge(merged.mergeId)).toEqual({ mergeId: merged.mergeId, reverted: true });
});

it.each(['removed keeper', 'external content edit'])('refuses Undo after a %s and leaves later work intact', async change => {
  const { keeper, input } = await documents();
  const merged = await store.mergeDocuments(canvasId, input);
  if (change === 'removed keeper') await store.deleteBlock(canvasId, keeper.id);
  else await writeFile(path.join(directory, keeper.file), '# Later external draft');
  const beforeUndo = await store.getCanvas(canvasId, true);
  await expect(store.undoMerge(merged.mergeId)).rejects.toMatchObject({ status: 409, message: 'Documents changed since the merge' });
  expect(await new CanvasStore(directory).getCanvas(canvasId, true)).toEqual(beforeUndo);
});

async function interruptedMerge() {
  const { keeper, merging, input } = await documents();
  const task = await store.createTask(canvasId, { title: 'Review', blockIds: [merging.id] }, 'Reviewer');
  const remote = await store.createCanvas((await store.getCanvas(canvasId)).workspaceId, { name: 'Inbound links' });
  const portal = await store.createBlock(remote.id, { title: 'Portal' });
  await store.updateBlock(remote.id, portal.id, { crossLinks: [{ canvasId, blockId: merging.id }] });
  const before = await store.getCanvas(canvasId, true);
  const referencesBefore = await store.getCanvas(remote.id);
  const tasksBefore = await store.listTasks(canvasId);
  const hook = path.join(directory, '.versions', keeper.id, '.git', 'hooks', 'post-commit');
  const lock = path.join(directory, '.versions', keeper.id, '.git', 'index.lock');
  const tasks = path.join(directory, 'tasks', canvasId + '.json');
  await writeFile(hook, `#!/bin/sh\n: > ${shellPath(lock)}\nmv ${shellPath(tasks)} ${shellPath(tasks + '.backup')}\nmkdir ${shellPath(tasks)}\n`, { mode: 0o755 });
  await expect(store.mergeDocuments(canvasId, input)).rejects.toBeInstanceOf(AggregateError);
  await rm(hook);
  await rm(lock);
  await rm(tasks, { recursive: true });
  await rename(tasks + '.backup', tasks);
  const [journalName] = await readdir(path.join(directory, 'jev-merges'));
  return { keeper, task, remote, portal, before, referencesBefore, tasksBefore,
    file: path.join(directory, 'jev-merges', journalName), mergeId: journalName.slice(0, -5) };
}

it('recovers an interrupted merge with its unchanged inbound reference snapshots and restores all files across restart', async () => {
  const { keeper, remote, portal, before, referencesBefore, tasksBefore, mergeId } = await interruptedMerge();
  expect((await new CanvasStore(directory).getCanvas(remote.id)).blocks.find(block => block.id === portal.id)?.crossLinks)
    .toEqual([{ canvasId, blockId: keeper.id }]);
  await new CanvasStore(directory).undoMerge(mergeId);
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(remote.id), referencesBefore);
  expectRestoredTasks(await new CanvasStore(directory).listTasks(canvasId), tasksBefore);
});

it.each(['canvas metadata', 'task comments', 'document content', 'removed keeper', 'inbound reference'])
  ('refuses interrupted-merge recovery after later edits to %s', async change => {
    const { keeper, task, remote, portal, file, mergeId } = await interruptedMerge();
    if (change === 'canvas metadata') await store.updateBlock(canvasId, keeper.id, { title: 'Later title' });
    if (change === 'task comments') await store.commentTask(canvasId, task.id, 'Later comment', 'Reviewer');
    if (change === 'document content') await writeFile(path.join(directory, keeper.file), '# Later draft');
    if (change === 'removed keeper') await store.deleteBlock(canvasId, keeper.id);
    if (change === 'inbound reference') await store.updateBlock(remote.id, portal.id, { title: 'Later portal title' });
    const beforeUndo = await store.getCanvas(canvasId, true);
    const journal = await readFile(file, 'utf8');
    await expect(new CanvasStore(directory).undoMerge(mergeId)).rejects.toMatchObject({ status: 409,
      message: expect.stringContaining('since the interrupted merge') });
    expect(await new CanvasStore(directory).getCanvas(canvasId, true)).toEqual(beforeUndo);
    expect(await readFile(file, 'utf8')).toBe(journal);
  });

it('recovers interrupted Undo across restart when document snapshots were restored but tasks still contain the applied merge', async () => {
  const { keeper, merging, input } = await documents();
  await store.createTask(canvasId, { title: 'Review', blockIds: [merging.id] }, 'Reviewer');
  const before = await store.getCanvas(canvasId, true);
  const tasksBefore = await store.listTasks(canvasId);
  const merged = await store.mergeDocuments(canvasId, input);
  const hook = path.join(directory, '.versions', keeper.id, '.git', 'hooks', 'post-commit');
  const lock = path.join(directory, '.versions', keeper.id, '.git', 'index.lock');
  const tasks = path.join(directory, 'tasks', canvasId + '.json');
  await writeFile(hook, `#!/bin/sh\n: > ${shellPath(lock)}\nmv ${shellPath(tasks)} ${shellPath(tasks + '.backup')}\nmkdir ${shellPath(tasks)}\n`, { mode: 0o755 });
  await expect(store.undoMerge(merged.mergeId)).rejects.toBeInstanceOf(AggregateError);
  await rm(hook);
  await rm(lock);
  await rm(tasks, { recursive: true });
  await rename(tasks + '.backup', tasks);
  const file = path.join(directory, 'jev-merges', merged.mergeId + '.json');
  const journal = JSON.parse(await readFile(file, 'utf8'));
  expect(journal.recovery).toBe('undo');
  delete journal.otherCanvases;
  await writeFile(file, JSON.stringify(journal));
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
  expect((await store.listTasks(canvasId))[0].blockIds).toEqual([keeper.id]);
  await new CanvasStore(directory).undoMerge(merged.mergeId);
  expectRestoredCanvas(await new CanvasStore(directory).getCanvas(canvasId, true), before);
  expectRestoredTasks(await store.listTasks(canvasId), tasksBefore);
});
