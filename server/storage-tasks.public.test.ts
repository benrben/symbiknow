import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import type { CanvasDocument, CanvasTask } from '../shared/types.js';
import { blockStateHash } from './block-state.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const roots: string[] = [];
const servers: Server[] = [];
type ErrorBody = { error: string };

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function api(root: string): Promise<string> {
  const server = await createApiServer({ dataDir: root });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native API address');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-storage-tasks-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Task boundaries' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Task sources' });
  const document = await store.createBlock(canvas.id, { title: 'Source', content: '# Source\nReview this document.' });
  return { root, store, canvas, document, tasksFile: path.join(root, 'tasks', canvas.id + '.json'),
    canvasFile: path.join(root, 'canvases', canvas.id + '.json'), tasksRoute: `/api/canvases/${canvas.id}/tasks` };
}

async function call<T>(base: string, route: string, method = 'GET', body?: unknown, actor = 'Task reviewer') {
  const response = await fetch(base + route, { method,
    headers: { 'content-type': 'application/json', 'x-symbiknow-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as T };
}

let capacityFixture: Awaited<ReturnType<typeof fixture>>;
let capacityTasks: CanvasTask[];
beforeAll(async () => {
  const f = await fixture();
  const first = await f.store.createTask(f.canvas.id, { title: 'First prerequisite', blockIds: [f.document.id] }, 'Creator');
  const other = await f.store.createTask(f.canvas.id, { title: 'Other prerequisite' }, 'Creator');
  const child = await f.store.createTask(f.canvas.id, { title: 'Dependent task', dependsOnTaskIds: [first.id, other.id] }, 'Creator');
  const created = await Promise.all(Array.from({ length: 496 }, (_, index) => f.store.createTask(f.canvas.id,
    { title: `Task ${index + 4}`, blockIds: [f.document.id] }, 'Concurrent creator')));
  capacityFixture = f; capacityTasks = [first, other, child, ...created];
}, 20000);

it('accepts 500 public creations, refuses the 501st without writes and recovers through reviewed edits, dependency deletion and retry after restart', async () => {
  const f = capacityFixture;
  const [first, other, child, ...created] = capacityTasks;
  created.push(await f.store.createTask(f.canvas.id, { title: 'Task 500', blockIds: [f.document.id] }, 'Concurrent creator'));
  const base = await api(f.root);
  const before = await f.store.listTasks(f.canvas.id);
  expect(before).toEqual([first, other, child, ...created]);
  expect(new Set(before.map(task => task.id)).size).toBe(500);
  expect((await call<CanvasTask[]>(base, f.tasksRoute)).data).toEqual(before);
  const savedTasks = await readFile(f.tasksFile, 'utf8');
  const savedCanvas = await readFile(f.canvasFile, 'utf8');
  const savedSource = await readFile(path.join(f.root, f.document.file), 'utf8');
  const history = await f.store.documentHistory(f.canvas.id, f.document.id);
  const rejected = await call<ErrorBody>(base, f.tasksRoute, 'POST', {
    title: 'Task 501', blockIds: [f.document.id], dependsOnTaskIds: [first.id],
  });
  expect(rejected).toEqual({ status: 400, data: { error: 'A canvas can hold at most 500 tasks' } });
  expect(await readFile(f.tasksFile, 'utf8')).toBe(savedTasks);
  expect(await readFile(f.canvasFile, 'utf8')).toBe(savedCanvas);
  expect(await readFile(path.join(f.root, f.document.file), 'utf8')).toBe(savedSource);
  expect(await new CanvasStore(f.root).listTasks(f.canvas.id)).toEqual(before);
  expect(await new CanvasStore(f.root).getCanvas(f.canvas.id)).toEqual(await f.store.getCanvas(f.canvas.id));
  const edited = await call<CanvasTask>(base, `${f.tasksRoute}/${child.id}`, 'PUT', {
    title: 'Reviewed dependent task', expectedUpdatedAt: child.updatedAt,
    expectedSourceStateHashes: { [f.document.id]: blockStateHash(f.document) },
  });
  expect(edited.status).toBe(200);
  expect(edited.data).toMatchObject({ title: 'Reviewed dependent task', dependsOnTaskIds: [first.id, other.id], updatedBy: 'Task reviewer' });
  expect((await call(base, `${f.tasksRoute}/${first.id}`, 'DELETE')).status).toBe(200);
  const remaining = await new CanvasStore(f.root).listTasks(f.canvas.id);
  expect(remaining).toEqual([other, { ...edited.data, dependsOnTaskIds: [other.id], revision: (edited.data.revision ?? 0) + 1,
    updatedAt: expect.any(String) }, ...created]);
  expect(remaining).toHaveLength(499);
  const restarted = await api(f.root);
  const retry = await call<CanvasTask>(restarted, f.tasksRoute, 'POST', {
    title: 'Task 501', blockIds: [f.document.id], dependsOnTaskIds: [other.id],
  }, 'Retry creator');
  expect(retry.status).toBe(201);
  expect(retry.data).toMatchObject({ title: 'Task 501', blockIds: [f.document.id], dependsOnTaskIds: [other.id], createdBy: 'Retry creator' });
  const final = await new CanvasStore(f.root).listTasks(f.canvas.id);
  expect(final).toEqual([...remaining, retry.data]);
  expect(final).toHaveLength(500);
  expect(JSON.parse(await readFile(f.tasksFile, 'utf8'))).toEqual(final);
  expect(await readFile(f.canvasFile, 'utf8')).toBe(savedCanvas);
  expect(await readFile(path.join(f.root, f.document.file), 'utf8')).toBe(savedSource);
  expect(await new CanvasStore(f.root).documentHistory(f.canvas.id, f.document.id)).toEqual(history);
});

it('returns an empty list before creation and restores normal public writes after malformed persisted JSON is repaired', async () => {
  const f = await fixture();
  expect(await f.store.listTasks(f.canvas.id)).toEqual([]);
  await expect(readFile(f.tasksFile)).rejects.toMatchObject({ code: 'ENOENT' });
  const task = await f.store.createTask(f.canvas.id, { title: 'Saved task' }, 'Creator');
  const original = await readFile(f.tasksFile, 'utf8');
  await writeFile(f.tasksFile, '{');
  await expect(f.store.listTasks(f.canvas.id)).rejects.toBeInstanceOf(SyntaxError);
  const base = await api(f.root);
  const failed = await call<ErrorBody>(base, f.tasksRoute, 'POST', { title: 'Not persisted' });
  expect(failed.status).toBe(500);
  expect(failed.data.error).toBeTruthy();
  expect(await readFile(f.tasksFile, 'utf8')).toBe('{');
  await writeFile(f.tasksFile, original);
  const retry = await call<CanvasTask>(base, f.tasksRoute, 'POST', { title: 'Recovered task' });
  expect(retry.status).toBe(201);
  expect(await new CanvasStore(f.root).listTasks(f.canvas.id)).toEqual([task, retry.data]);
});

it('rejects dependency cycles and missing tasks without mutation, then cleans dependencies on deletion through native HTTP', async () => {
  const f = await fixture();
  const base = await api(f.root);
  const first = await f.store.createTask(f.canvas.id, { title: 'First task' }, 'Creator');
  const second = await f.store.createTask(f.canvas.id, { title: 'Second task', dependsOnTaskIds: [first.id] }, 'Creator');
  const independent = await f.store.createTask(f.canvas.id, { title: 'Independent task' }, 'Creator');
  const before = await readFile(f.tasksFile, 'utf8');
  const cycle = await call<ErrorBody>(base, `${f.tasksRoute}/${first.id}`, 'PUT', { dependsOnTaskIds: [second.id] });
  expect(cycle).toEqual({ status: 400, data: { error: 'Task dependencies cannot form a cycle' } });
  const missingEdit = await call<ErrorBody>(base, `${f.tasksRoute}/missing-task`, 'PUT', { title: 'Missing' });
  expect(missingEdit).toEqual({ status: 404, data: { error: 'Task not found' } });
  expect((await call<ErrorBody>(base, `${f.tasksRoute}/missing-task`, 'DELETE')).status).toBe(404);
  expect(await readFile(f.tasksFile, 'utf8')).toBe(before);
  expect((await call(base, `${f.tasksRoute}/${first.id}`, 'DELETE')).status).toBe(200);
  const remaining = await new CanvasStore(f.root).listTasks(f.canvas.id);
  expect(remaining).toEqual([{ ...second, dependsOnTaskIds: [], revision: (second.revision ?? 0) + 1, updatedAt: expect.any(String) }, independent]);
  expect((await call<CanvasTask[]>(await api(f.root), f.tasksRoute)).data).toEqual(remaining);
});

it('enforces current task and source reviews before mutation and accepts the corrected public retry', async () => {
  const f = await fixture();
  const task = await f.store.createTask(f.canvas.id, { title: 'Reviewed task', blockIds: [f.document.id] }, 'Creator');
  const base = await api(f.root);
  const before = await readFile(f.tasksFile, 'utf8');
  const staleTask = await call<ErrorBody>(base, `${f.tasksRoute}/${task.id}`, 'PUT', { title: 'Stale task', expectedUpdatedAt: 'old' });
  expect(staleTask).toEqual({ status: 409, data: { error: 'The task changed since this suggestion was reviewed' } });
  for (const value of [null, 'invalid', []]) {
    const invalid = await call<ErrorBody>(base, `${f.tasksRoute}/${task.id}`, 'PUT', { title: 'Invalid review', expectedSourceStateHashes: value });
    expect(invalid).toEqual({ status: 409, data: { error: 'A source document changed since this suggestion was reviewed' } });
  }
  await f.store.updateBlock(f.canvas.id, f.document.id, { title: 'Changed source' }, 'Human');
  const staleSource = await call<ErrorBody>(base, `${f.tasksRoute}/${task.id}`, 'PUT', {
    title: 'Stale source', expectedUpdatedAt: task.updatedAt, expectedSourceStateHashes: { [f.document.id]: blockStateHash(f.document) },
  });
  expect(staleSource.status).toBe(409);
  expect(await readFile(f.tasksFile, 'utf8')).toBe(before);
  const current = (await call<CanvasDocument>(base, `/api/canvases/${f.canvas.id}`)).data.blocks[0];
  const retry = await call<CanvasTask>(base, `${f.tasksRoute}/${task.id}`, 'PUT', {
    title: 'Current review', expectedUpdatedAt: task.updatedAt, expectedSourceStateHashes: { [current.id]: blockStateHash(current) },
  });
  expect(retry.status).toBe(200);
  expect((await new CanvasStore(f.root).listTasks(f.canvas.id))[0]).toEqual(retry.data);
  expect((await new CanvasStore(f.root).getCanvas(f.canvas.id)).blocks[0]).toMatchObject({ title: 'Changed source' });
});

it('rejects cross-canvas findings before creation and persists claim, forced takeover and comments through restart', async () => {
  const f = await fixture();
  const base = await api(f.root);
  const foreign = await call<ErrorBody>(base, f.tasksRoute, 'POST', { title: 'Foreign task', findingRef: { canvasId: 'another-canvas' } });
  expect(foreign).toEqual({ status: 400, data: { error: 'findingRef must belong to this canvas' } });
  expect(await f.store.listTasks(f.canvas.id)).toEqual([]);
  const task = await f.store.createTask(f.canvas.id, { title: 'Owned task' }, 'Creator');
  const claimed = await call<CanvasTask>(base, `${f.tasksRoute}/${task.id}/claim`, 'POST', {}, 'Owner');
  expect(claimed.status).toBe(200);
  expect((await call<ErrorBody>(base, `${f.tasksRoute}/${task.id}/claim`, 'POST', {}, 'Other')).status).toBe(409);
  const transferred = await call<CanvasTask>(base, `${f.tasksRoute}/${task.id}/claim`, 'POST', { force: true }, 'Other');
  expect(transferred.status).toBe(200);
  const commented = await call<CanvasTask>(base, `${f.tasksRoute}/${task.id}/comments`, 'POST', { text: ' Reviewed source ' }, 'Reviewer');
  expect(commented.status).toBe(200);
  expect(commented.data).toMatchObject({ assignee: 'Other', status: 'in_progress', comments: [{ author: 'Reviewer', text: 'Reviewed source' }] });
  expect((await call<CanvasTask[]>(await api(f.root), f.tasksRoute)).data).toEqual([commented.data]);
  expect(await new CanvasStore(f.root).listTasks(f.canvas.id)).toEqual([commented.data]);
  expect((await call<CanvasTask[]>(base, '/api/canvases/missing-canvas/tasks')).status).toBe(404);
});
