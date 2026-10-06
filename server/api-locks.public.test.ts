import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument, DocumentLock } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const roots: string[] = [];
const servers: Server[] = [];
type ErrorBody = { error: string };

beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-native-locks-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Manual workspace' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Manual canvas' });
  const server = await createApiServer({ dataDir: root });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native API address');
  return { root, store, canvas, base: `http://127.0.0.1:${address.port}`,
    document: (title: string) => store.createBlock(canvas.id, { title, content: '# ' + title }) };
}

async function call<T>(base: string, route: string, method = 'GET', body?: unknown, actor = 'Reviewer') {
  const response = await fetch(base + route, { method,
    headers: { 'content-type': 'application/json', 'x-symbiknow-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as T };
}

it('keeps existing task data inaccessible from the removed HTTP routes', async () => {
  const f = await fixture();
  const task = await f.store.createTask(f.canvas.id, { title: 'Archived task' }, 'Original owner');
  const tasksRoute = `/api/canvases/${f.canvas.id}/tasks`;
  for (const [method, route, body] of [
    ['GET', tasksRoute],
    ['POST', tasksRoute, { title: 'New task' }],
    ['GET', `${tasksRoute}/${task.id}/history`],
    ['POST', `${tasksRoute}/${task.id}/undo`, { eventId: 'old', expectedRevision: 1 }],
    ['PUT', `${tasksRoute}/${task.id}`, { title: 'Changed' }],
    ['DELETE', `${tasksRoute}/${task.id}`],
    ['POST', `${tasksRoute}/${task.id}/claim`, {}],
    ['POST', `${tasksRoute}/${task.id}/comments`, { text: 'Changed' }],
  ] as const) {
    expect(await call<ErrorBody>(f.base, route, method, body)).toEqual({ status: 404, body: { error: 'Route not found' } });
  }
  expect(JSON.parse(await readFile(path.join(f.root, 'tasks', f.canvas.id + '.json'), 'utf8'))).toEqual([task]);
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
