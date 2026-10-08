import { projectMcpMetadata } from './mcp-registry.js';
import { canCallMcpTool } from './mcp-scope.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CanvasBlock, CanvasTask, ChatSettings } from '../shared/types.js';
import { createApiServer } from './index.js';

const opened: Array<{ server: Server; dataDir: string }> = [];

async function app(): Promise<string> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-collab-'));
  const server = await createApiServer({ dataDir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, dataDir });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}

async function call<T = unknown>(base: string, route: string, options: { method?: string; body?: unknown; actor?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(base + route, { method: options.method ?? 'GET', headers: {
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.actor ? { 'x-symbiknow-actor': options.actor } : {}), ...options.headers,
  }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) as T };
}

async function disconnect(base: string, client: Client, transport: StreamableHTTPClientTransport) {
  try { await transport.terminateSession(); }
  finally {
    await client.close();
    // This native serialized write waits for advisory token metadata before fixture deletion.
    expect((await call(base, '/api/settings', { method: 'PUT', body: {} })).status).toBe(200);
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const item of opened.splice(0)) {
    item.server.closeAllConnections();
    await new Promise<void>(resolve => item.server.close(() => resolve()));
    await rm(item.dataDir, { recursive: true, force: true });
  }
});

describe('agent collaboration', () => {
  it('locks document content for its owner and rejects stale writes', async () => {
    const base = await app();
    const doc = '/api/canvases/product-roadmap/blocks/launch-checklist';
    const lock = await call<{ owner: string }>(base, `${doc}/lock`, { method: 'POST', actor: 'Codex', body: { ttlSeconds: 120, note: 'Rewriting' } });
    expect(lock.data).toMatchObject({ owner: 'Codex', note: 'Rewriting' });
    const blocked = await call<{ error: string }>(base, doc, { method: 'PUT', actor: 'Claude Code', body: { content: '# Other' } });
    expect(blocked.status).toBe(423);
    expect(blocked.data.error).toContain('Codex is editing this document');
    expect((await call(base, doc, { method: 'PUT', actor: 'Claude Code', body: { x: 900 } })).status).toBe(200);
    const canvas = await call<{ blocks: CanvasBlock[] }>(base, '/api/canvases/product-roadmap');
    const block = canvas.data.blocks.find(item => item.id === 'launch-checklist')!;
    expect(block.lock).toMatchObject({ owner: 'Codex' });
    expect(block.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect((await call(base, doc, { method: 'PUT', actor: 'Codex', body: { content: '# Stale', expectedContentHash: '0000000000000000' } })).status).toBe(409);
    const saved = await call<CanvasBlock>(base, doc, { method: 'PUT', actor: 'Codex', body: { content: '# Codex draft', expectedContentHash: block.contentHash, message: 'Codex rewrite' } });
    expect(saved.status).toBe(200);
    expect((await call(base, `${doc}/lock`, { method: 'DELETE', actor: 'Claude Code' })).status).toBe(409);
    expect((await call(base, `${doc}/lock`, { method: 'DELETE', actor: 'Codex' })).status).toBe(200);
    expect((await call(base, doc, { method: 'PUT', actor: 'Claude Code', body: { content: '# Claude edit' } })).status).toBe(200);
    const history = await call<{ commits: Array<{ message: string; author: string }> }>(base, `${doc}/versions`);
    expect(history.data.commits.slice(0, 2)).toMatchObject([{ author: 'Claude Code' }, { message: 'Codex rewrite', author: 'Codex' }]);
  });

  it('keeps HTML pages on the HTML loader and records who deleted a document', async () => {
    const base = await app();
    const page = '---\nformat: html\n---\n<!doctype html><h1>Diagram</h1>';
    const created = await call<CanvasBlock>(base, '/api/canvases/product-roadmap/blocks', { method: 'POST', actor: 'Claude Code', body: { title: 'Diagram', kind: 'website', content: page } });
    expect(created.data.kind).toBe('markdown');
    const changed = await call<CanvasBlock>(base, `/api/canvases/product-roadmap/blocks/${created.data.id}`, { method: 'PUT', body: { kind: 'website' } });
    expect(changed.data.kind).toBe('markdown');
    expect((await call<CanvasBlock>(base, '/api/canvases/product-roadmap/blocks/team-docs', { method: 'PUT', body: { kind: 'website' } })).data.kind).toBe('website');
    await call(base, `/api/canvases/product-roadmap/blocks/${created.data.id}`, { method: 'DELETE', actor: 'Codex' });
    const { execFileSync } = await import('node:child_process');
    const dataDir = opened.at(-1)!.dataDir;
    const log = execFileSync('git', ['log', '--format=%an|%s'], { cwd: path.join(dataDir, '.versions', created.data.id), encoding: 'utf8' });
    expect(log.split('\n')[0]).toBe('Codex|Delete Diagram from canvas Product Roadmap');
  });

  it('serves remote agents over Streamable HTTP with revocable tokens', async () => {
    const base = await app();
    expect((await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })).status).toBe(401);
    const created = await call<{ token: string; settings: ChatSettings }>(base, '/api/mcp/tokens', { method: 'POST', body: { name: 'laptop', access: 'write' } });
    expect(created.data.token).toMatch(/^atm_/);
    expect(JSON.stringify(created.data.settings)).not.toContain(created.data.token);
    const info = await call<{ endpoint: string }>(base, '/api/mcp/info');
    expect(info.data.endpoint).toBe(`${base}/mcp`);

    const client = new Client({ name: 'codex-mcp-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${created.data.token}` } } });
    const retainedTools = projectMcpMetadata().filter(tool => canCallMcpTool('write', tool.name)).map(tool => tool.name);
    const removedTools = ['create_doc', 'edit_doc', 'import_documents', 'jev_propose', 'analyze_canvas', 'find_duplicates', 'merge_documents', 'undo_merge', 'connect_across_canvases', 'score_documents',
      'run_workspace_automation', 'regroup_canvas', 'organize_canvas', 'connect_documents', 'label_purposes', 'classify_work_areas', 'assign_reviewers'];
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const upload = tools.tools.find(tool => tool.name === 'upload_file')!;
      expect(Object.keys(upload.inputSchema.properties ?? {})).not.toContain('sourcePath');
      const names = tools.tools.map(tool => tool.name);
      expect(names.sort()).toEqual([...retainedTools].sort());
      for (const name of removedTools) expect(names).not.toContain(name);
      const output = await client.callTool({ name: 'upload_file', arguments: { mode: 'create', canvasId: 'product-roadmap', filename: 'remote.html', content: '<h1>Remote</h1>', idempotencyKey: 'remote-html' } });
      expect(output.isError).not.toBe(true);
      const receipt = JSON.parse((output.content as Array<{ text: string }>)[0].text) as { blockId: string };
      const uploaded = (await call<CanvasBlock>(base, `/api/canvases/product-roadmap/blocks/${receipt.blockId}`)).data;
      expect(uploaded.content).toContain('format: html');
      const history = await call<{ commits: Array<{ author: string }> }>(base, `/api/canvases/product-roadmap/blocks/${uploaded.id}/versions`);
      expect(history.data.commits[0].author).toBe(created.data.settings.mcpTokens![0].id);
      const createdTodo = await client.callTool({ name: 'create_todo', arguments: {
        canvasId: 'product-roadmap', title: 'Remote task', priority: 'high', size: 's',
      } });
      expect(createdTodo.isError).not.toBe(true);
      const task = JSON.parse((createdTodo.content as Array<{ text: string }>)[0].text) as CanvasTask;
      expect(task.createdBy).toBe(created.data.settings.mcpTokens![0].id);
      const completedTodo = await client.callTool({ name: 'set_todo_status', arguments: {
        canvasId: 'product-roadmap', taskId: task.id, expectedRevision: task.revision, status: 'done',
      } });
      expect(completedTodo.isError).not.toBe(true);
      const tasks = await call<CanvasTask[]>(base, '/api/canvases/product-roadmap/todos');
      expect(tasks.data).toEqual([expect.objectContaining({ id: task.id, status: 'done', updatedBy: created.data.settings.mcpTokens![0].id })]);
    } finally { await disconnect(base, client, transport); }

    const pathClient = new Client({ name: 'claude-ai', version: '1.0.0' });
    const pathTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/t/${created.data.token}`));
    try {
      await pathClient.connect(pathTransport);
      expect((await pathClient.listTools()).tools.map(tool => tool.name).sort()).toEqual([...retainedTools].sort());
    } finally { await disconnect(base, pathClient, pathTransport); }

    const tokenId = created.data.settings.mcpTokens![0].id;
    await call(base, `/api/mcp/tokens/${tokenId}`, { method: 'DELETE' });
    const revoked = new Client({ name: 'late', version: '1.0.0' });
    try {
      await expect(revoked.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${created.data.token}` } } }))).rejects.toThrow();
    } finally { await revoked.close(); }
  });

  it('requires the access token for the API when one is configured', async () => {
    vi.stubEnv('ALLTEAM_ACCESS_TOKEN', 'team-secret');
    const base = await app();
    expect((await call(base, '/api/workspaces')).status).toBe(401);
    expect((await call(base, '/api/session')).data).toEqual({ authRequired: true, authenticated: false });
    expect((await call(base, '/api/session', { method: 'POST', body: { token: 'wrong' } })).status).toBe(401);
    const login = await call(base, '/api/session', { method: 'POST', body: { token: 'team-secret' } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toMatch(/^symbiknow_session=[0-9a-f]{64}$/);
    expect((await call(base, '/api/workspaces', { headers: { cookie } })).status).toBe(200);
    expect((await call(base, '/api/workspaces', { headers: { authorization: 'Bearer team-secret' } })).status).toBe(200);
    expect((await fetch(base + '/')).status).toBe(200);
  });

  it('accepts SymbiKnow access tokens while legacy sessions and tokens remain valid', async () => {
    vi.stubEnv('ALLTEAM_ACCESS_TOKEN', 'legacy-secret');
    const base = await app();
    const legacyCookie = `allteam_session=${createHmac('sha256', 'legacy-secret').update('allteam-session-v1').digest('hex')}`;

    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'new-secret');
    expect((await call(base, '/api/workspaces', { headers: { cookie: legacyCookie } })).status).toBe(200);
    expect((await call(base, '/api/workspaces', { headers: { authorization: 'Bearer legacy-secret' } })).status).toBe(200);
    expect((await call(base, '/api/workspaces', { headers: { authorization: 'Bearer new-secret' } })).status).toBe(200);
    const newLogin = await call(base, '/api/session', { method: 'POST', body: { token: 'new-secret' } });
    const newCookie = newLogin.headers.get('set-cookie')!.split(';')[0];
    expect(newCookie).toMatch(/^symbiknow_session=[0-9a-f]{64}$/);
    expect(newCookie).not.toBe(legacyCookie);
    expect((await call(base, '/api/workspaces', { headers: { cookie: newCookie } })).status).toBe(200);
    expect((await call(base, '/api/session', { method: 'POST', body: { token: 'wrong' } })).status).toBe(401);
  });

  it('stores named secrets privately and validates outside MCP servers and profiles', async () => {
    const base = await app();
    const saved = await call<ChatSettings>(base, '/api/settings', { method: 'PUT', body: {
      secrets: { GITHUB_TOKEN: 'ghp_private' },
      mcpServers: [{ name: 'GitHub', url: 'https://example.com/mcp', bearerSecret: 'GITHUB_TOKEN', headers: { 'X-Team': '${secret:GITHUB_TOKEN}' } }],
      customProfiles: [{ name: 'Sales coach', instructions: 'Focus on deals and next steps.' }], agentProfile: 'custom-sales-coach',
      provider: 'anthropic', apiKey: 'sk-ant-private',
    } });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ secretNames: ['GITHUB_TOKEN'], agentProfile: 'custom-sales-coach', provider: 'anthropic', hasApiKey: true,
      providerKeys: { anthropic: true, openrouter: false }, mcpServers: [{ id: 'github', bearerSecret: 'GITHUB_TOKEN', enabled: true }] });
    expect(JSON.stringify(saved.data)).not.toMatch(/ghp_private|sk-ant-private/);
    expect((await call(base, '/api/settings', { method: 'PUT', body: { mcpServers: [{ name: 'x', url: 'ftp://nope' }] } })).status).toBe(400);
    expect((await call(base, '/api/settings', { method: 'PUT', body: { mcpServers: [{ name: 'x', url: 'https://a.b', bearerSecret: 'MISSING' }] } })).status).toBe(400);
    expect((await call(base, '/api/settings', { method: 'PUT', body: { secrets: { 'bad-name': 'x' } } })).status).toBe(400);
    const removed = await call<ChatSettings>(base, '/api/settings', { method: 'PUT', body: { secrets: { GITHUB_TOKEN: null } } });
    expect(removed.data).toMatchObject({ secretNames: [], mcpServers: [] });
  });
});
