import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CanvasTask } from '../shared/types.js';
import { createApiServer } from './index.js';
import { createProjectMcpServer, type ProjectMcpOptions } from './mcp.js';
import { CanvasStore } from './storage.js';

const applications: Array<{ server: Server; root: string }> = [];
const connections: Array<{ client: Client; server: McpServer }> = [];
const canvasId = 'product-roadmap';

async function application() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-todo-mcp-'));
  const server = await createApiServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  applications.push({ root, server });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native API address');
  return { root, base: `http://127.0.0.1:${address.port}/api` };
}

async function connect(base: string, options: ProjectMcpOptions = {}) {
  const server = createProjectMcpServer(base, fetch, options);
  const client = new Client({ name: 'Todo reviewer', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  connections.push({ client, server });
  async function call(name: string, args: Record<string, unknown>) {
    const output = await client.callTool({ name, arguments: args });
    const text = (output.content as Array<{ text: string }>)[0].text;
    return { output, text, value: output.isError ? undefined : JSON.parse(text) };
  }
  return { client, call };
}

beforeEach(() => {
  for (const name of ['CANVAS_API_TOKEN', 'SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN',
    'SYMBIKNOW_AGENT_NAME', 'ALLTEAM_AGENT_NAME']) vi.stubEnv(name, '');
});

afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close(); await server.close();
  }
  for (const { server, root } of applications.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('native MCP todo lifecycle', () => {
  it('creates, edits, archives, and reopens durable tasks through discovered tools', async () => {
    const { root, base } = await application();
    const { client, call } = await connect(base);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['list_todos', 'create_todo', 'update_todo', 'set_todo_status']));
    const created = await call('create_todo', { canvasId, title: 'לבדוק השקה', detail: 'Review release checklist',
      priority: 'urgent', size: 'l', dueDate: '2026-10-12', assignee: 'Ben', status: 'todo' });
    expect(created.output.isError).not.toBe(true);
    const task = created.value as CanvasTask;
    expect(task).toMatchObject({ title: 'לבדוק השקה', detail: 'Review release checklist', priority: 'urgent',
      size: 'l', dueDate: '2026-10-12', assignee: 'Ben', status: 'todo', createdBy: 'local-stdio-agent', revision: 1 });
    const edited = await call('update_todo', { canvasId, taskId: task.id, expectedRevision: task.revision,
      title: 'Review final release', detail: 'Final checks complete', priority: 'high', size: 's', dueDate: null,
      assignee: null, status: 'in_progress' });
    expect(edited.output.isError).not.toBe(true);
    expect(edited.value).toMatchObject({ title: 'Review final release', detail: 'Final checks complete',
      priority: 'high', size: 's', status: 'in_progress', revision: 2 });
    expect(edited.value).not.toHaveProperty('dueDate');
    expect(edited.value).not.toHaveProperty('assignee');
    const done = await call('set_todo_status', { canvasId, taskId: task.id, expectedRevision: 2, status: 'done' });
    expect(done.output.isError).not.toBe(true);
    expect(done.value).toMatchObject({ id: task.id, status: 'done', revision: 3 });
    const archived = (await call('list_todos', { canvasId })).value as CanvasTask[];
    expect(archived).toEqual([expect.objectContaining({ id: task.id, status: 'done', revision: 3 })]);
    expect(await new CanvasStore(root).listTasks(canvasId)).toEqual(archived);
    expect(JSON.parse(await readFile(path.join(root, 'tasks', canvasId + '.json'), 'utf8'))).toEqual(archived);
    const reopened = await call('set_todo_status', { canvasId, taskId: task.id, expectedRevision: 3, status: 'todo' });
    expect(reopened.output.isError).not.toBe(true);
    expect(await new CanvasStore(root).listTasks(canvasId)).toEqual([reopened.value]);
    expect(reopened.value).toMatchObject({ status: 'todo', revision: 4 });
  });

  it('keeps concurrent changes intact and requires current revisions and valid planning inputs', async () => {
    const { root, base } = await application();
    const { call } = await connect(base);
    const task = (await call('create_todo', { canvasId, title: 'Prepare review' })).value as CanvasTask;
    const blocked = await call('set_todo_status', { canvasId, taskId: task.id, expectedRevision: 1, status: 'blocked' });
    expect(blocked.value).toMatchObject({ status: 'blocked', revision: 2 });
    const stale = await call('update_todo', { canvasId, taskId: task.id, expectedRevision: 1, title: 'Stale overwrite' });
    expect(stale.output.isError).toBe(true);
    expect(JSON.parse(stale.text)).toMatchObject({ code: 'conflict' });
    expect(stale.text).toContain('task changed');
    for (const [name, args] of [
      ['create_todo', { canvasId, title: 'Invalid size', size: 'enormous' }],
      ['create_todo', { canvasId, title: 'Invalid date', dueDate: '2026-02-30' }],
      ['create_todo', { canvasId, title: '   ' }],
      ['update_todo', { canvasId, taskId: task.id, title: 'Missing revision' }],
      ['set_todo_status', { canvasId, taskId: task.id, expectedRevision: -1, status: 'done' }],
      ['set_todo_status', { canvasId, taskId: task.id, expectedRevision: 2, status: 'archived' }],
    ] as const) expect((await call(name, args)).output.isError).toBe(true);
    expect(await new CanvasStore(root).listTasks(canvasId)).toEqual([blocked.value]);
    const retried = await call('update_todo', { canvasId, taskId: task.id, expectedRevision: 2,
      detail: 'Resolved blocker', dueDate: '2028-02-29', status: 'done' });
    expect(retried.output.isError).not.toBe(true);
    expect(await new CanvasStore(root).listTasks(canvasId)).toEqual([retried.value]);
    expect(retried.value).toMatchObject({ detail: 'Resolved blocker', dueDate: '2028-02-29', status: 'done', revision: 3 });
  });

  it('exposes only permitted tools and prevents cross-canvas access before a write', async () => {
    const { root, base } = await application();
    const owner = await connect(base);
    const task = (await owner.call('create_todo', { canvasId, title: 'Scoped task' })).value as CanvasTask;
    const reader = await connect(base, { access: 'read', allowedCanvasIds: [canvasId] });
    const readerNames = (await reader.client.listTools()).tools.map(tool => tool.name);
    expect(readerNames).toContain('list_todos');
    expect(readerNames).not.toEqual(expect.arrayContaining(['create_todo', 'update_todo', 'set_todo_status']));
    for (const name of ['create_todo', 'update_todo', 'set_todo_status']) expect(readerNames).not.toContain(name);
    expect((await reader.call('list_todos', { canvasId })).value).toEqual([task]);
    expect((await reader.call('list_todos', { canvasId: 'engineering' })).output.isError).toBe(true);
    const writer = await connect(base, { access: 'write', allowedCanvasIds: [canvasId], tools: ['list_todos', 'set_todo_status'] });
    expect((await writer.client.listTools()).tools.map(tool => tool.name)).toEqual(['list_todos', 'set_todo_status']);
    const denied = await writer.call('set_todo_status', { canvasId: 'engineering', taskId: task.id, expectedRevision: 1, status: 'done' });
    expect(denied.output.isError).toBe(true);
    expect(denied.text).toContain('caller scope');
    expect(await new CanvasStore(root).listTasks(canvasId)).toEqual([task]);
    expect((await writer.call('set_todo_status', { canvasId, taskId: task.id, expectedRevision: 1, status: 'done' })).value)
      .toMatchObject({ status: 'done', revision: 2 });
  });
});
