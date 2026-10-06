import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument, CanvasTask, DocumentLock } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const roots: string[] = [];
const restarts: Server[] = [];
type ErrorBody = { error: string };
type Fixture = Awaited<ReturnType<typeof fixture>>;

beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
});

afterEach(async () => {
  for (const server of restarts.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function restart(f: { root: string }): Promise<string> {
  const server = await createApiServer({ dataDir: f.root });
  restarts.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native restarted API address');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-native-tasks-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Manual task workspace' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Manual task canvas' });
  const base = await restart({ root });
  return { root, store, canvas, base, document: (title: string) => store.createBlock(canvas.id, { title, content: '# ' + title }) };
}

async function call<T>(base: string, route: string, method = 'GET', body?: unknown, actor = 'Task reviewer',
  extraHeaders: Record<string, string> = {}) {
  const response = await fetch(base + route, { method,
    headers: { 'content-type': 'application/json', 'x-symbiknow-actor': actor, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as T };
}

function routes(f: Fixture) {
  return { tasks: `/api/canvases/${f.canvas.id}/tasks` };
}

it('preserves task CRUD and exact boolean claim defaults through native actor conflicts, disk readback, restart and deletion', async () => {
  const f = await fixture();
  const document = await f.document('Launch checklist');
  const { tasks } = routes(f);
  expect((await call<CanvasTask[]>(f.base, tasks)).body).toEqual([]);
  const created = await call<CanvasTask>(f.base, tasks, 'POST', { title: 'Launch readiness', blockIds: [document.id] }, 'First owner');
  expect(created.status).toBe(201);
  const task = created.body;
  const updated = await call<CanvasTask>(f.base, `${tasks}/${task.id}`, 'PUT', { detail: 'Public task update' }, 'Reviewer');
  expect(updated.status).toBe(200);
  const commented = await call<CanvasTask>(f.base, `${tasks}/${task.id}/comments`, 'POST', { text: 'Manual review comment' }, 'Comment author');
  expect(commented.status).toBe(200);
  expect(commented.body.comments).toEqual([{ author: 'Comment author', text: 'Manual review comment', createdAt: expect.any(String) }]);
  expect((await call<CanvasTask>(f.base, `${tasks}/${task.id}/claim`, 'POST', {}, 'First owner')).status).toBe(200);
  expect((await call<ErrorBody>(f.base, `${tasks}/${task.id}/claim`, 'POST', { force: 'true' }, 'Second owner')).status).toBe(409);
  const claimed = await call<CanvasTask>(f.base, `${tasks}/${task.id}/claim`, 'POST', { force: true }, 'Second owner');
  expect(claimed.status).toBe(200);
  expect(claimed.body).toMatchObject({ assignee: 'Second owner', status: 'in_progress', updatedBy: 'Second owner' });
  const restarted = new CanvasStore(f.root);
  expect((await restarted.listTasks(f.canvas.id))[0]).toMatchObject({ detail: 'Public task update', assignee: 'Second owner', createdBy: 'First owner' });
  expect((await restarted.listTasks(f.canvas.id))[0].comments).toEqual(commented.body.comments);
  expect((await call<CanvasTask[]>(await restart(f), tasks)).body).toEqual(await restarted.listTasks(f.canvas.id));
  const deleted = await call<{ ok: boolean }>(f.base, `${tasks}/${task.id}`, 'DELETE');
  expect(deleted.status).toBe(200);
  expect(deleted.body).toEqual({ ok: true });
  expect(await new CanvasStore(f.root).listTasks(f.canvas.id)).toEqual([]);
  expect(JSON.parse(await readFile(path.join(f.root, 'tasks', f.canvas.id + '.json'), 'utf8'))).toEqual([]);
});

it('keeps native lock ownership and force query presence intact and leaves released document edits durable in Git', async () => {
  const f = await fixture();
  const document = await f.document('Launch checklist');
  const route = `/api/canvases/${f.canvas.id}/blocks/${document.id}`;
  const acquired = await call<DocumentLock>(f.base, route + '/lock', 'POST', { note: 'Native review' }, 'Lock owner');
  expect(acquired.status).toBe(200);
  expect(acquired.body.owner).toBe('Lock owner');
  expect((await call<ErrorBody>(f.base, route, 'PUT', { content: '# Blocked write' }, 'Another owner')).status).toBe(423);
  expect((await call<ErrorBody>(f.base, route + '/lock', 'DELETE', undefined, 'Another owner')).status).toBe(409);
  expect((await call<{ ok: boolean }>(f.base, route + '/lock?force=false', 'DELETE', undefined, 'Another owner')).body).toEqual({ ok: true });
  expect((await call<CanvasBlock>(f.base, route, 'PUT', { content: '# Accepted after release' }, 'Another owner')).status).toBe(200);
  expect((await call<CanvasDocument>(f.base, `/api/canvases/${f.canvas.id}`)).body.blocks[0].lock).toBeUndefined();
  expect((await new CanvasStore(f.root).documentHistory(f.canvas.id, document.id)).commits[0].author).toBe('Another owner');
});

it('filters and pages task records without changing the legacy unfiltered response or leaking unauthorized reads', async () => {
  const f = await fixture();
  const { tasks } = routes(f);
  const first = await call<CanvasTask>(f.base, tasks, 'POST', { title: 'First todo', assignee: 'Alex' });
  const second = await call<CanvasTask>(f.base, tasks, 'POST', { title: 'Second todo', assignee: 'Alex' });
  const blocked = await call<CanvasTask>(f.base, tasks, 'POST', { title: 'Blocked task', status: 'blocked', assignee: 'Sam' });
  expect([first.status, second.status, blocked.status]).toEqual([201, 201, 201]);
  expect((await call<CanvasTask[]>(f.base, tasks)).body.map(task => task.id))
    .toEqual([first.body.id, second.body.id, blocked.body.id]);
  const page = await call<{ items: CanvasTask[]; nextCursor?: string }>(f.base, `${tasks}?status=todo&assignee=Alex&limit=1`);
  expect(page).toMatchObject({ status: 200, body: { items: [{ id: first.body.id }], nextCursor: '1' } });
  const later = await call<typeof page.body>(f.base, `${tasks}?status=todo&assignee=Alex&limit=1&cursor=${page.body.nextCursor}`);
  expect(later).toMatchObject({ status: 200, body: { items: [{ id: second.body.id }] } });
  expect(later.body.nextCursor).toBeUndefined();
  expect((await call<typeof page.body>(f.base, `${tasks}?assignee=Sam`)).body.items.map(task => task.id))
    .toEqual([blocked.body.id]);
  for (const query of ['status=unknown', 'limit=0', 'limit=101', 'limit=1.5', 'limit=word',
    'cursor=-1', 'cursor=1.5', 'cursor=word']) {
    expect((await call<ErrorBody>(f.base, `${tasks}?${query}`)).status, query).toBe(400);
  }
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'offline-task-fixture-secret');
  expect((await call<ErrorBody>(f.base, tasks)).status).toBe(401);
  expect((await call<CanvasTask[]>(f.base, tasks, 'GET', undefined, 'Reader',
    { authorization: 'Bearer offline-task-fixture-secret' })).body).toHaveLength(3);
});

it('validates task history, Undo and guarded deletion before changing durable records', async () => {
  const f = await fixture();
  const { tasks } = routes(f);
  const created = await call<CanvasTask>(f.base, tasks, 'POST', { title: 'Guarded task' });
  const id = created.body.id;
  const updated = await call<CanvasTask>(f.base, `${tasks}/${id}`, 'PUT',
    { title: 'Reviewed task', expectedRevision: created.body.revision });
  expect(updated.status).toBe(200);
  const history = await call<{ items: Array<{ eventId: string }>; nextCursor?: string }>(f.base,
    `${tasks}/${id}/history?limit=1`);
  expect(history).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ eventId: expect.any(String) })],
    nextCursor: '1' } });
  expect((await call<typeof history.body>(f.base, `${tasks}/${id}/history?limit=1&cursor=1`)).body.items).toHaveLength(1);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=-1', 'cursor=word']) {
    expect((await call<ErrorBody>(f.base, `${tasks}/${id}/history?${query}`)).status, query).toBe(400);
  }
  for (const body of [{}, { eventId: '' }, { eventId: history.body.items[0].eventId, expectedRevision: -1 },
    { eventId: history.body.items[0].eventId, expectedRevision: 1.5 }]) {
    expect((await call<ErrorBody>(f.base, `${tasks}/${id}/undo`, 'POST', body)).status).toBe(400);
  }
  expect((await call<ErrorBody>(f.base, `${tasks}/${id}/undo`, 'POST', {
    eventId: history.body.items[0].eventId, expectedRevision: created.body.revision })).status).toBe(409);
  for (const expectedRevision of [-1, 1.5, 'stale']) {
    expect((await call<ErrorBody>(f.base, `${tasks}/${id}`, 'DELETE', { expectedRevision })).status).toBe(400);
  }
  expect((await call<ErrorBody>(f.base, `${tasks}/${id}`, 'DELETE',
    { expectedRevision: created.body.revision })).status).toBe(409);
  expect((await call<{ ok: boolean }>(f.base, `${tasks}/${id}`, 'DELETE',
    { expectedRevision: updated.body.revision })).body).toEqual({ ok: true });
  expect((await new CanvasStore(f.root).listTasks(f.canvas.id))).toEqual([]);
  expect((await new CanvasStore(f.root).listTaskHistory(f.canvas.id, id)).items[0]).toMatchObject({ kind: 'deleted' });
});
