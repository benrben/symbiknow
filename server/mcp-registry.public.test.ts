import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createProjectMcpServer } from './mcp.js';
import type { McpPermissions, ProjectMcpOptions } from './mcp-options.js';
import { projectMcpMetadata } from './mcp-registry.js';
import { defaultPrivateSettings, newMcpToken, publicSettings } from './settings.js';

const connections: Array<{ server: McpServer; client: Client }> = [];
afterEach(async () => { for (const { server, client } of connections.splice(0)) { await client.close(); await server.close(); } });
async function connect(options: ProjectMcpOptions, customFetcher?: typeof fetch) {
  const fetcher = customFetcher ?? vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
  const server = createProjectMcpServer('http://local/api', fetcher, options);
  const client = new Client({ name: 'registry-agent', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  connections.push({ server, client });
  return { client, fetcher };
}

it('derives discovery and settings from the same canonical registrations without aliases', async () => {
  const { client } = await connect({ access: 'write', canApprove: true, canConfigure: true });
  const tools = (await client.listTools()).tools;
  const metadata = projectMcpMetadata();
  const names = tools.map(tool => tool.name);
  expect(names).toEqual(metadata.map(tool => tool.name));
  expect(publicSettings(defaultPrivateSettings).mcpToolCatalog?.map(tool => tool.name)).toEqual(names);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual(expect.arrayContaining(['ask_symbi', 'symbi_reflex', 'find_by', 'related', 'jev_do', 'jev_job', 'jev_resolve', 'jev_undo', 'jev_configure']));
  for (const obsolete of ['create_doc', 'edit_doc', 'import_documents', 'jev_propose']) expect(names).not.toContain(obsolete);
  expect(tools.every(tool => tool.description && !/legacy|deprecated|compatibility/i.test(tool.description))).toBe(true);
});

it('refreshes tool, canvas, and reviewer grants during an existing MCP session', async () => {
  let permissions: McpPermissions | null = { access: 'write', canApprove: true, tools: ['read_doc', 'delete_doc', 'jev_resolve'], allowedCanvasIds: ['a', 'b'] };
  const onToolCall = vi.fn();
  const { client, fetcher } = await connect({ resolvePermissions: () => permissions, onToolCall });
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['read_doc', 'delete_doc', 'jev_resolve']);
  expect((await client.callTool({ name: 'delete_doc', arguments: { canvasId: 'b', blockId: 'doc', expectedContentHash: 'hash' } })).isError).not.toBe(true);
  permissions = { access: 'read', allowedCanvasIds: ['a'], tools: ['read_doc', 'delete_doc', 'jev_resolve'] };
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['read_doc']);
  for (const [name, args] of [
    ['delete_doc', { canvasId: 'a', blockId: 'doc', expectedContentHash: 'hash' }],
    ['read_doc', { canvasId: 'b', blockId: 'doc' }],
    ['jev_resolve', { canvasId: 'a', proposalId: 'proposal', decision: 'apply' }],
  ] as const) expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  permissions = null;
  await expect(client.listTools()).rejects.toThrow('revoked');
  expect((await client.callTool({ name: 'read_doc', arguments: { canvasId: 'a', blockId: 'doc' } })).isError).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(onToolCall.mock.calls.map(([event]) => event.outcome)).toEqual(['success', 'denied', 'denied', 'denied', 'denied']);
});

it('requires explicit grants and prevents proposal callers from committing uploaded content', async () => {
  const token = newMcpToken('Reviewer', 'write', { tools: ['jev_resolve', 'jev_configure'], canApprove: true, canConfigure: true });
  expect(token.stored).toMatchObject({ canApprove: true, canConfigure: true });
  expect(() => newMcpToken('No reviewer grant', 'write', { tools: ['jev_resolve'] })).toThrow('explicit grants');
  expect(() => newMcpToken('Invalid reviewer', 'read', { canApprove: true })).toThrow('write access');
  const { client, fetcher } = await connect({ access: 'propose' });
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain('upload_file');
  const response = await client.callTool({ name: 'upload_file', arguments: {
    mode: 'create', canvasId: 'a', filename: 'note.md', content: '# Unsafe direct commit', idempotencyKey: 'upload-once',
  } });
  expect(response.isError).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('jev_resolve');
});

it('checks nested canvas targets before executing a Reflex action', async () => {
  const { client, fetcher } = await connect({ access: 'write', allowedCanvasIds: ['a'] });
  const response = await client.callTool({ name: 'jev_do', arguments: { canvasId: 'a', action: 'profile', options: { targetCanvasId: 'private' } } });
  expect(response.isError).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it('propagates SDK cancellation to the actual API request instead of leaving a hidden write running', async () => {
  let observed: AbortSignal | undefined;
  let announceStart!: () => void;
  const started = new Promise<void>(resolve => { announceStart = resolve; });
  let finishAbort!: () => void;
  const aborted = new Promise<void>(resolve => { finishAbort = resolve; });
  let committed = false;
  const fetcher: typeof fetch = async (_input, init) => {
    observed = init?.signal ?? undefined;
    announceStart();
    return new Promise<Response>((resolve, reject) => {
      if (!observed) { committed = true; resolve(Response.json({ ok: true })); return; }
      observed.addEventListener('abort', () => { finishAbort(); reject(observed!.reason); }, { once: true });
    });
  };
  const { client } = await connect({ access: 'write' }, fetcher);
  const controller = new AbortController();
  const reason = new Error('User stopped the edit');
  const call = client.callTool({ name: 'delete_doc', arguments: { canvasId: 'a', blockId: 'doc', expectedContentHash: 'hash' } }, undefined, { signal: controller.signal });
  const rejected = expect(call).rejects.toThrow('User stopped the edit');
  await started;
  expect(observed).toBeInstanceOf(AbortSignal);
  controller.abort(reason);
  await rejected;
  await aborted;
  expect(observed!.aborted).toBe(true);
  expect(committed).toBe(false);
});

it('rejects duplicate registrations and missing API contracts before a tool can be served', async () => {
  const { collectMcpTools, advertisedTool, toolPermission } = await import('./mcp-registry.js');
  const { toolApiContracts, matchingApiContracts } = await import('./mcp-api-contract.js');
  expect(() => collectMcpTools(server => {
    server.registerTool('collision', { description: 'First' }, async () => ({ content: [] }));
    server.registerTool('collision', { description: 'Second' }, async () => ({ content: [] }));
  })).toThrow('Duplicate MCP tool: collision');
  expect(() => collectMcpTools(server => {
    server.registerTool('undocumented', {}, async () => ({ content: [] }));
  })).toThrow('needs a description');
  expect(() => toolApiContracts({ name: 'no-route', config: {}, handler: () => undefined })).toThrow('no API authorization contract');
  expect(() => toolApiContracts({ name: 'empty-route', config: { _meta: { apiRoutes: [] } }, handler: () => undefined })).toThrow('no API authorization contract');
  expect(toolPermission({ _meta: { permission: 'invalid' } })).toBe('write');
  expect(advertisedTool({ name: 'empty-input', config: {}, handler: () => undefined }).inputSchema).toMatchObject({ type: 'object', properties: {} });
  const route = toolApiContracts({ name: 'transformed-body', config: { _meta: { apiRoutes: [{ method: 'POST', path: '/transformed', bodyFields: ['internalKey'] }] } }, handler: () => undefined });
  expect(route[0].bodySchema!.safeParse({ internalKey: 'derived by handler' }).success).toBe(true);
  expect(route[0].bodySchema!.safeParse({ internalKey: true, rawContent: 'smuggled' }).success).toBe(false);
  expect(matchingApiContracts('POST', '/api/canvases/a/jev/agent/proposals/p/invalid', new URLSearchParams(), 'jev_resolve')).toEqual([]);
  expect(matchingApiContracts('GET', '/api/canvases/a/jev/agent/state', new URLSearchParams('view=jev_activity'), 'jev_profile')).toEqual([]);
});

it('keeps an explicitly authenticated embedded host independent of ambient CLI credentials', async () => {
  vi.stubEnv('CANVAS_API_TOKEN', 'ambient-cli-token');
  try {
    const { client, fetcher } = await connect({ access: 'read', headers: { Authorization: 'Bearer embedded-host-token' } });
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('read_doc');
    expect((await client.callTool({ name: 'read_doc', arguments: { canvasId: 'a', blockId: 'doc' } })).isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer embedded-host-token' });
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][1].headers).not.toHaveProperty('authorization');
  } finally { vi.unstubAllEnvs(); }
});
