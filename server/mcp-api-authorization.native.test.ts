import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CanvasStore } from './storage.js';
import { createStoreApiFetcher } from './api-inprocess.js';
import { createProjectMcpServer } from './mcp.js';
import { StorageFiles } from './storage-files.js';

const roots: string[] = [];
const sessions: Array<{ client: Client; server: McpServer }> = [];
beforeEach(() => {
  for (const key of ['SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'CANVAS_API_TOKEN', 'SYMBIKNOW_MCP_TOKEN', 'ALLTEAM_MCP_TOKEN']) vi.stubEnv(key, '');
});
afterEach(async () => {
  for (const { client, server } of sessions.splice(0)) { await client.close(); await server.close(); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 });
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-canonical-authority-'));
  roots.push(root);
  const store = new CanvasStore(root); await store.init();
  const api = createStoreApiFetcher(store);
  function request(token: string, route: string, method = 'GET', body?: unknown, tool?: string, signal?: AbortSignal) {
    return api('http://local/api' + route, { method, headers: { authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(tool ? { 'x-symbiknow-mcp-tool': tool } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  }
  async function agent(token?: string) {
    if (token) vi.stubEnv('CANVAS_API_TOKEN', token);
    const server = createProjectMcpServer('http://local/api', api, { authoritativeApi: true, localFiles: false });
    const client = new Client({ name: 'Friendly display identity', version: '1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    sessions.push({ client, server });
    return client;
  }
  return { store, request, agent };
}

it.each([false, true])('enforces stored caller authority before API operations with protected workspace=%s', async protectedWorkspace => {
  if (protectedWorkspace) vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'workspace-owner-secret');
  const { store, request, agent } = await fixture();
  const reader = await store.createMcpToken('Scoped reader', 'read', { allowedCanvasIds: ['product-roadmap'], tools: ['read_doc', 'read_canvas', 'list_canvases'] });
  const identity = reader.settings.mcpTokens![0];
  expect(await (await request(reader.token, '/mcp/caller')).json()).toMatchObject({ id: identity.id, access: 'read', allowedCanvasIds: ['product-roadmap'] });
  const client = await agent(reader.token);
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['list_canvases', 'read_canvas', 'read_doc']);
  const docPath = '/canvases/product-roadmap/blocks/roadmap-overview';
  const before = await store.getCanvasBlock('product-roadmap', 'roadmap-overview');
  expect((await request(reader.token, docPath)).status).toBe(200);
  expect((await request(reader.token, '/canvases/engineering')).status).toBe(403);
  expect((await request(reader.token, docPath, 'DELETE', { expectedContentHash: before.contentHash }, 'read_doc')).status).toBe(403);
  expect((await request(reader.token, docPath, 'PUT', { x: 99, y: 99 }, 'read_doc')).status).toBe(403);
  expect((await request(reader.token, '/workspaces', 'POST', { name: 'Unauthorized' })).status).toBe(403);
  expect((await request(reader.token, '/canvases/product-roadmap/import', 'POST', { documents: [] })).status).toBe(403);
  expect(await store.getCanvasBlock('product-roadmap', 'roadmap-overview')).toEqual(before);
  const listed = await (await request(reader.token, '/workspaces')).json();
  expect(listed.flatMap((workspace: { canvases: Array<{ id: string }> }) => workspace.canvases.map(canvas => canvas.id))).toEqual(['product-roadmap']);
  const read = await client.callTool({ name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: 'roadmap-overview' } });
  expect(read.isError).not.toBe(true);
  const entry = (await store.mcpActivity()).entries[0];
  expect(entry).toMatchObject({ tokenId: identity.id, tokenName: 'Scoped reader', access: 'read', tool: 'read_doc', documentIds: ['roadmap-overview'] });
  expect(JSON.stringify(entry)).not.toContain(before.content);
  await store.revokeMcpToken(identity.id);
  await expect(client.listTools()).rejects.toThrow('no longer authorized');
  expect((await request(reader.token, docPath)).status).toBe(401);
});

it('allows canonical movement but rejects a source write disguised as move_block', async () => {
  const { store, request, agent } = await fixture();
  const writer = await store.createMcpToken('Metadata editor', 'write', { allowedCanvasIds: ['product-roadmap'], tools: ['move_block'] });
  const before = await store.getCanvasBlock('product-roadmap', 'roadmap-overview');
  const docPath = '/canvases/product-roadmap/blocks/roadmap-overview';
  expect((await request(writer.token, docPath, 'PUT', { x: 9, y: 10, content: '# Spoofed source' }, 'move_block')).status).toBe(403);
  expect((await request(writer.token, docPath, 'PUT', { content: '# Spoofed source' })).status).toBe(403);
  expect((await request(writer.token, '/canvases/engineering/blocks/api-design', 'PUT', { x: 9, y: 10 }, 'move_block')).status).toBe(403);
  expect((await request(writer.token, docPath, 'PUT', { x: 9, y: 10 }, 'nonexistent_tool')).status).toBe(403);
  const client = await agent(writer.token);
  expect((await client.callTool({ name: 'move_block', arguments: { canvasId: 'product-roadmap', blockId: 'roadmap-overview', x: 9, y: 10 } })).isError).not.toBe(true);
  const after = await store.getCanvasBlock('product-roadmap', 'roadmap-overview');
  expect(after).toMatchObject({ x: 9, y: 10, content: before.content, contentHash: before.contentHash });
  const logs = (await store.mcpActivity()).entries;
  expect(logs[0]).toMatchObject({ tokenId: writer.settings.mcpTokens![0].id, tool: 'move_block', outcome: 'success' });
});

it('audits an authenticated local CLI caller without transmitting raw arguments or results', async () => {
  const { store, agent, request } = await fixture();
  const client = await agent();
  expect((await client.callTool({ name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: 'roadmap-overview' } })).isError).not.toBe(true);
  expect((await store.mcpActivity()).entries[0]).toMatchObject({ tokenId: 'local-stdio-agent', tokenName: 'local-stdio-agent', tool: 'read_doc', outcome: 'success' });
  const caller = await store.createMcpToken('Audit sender', 'read');
  const forged = await request(caller.token, '/mcp/calls', 'POST', { tool: 'read_doc', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    outcome: 'success', tokenId: 'somebody-else', args: { content: 'secret', canvasIds: [], blockIds: [] } });
  expect(forged.status).toBe(400);
  expect((await store.mcpActivity()).entries).toHaveLength(1);
});

it.each(['revoke', 'downgrade', 'cancel'])('rechecks queued mutation authority before storage begins: %s', async change => {
  const { store, request } = await fixture();
  const created = await store.createMcpToken('Queued writer', 'write', { tools: ['move_block'], allowedCanvasIds: ['product-roadmap'] });
  const before = await store.getCanvasBlock('product-roadmap', 'roadmap-overview');
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let acquired!: () => void;
  const acquiredBarrier = new Promise<void>(resolve => { acquired = resolve; });
  const hold = new StorageFiles(store.root, store.locks).serialize(async () => {
    acquired(); await barrier;
    if (change === 'revoke') await store.revokeMcpToken(created.settings.mcpTokens![0].id);
    if (change === 'downgrade') {
      const settings = await store.secretSettings();
      await writeFile(path.join(store.root, 'settings.json'), JSON.stringify({ ...settings,
        mcpTokens: settings.mcpTokens?.map(token => ({ ...token, access: 'read' })) }));
    }
  });
  await acquiredBarrier;
  let reached!: () => void;
  const reachedBarrier = new Promise<void>(resolve => { reached = resolve; });
  const originalUpdate = store.updateBlock.bind(store);
  const observed = vi.spyOn(store, 'updateBlock').mockImplementation((...args) => { reached(); return originalUpdate(...args); });
  const controller = new AbortController();
  const pending = request(created.token, '/canvases/product-roadmap/blocks/roadmap-overview', 'PUT', { x: 999, y: 999 }, 'move_block', controller.signal);
  const cancelled = change === 'cancel' ? expect(pending).rejects.toThrow('Stopped queued movement') : undefined;
  await reachedBarrier;
  if (change === 'cancel') controller.abort(new Error('Stopped queued movement'));
  release(); await hold;
  if (cancelled) await cancelled;
  else expect((await pending).status).toBe(change === 'revoke' ? 401 : 403);
  observed.mockRestore();
  const after = await store.getCanvasBlock('product-roadmap', 'roadmap-overview');
  expect(after).toEqual(before);
});

it('rejects commit uploads for a proposal caller and rejects invalid canonical declaration headers', async () => {
  const { store, request } = await fixture();
  const proposer = await store.createMcpToken('File proposer', 'propose', { tools: ['upload_file'], allowedCanvasIds: ['product-roadmap'] });
  const input = { mode: 'create', canvasId: 'product-roadmap', filename: 'unapproved.md', content: '# Unapproved', idempotencyKey: 'deny-propose' };
  expect((await request(proposer.token, '/file-uploads', 'POST', input, 'upload_file')).status).toBe(403);
  expect((await store.getCanvas('product-roadmap')).blocks.some(block => block.title === 'Unapproved')).toBe(false);
  const { Readable } = await import('node:stream');
  const { authorizeMcpApi, withinMcpApiAuthority } = await import('./mcp-api-authorization.js');
  const controller = new AbortController();
  const context = { store, request: Object.assign(Readable.from([]), { headers: {
    authorization: 'Bearer ' + proposer.token, 'x-symbiknow-mcp-tool': ['upload_file', 'read_doc'] }, socket: { remoteAddress: '127.0.0.1' } }),
    method: 'POST', route: '/api/file-uploads', url: new URL('http://local/api/file-uploads'), actor: 'spoofed', signal: controller.signal };
  await expect(authorizeMcpApi(context as never)).rejects.toThrow('Invalid canonical MCP tool declaration');
  expect(await withinMcpApiAuthority({} as never, async () => 'owner-operation')).toBe('owner-operation');
  const owner = createStoreApiFetcher(store);
  expect((await owner('http://local/api/workspaces')).status).toBe(200);
});
