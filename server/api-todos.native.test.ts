import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasTask } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const fixtures: Array<{ server: Server; root: string }> = [];
type ErrorBody = { error: string };

beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
});

afterEach(async () => {
  for (const { server, root } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-native-todos-'));
  const server = await createApiServer({ dataDir: root });
  fixtures.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native API address');
  return { root, base: `http://127.0.0.1:${address.port}`, route: '/api/canvases/product-roadmap/todos',
    store: new CanvasStore(root) };
}

async function call<T>(base: string, route: string, method = 'GET', input?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + route, { method,
    headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Todo owner', ...headers },
    body: input === undefined ? undefined : JSON.stringify(input) });
  return { status: response.status, body: await response.json() as T };
}

it('persists planning fields, automatically archives completed tasks, and reopens them through native HTTP', async () => {
  const f = await fixture();
  expect(await call<CanvasTask[]>(f.base, f.route)).toEqual({ status: 200, body: [] });
  const created = await call<CanvasTask>(f.base, f.route, 'POST', {
    title: 'בדיקת השקה', detail: 'Review the launch checklist', priority: 'urgent', size: 'l', dueDate: '2028-02-29',
    assignee: 'Design team', id: 'client-id', revision: 500, createdBy: 'Spoofed', updatedBy: 'Spoofed',
    createdAt: '1900-01-01', updatedAt: '1900-01-01', comments: [{ text: 'Injected' }],
  });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ title: 'בדיקת השקה', detail: 'Review the launch checklist', status: 'todo',
    priority: 'urgent', size: 'l', dueDate: '2028-02-29', assignee: 'Design team', revision: 1,
    createdBy: 'Todo owner', updatedBy: 'Todo owner', comments: [] });
  expect(created.body.id).not.toBe('client-id');
  expect(created.body.createdAt).not.toBe('1900-01-01');
  const route = `${f.route}/${created.body.id}`;
  let task = created.body;
  for (const status of ['in_progress', 'blocked', 'done'] as const) {
    const changed = await call<CanvasTask>(f.base, route, 'PUT', { status, expectedRevision: task.revision });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ id: task.id, status, revision: task.revision! + 1, priority: 'urgent', size: 'l' });
    task = changed.body;
  }
  const archived = (await call<CanvasTask[]>(f.base, f.route)).body.filter(item => item.status === 'done');
  expect(archived).toEqual([task]);
  const fresh = new CanvasStore(f.root);
  await fresh.init();
  expect(await fresh.listTasks('product-roadmap')).toEqual([task]);
  const reopened = await call<CanvasTask>(f.base, route, 'PUT', { status: 'todo', dueDate: null, size: 'xs',
    priority: 'low', detail: 'Follow-up work', assignee: 'Reviewer', expectedRevision: task.revision },
  { 'x-symbiknow-actor': 'Reopening reviewer' });
  expect(reopened.status).toBe(200);
  expect(reopened.body).toMatchObject({ status: 'todo', size: 'xs', priority: 'low', detail: 'Follow-up work',
    assignee: 'Reviewer', createdBy: 'Todo owner', updatedBy: 'Reopening reviewer' });
  expect(reopened.body.dueDate).toBeUndefined();
  expect((await call<CanvasTask[]>(f.base, f.route)).body.filter(item => item.status === 'done')).toEqual([]);
  expect(await new CanvasStore(f.root).listTasks('product-roadmap')).toEqual([reopened.body]);
  const cleared = await call<CanvasTask>(f.base, route, 'PUT', { size: null, priority: null, dueDate: '',
    expectedRevision: reopened.body.revision });
  expect(cleared.status).toBe(200);
  expect(cleared.body.size).toBeUndefined();
  expect(cleared.body.priority).toBeUndefined();
  expect(cleared.body.dueDate).toBeUndefined();
  expect(await new CanvasStore(f.root).listTasks('product-roadmap')).toEqual([cleared.body]);
});

it('validates planning fields before writing and accepts every priority and task size', async () => {
  const f = await fixture();
  for (const input of [{ title: '' }, { title: 'Invalid', status: 'archived' }, { title: 'Invalid', priority: 'critical' },
    { title: 'Invalid', size: 'xxl' }, { title: 'Invalid', size: 5 }, { title: 'Invalid', dueDate: '2027-02-29' },
    { title: 'Invalid', dueDate: 'tomorrow' }, { title: 'Invalid', dueDate: 123 }]) {
    const failed = await call<ErrorBody>(f.base, f.route, 'POST', input);
    expect(failed.status, JSON.stringify(input)).toBe(400);
    expect(failed.body.error).toEqual(expect.any(String));
  }
  expect(await f.store.listTasks('product-roadmap')).toEqual([]);
  const values = [ ['low', 'xs'], ['normal', 's'], ['high', 'm'], ['urgent', 'l'], ['normal', 'xl'] ];
  for (const [priority, size] of values) {
    const created = await call<CanvasTask>(f.base, f.route, 'POST', { title: `${priority} / ${size}`, priority, size });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ priority, size });
  }
  const task = (await f.store.listTasks('product-roadmap'))[0];
  for (const patch of [{ priority: 'critical' }, { size: 'xxl' }, { dueDate: '2026-13-01' }, { status: 'archived' }]) {
    expect((await call<ErrorBody>(f.base, `${f.route}/${task.id}`, 'PUT', { ...patch, expectedRevision: task.revision })).status).toBe(400);
  }
  expect((await new CanvasStore(f.root).listTasks('product-roadmap'))[0]).toEqual(task);
});

it('refuses blind and stale edits while allowing a reviewed retry without losing the accepted update', async () => {
  const f = await fixture();
  const task = (await call<CanvasTask>(f.base, f.route, 'POST', { title: 'Concurrent task' })).body;
  const route = `${f.route}/${task.id}`;
  for (const revision of [undefined, null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const failed = await call<ErrorBody>(f.base, route, 'PUT', { title: 'Blind overwrite', expectedRevision: revision });
    expect(failed).toEqual({ status: 400, body: { error: 'expectedRevision must be a non-negative integer' } });
  }
  expect(await f.store.listTasks('product-roadmap')).toEqual([task]);
  const accepted = await call<CanvasTask>(f.base, route, 'PUT', { title: 'Accepted update', expectedRevision: task.revision });
  expect(accepted.status).toBe(200);
  const stale = await call<ErrorBody>(f.base, route, 'PUT', { status: 'done', expectedRevision: task.revision });
  expect(stale).toEqual({ status: 409, body: { error: 'The task changed since this suggestion was reviewed' } });
  expect(await new CanvasStore(f.root).listTasks('product-roadmap')).toEqual([accepted.body]);
  const retry = await call<CanvasTask>(f.base, route, 'PUT', { status: 'done', expectedRevision: accepted.body.revision });
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({ title: 'Accepted update', status: 'done' });
});

it('preserves authentication and opaque-origin protections for todo reads and writes', async () => {
  const f = await fixture();
  const task = (await call<CanvasTask>(f.base, f.route, 'POST', { title: 'Protected task' })).body;
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'todo-secret');
  const attempts = [ ['GET', f.route, undefined], ['POST', f.route, { title: 'Unauthorized' }],
    ['PUT', `${f.route}/${task.id}`, { status: 'done', expectedRevision: task.revision }] ] as const;
  for (const [method, route, input] of attempts) {
    expect(await call<ErrorBody>(f.base, route, method, input)).toEqual({ status: 401,
      body: { error: 'Sign in with the workspace access token' } });
  }
  const headers = { authorization: 'Bearer todo-secret' };
  expect((await call<CanvasTask[]>(f.base, f.route, 'GET', undefined, headers)).body).toEqual([task]);
  const blocked = await call<ErrorBody>(f.base, `${f.route}/${task.id}`, 'PUT', { status: 'done', expectedRevision: task.revision },
    { ...headers, origin: 'null' });
  expect(blocked).toEqual({ status: 403, body: { error: 'Requests from sandboxed documents are not allowed' } });
  expect(await new CanvasStore(f.root).listTasks('product-roadmap')).toEqual([task]);
  expect((await call<CanvasTask>(f.base, `${f.route}/${task.id}`, 'PUT', { status: 'done', expectedRevision: task.revision }, headers)).status).toBe(200);
});

it('reports absent resources and invalid identifiers without exposing retired task routes or mutating data', async () => {
  const f = await fixture();
  const missing = '/api/canvases/missing-canvas/todos';
  for (const [method, route, input] of [['GET', missing], ['POST', missing, { title: 'Missing canvas' }],
    ['PUT', `${missing}/missing-task`, { status: 'done', expectedRevision: 0 }]] as const) {
    expect(await call<ErrorBody>(f.base, route, method, input)).toEqual({ status: 404, body: { error: 'Canvas not found' } });
  }
  expect(await call<ErrorBody>(f.base, `${f.route}/missing-task`, 'PUT', { status: 'done', expectedRevision: 0 }))
    .toEqual({ status: 404, body: { error: 'Task not found' } });
  for (const route of ['/api/canvases/%E0%A4/todos', '/api/canvases/product%2Froadmap/todos']) {
    expect(await call<ErrorBody>(f.base, route)).toEqual({ status: 400, body: { error: 'Invalid todo identifier' } });
  }
  expect((await call<CanvasTask[]>(f.base, '/api/canvases/%70roduct-roadmap/todos')).status).toBe(200);
  expect(await call<ErrorBody>(f.base, `${f.route}/%ZZ`, 'PUT', { status: 'done', expectedRevision: 0 }))
    .toEqual({ status: 400, body: { error: 'Invalid todo identifier' } });
  for (const [method, route] of [['DELETE', f.route], ['PATCH', f.route], ['GET', `${f.route}/missing-task`],
    ['GET', '/api/canvases/product-roadmap/tasks']] as const) {
    expect(await call<ErrorBody>(f.base, route, method)).toEqual({ status: 404, body: { error: 'Route not found' } });
  }
  expect(await f.store.listTasks('product-roadmap')).toEqual([]);
});

it('refuses malformed and non-JSON input and remains usable after the caller corrects the body', async () => {
  const f = await fixture();
  const form = await fetch(f.base + f.route, { method: 'POST', body: 'title=Unsafe' });
  expect(form.status).toBe(415);
  expect(await form.json()).toEqual({ error: 'Send the request body as application/json' });
  for (const method of ['POST', 'PUT']) {
    const route = method === 'POST' ? f.route : `${f.route}/missing-task`;
    for (const body of ['{', 'null', '[]', '"text"']) {
      const malformed = await fetch(f.base + route, { method, headers: { 'content-type': 'application/json' }, body });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: 'Expected a JSON object' });
    }
  }
  expect(await f.store.listTasks('product-roadmap')).toEqual([]);
  const corrected = await call<CanvasTask>(f.base, f.route, 'POST', { title: 'Corrected body' });
  expect(corrected.status).toBe(201);
  expect((await new CanvasStore(f.root).listTasks('product-roadmap'))[0].id).toBe(corrected.body.id);
});
