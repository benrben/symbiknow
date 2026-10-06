import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { DocumentLocks } from './coordination.js';
import { atomicJson, StorageFiles } from './storage-files.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-task-history-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const canvas = await store.createCanvas((await store.listWorkspaces())[0].id, { name: 'Tasks' });
  const document = await store.createBlock(canvas.id, { title: 'Reference', content: '# Reference' });
  return { root, store, canvas, document };
}

it('records create, board update, comment, and delete; guarded Undo restores references and dependent links after restart', async () => {
  const f = await fixture();
  const parent = await f.store.createTask(f.canvas.id, { title: 'Parent', blockIds: [f.document.id] }, 'Creator');
  const child = await f.store.createTask(f.canvas.id, { title: 'Child', dependsOnTaskIds: [parent.id] }, 'Creator');
  const moved = await f.store.updateTask(f.canvas.id, parent.id,
    { status: 'blocked', boardOrder: -1.5, expectedRevision: parent.revision }, 'Board user');
  const commented = await f.store.commentTask(f.canvas.id, parent.id, 'Waiting for review', 'Agent');
  await f.store.deleteTask(f.canvas.id, parent.id, 'Reviewer', commented.revision);
  expect((await f.store.listTasks(f.canvas.id)).find(item => item.id === child.id)?.dependsOnTaskIds).toEqual([]);
  const history = await f.store.listTaskHistory(f.canvas.id, parent.id);
  expect(history.items.map(item => item.kind)).toEqual(['deleted', 'commented', 'updated', 'created']);
  expect(history.items[0]).toMatchObject({ actor: 'Reviewer', before: { id: parent.id, blockIds: [f.document.id],
    comments: [expect.objectContaining({ text: 'Waiting for review' })] } });
  const restarted = new CanvasStore(f.root);
  await restarted.init();
  await expect(restarted.undoTask(f.canvas.id, parent.id, history.items[0].eventId!, commented.revision! + 1,
    'Wrong revision')).rejects.toMatchObject({ status: 409 });
  const restored = await restarted.undoTask(f.canvas.id, parent.id, history.items[0].eventId!, commented.revision!, 'Undo agent');
  expect(restored).toMatchObject({ id: parent.id, status: 'blocked', boardOrder: -1.5,
    blockIds: [f.document.id], comments: [expect.objectContaining({ text: 'Waiting for review' })] });
  expect(restored?.revision).toBeGreaterThan(commented.revision ?? 0);
  expect((await restarted.listTasks(f.canvas.id)).find(item => item.id === child.id)?.dependsOnTaskIds).toEqual([parent.id]);
  await expect(restarted.undoTask(f.canvas.id, parent.id, history.items[0].eventId!, restored!.revision!,
    'Stale Undo')).rejects.toMatchObject({ status: 409 });
  expect((await new CanvasStore(f.root).listTaskHistory(f.canvas.id, parent.id)).items[0]).toMatchObject({
    undoOf: history.items[0].eventId, actor: 'Undo agent' });
  expect(moved.boardOrder).toBe(-1.5);
});

it('repairs a committed task record whose audit append was interrupted', async () => {
  const f = await fixture();
  const task = await f.store.createTask(f.canvas.id, { title: 'Original' }, 'Creator');
  const tasksFile = path.join(f.root, 'tasks', `${f.canvas.id}.json`);
  const pendingFile = path.join(f.root, 'tasks', `${f.canvas.id}.pending.json`);
  const after = { ...task, title: 'Recovered', revision: (task.revision ?? 0) + 1,
    updatedAt: new Date().toISOString() };
  const event = { eventId: 'recovery-event', kind: 'updated', actor: 'Recovery fixture', at: after.updatedAt,
    taskId: task.id, before: task, after };
  await writeFile(pendingFile, JSON.stringify({ before: [task], after: [after], events: [event] }));
  await writeFile(tasksFile, JSON.stringify([after]));
  const reopened = new CanvasStore(f.root);
  await reopened.init();
  expect((await reopened.listTasks(f.canvas.id))[0].title).toBe('Recovered');
  expect((await reopened.listTaskHistory(f.canvas.id, task.id)).items[0]).toMatchObject(event);
  await expect(readFile(pendingFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reads legacy audit history and appends new records without rewriting it', async () => {
  const f = await fixture();
  const created = await f.store.createTask(f.canvas.id, { title: 'Legacy task' }, 'Creator');
  const auditJson = path.join(f.root, 'tasks', `${f.canvas.id}.audit.json`);
  const auditLog = path.join(f.root, 'tasks', `${f.canvas.id}.audit.jsonl`);
  const originalLog = await readFile(auditLog, 'utf8');
  const legacyEvents = JSON.parse(originalLog.trim()).events;
  await writeFile(auditJson, JSON.stringify(legacyEvents));
  await rm(auditLog);
  const changed = await f.store.updateTask(f.canvas.id, created.id, { title: 'Current task' }, 'Editor');
  const history = await new CanvasStore(f.root).listTaskHistory(f.canvas.id, created.id);
  expect(history.items.map(event => event.kind)).toEqual(['updated', 'created']);
  expect(history.items[0].after?.title).toBe(changed.title);
  expect(await readFile(auditJson, 'utf8')).toBe(JSON.stringify(legacyEvents));
  expect(await readFile(auditLog, 'utf8')).toContain('Current task');
});

it('repairs a torn audit tail and voids an uncommitted event after restart', async () => {
  const f = await fixture();
  const task = await f.store.createTask(f.canvas.id, { title: 'Unchanged task' }, 'Creator');
  const next = { ...task, title: 'Never committed', revision: (task.revision ?? 0) + 1,
    updatedAt: new Date().toISOString() };
  const event = { eventId: 'uncommitted-event', kind: 'updated', actor: 'Interrupted writer',
    at: next.updatedAt, taskId: task.id, before: task, after: next };
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const pendingFile = path.join(f.root, 'tasks', `${f.canvas.id}.pending.json`);
  const auditLog = path.join(f.root, 'tasks', `${f.canvas.id}.audit.jsonl`);
  await writeFile(pendingFile, JSON.stringify({ beforeHash: hash([task]), afterHash: hash([next]), events: [event] }));
  await writeFile(auditLog, `${await readFile(auditLog, 'utf8')}${JSON.stringify({ type: 'events', events: [event] })}\n{"type":"events"`);
  const reopened = new CanvasStore(f.root);
  await reopened.init();
  expect((await reopened.listTasks(f.canvas.id))[0]).toEqual(task);
  expect((await reopened.listTaskHistory(f.canvas.id, task.id)).items.map(item => item.kind)).toEqual(['created']);
  expect(await readFile(auditLog, 'utf8')).toContain('"type":"void"');
  await expect(readFile(pendingFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('waits for an active task writer before startup recovery examines its pending event', async () => {
  const f = await fixture();
  const task = await f.store.createTask(f.canvas.id, { title: 'Before' }, 'Creator');
  const after = { ...task, title: 'After', revision: (task.revision ?? 0) + 1,
    updatedAt: new Date().toISOString() };
  const event = { eventId: 'race-event', kind: 'updated', actor: 'Writer', at: after.updatedAt,
    taskId: task.id, before: task, after };
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const tasksFile = path.join(f.root, 'tasks', `${f.canvas.id}.json`);
  const pendingFile = path.join(f.root, 'tasks', `${f.canvas.id}.pending.json`);
  const auditLog = path.join(f.root, 'tasks', `${f.canvas.id}.audit.jsonl`);
  let writerPaused!: () => void;
  let releaseWriter!: () => void;
  const paused = new Promise<void>(resolve => { writerPaused = resolve; });
  const released = new Promise<void>(resolve => { releaseWriter = resolve; });
  const writer = new StorageFiles(f.root, new DocumentLocks()).serialize(async () => {
    await atomicJson(pendingFile, { beforeHash: hash([task]), afterHash: hash([after]), events: [event] });
    await writeFile(auditLog, `${await readFile(auditLog, 'utf8')}${JSON.stringify({ type: 'events', events: [event] })}\n`);
    writerPaused();
    await released;
    await atomicJson(tasksFile, [after]);
    await rm(pendingFile);
  });
  await paused;
  const reopened = new CanvasStore(f.root);
  let inspectedWorkspaces = false;
  const listWorkspaces = reopened.listWorkspaces.bind(reopened);
  reopened.listWorkspaces = async () => { inspectedWorkspaces = true; return listWorkspaces(); };
  const recovery = (reopened as unknown as { tasks: { recover: () => Promise<void> } }).tasks.recover();
  try {
    expect(inspectedWorkspaces).toBe(false);
  } finally {
    releaseWriter();
    await writer;
    await recovery;
  }
  await reopened.init();
  expect((await reopened.listTasks(f.canvas.id))[0].title).toBe('After');
  expect((await reopened.listTaskHistory(f.canvas.id, task.id)).items[0]).toMatchObject(event);
  expect(await readFile(auditLog, 'utf8')).not.toContain('"type":"void"');
});

it('journals an external task snapshot once and rejects a stale surrounding transaction', async () => {
  const f = await fixture();
  const task = await f.store.createTask(f.canvas.id, { title: 'Before' }, 'Creator');
  const after = { ...task, title: 'Moved reference', revision: (task.revision ?? 0) + 1,
    updatedAt: new Date().toISOString() };
  const tasks = (f.store as unknown as { tasks: {
    writeTaskSnapshot: (canvasId: string, before: typeof task[], after: typeof task[], actor: string) => Promise<void>,
  } }).tasks;
  await tasks.writeTaskSnapshot(f.canvas.id, [task], [after], 'Document move');
  await tasks.writeTaskSnapshot(f.canvas.id, [task], [after], 'Replay');
  const history = await f.store.listTaskHistory(f.canvas.id, task.id);
  expect(history.items.map(item => item.actor)).toEqual(['Document move', 'Creator']);
  const newer = { ...after, title: 'Conflicting move' };
  await expect(tasks.writeTaskSnapshot(f.canvas.id, [task], [newer], 'Stale writer'))
    .rejects.toMatchObject({ status: 409 });
  expect((await f.store.listTasks(f.canvas.id))[0].title).toBe('Moved reference');
});
