import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createProjectMcpServer, type ProjectMcpOptions } from './mcp.js';
import { canCallMcpTool, scopedRegistration, scopedResult } from './mcp-scope.js';
import { ApiRequestError } from './mcp-api.js';

const connections: Array<{ client: Client; server: McpServer }> = [];
async function connect(fetcher: typeof fetch, options: ProjectMcpOptions = {}, name = 'scope-agent') {
  const server = createProjectMcpServer('http://127.0.0.1:8787/api', fetcher, options);
  const client = new Client({ name, version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  connections.push({ client, server });
  return client;
}
afterEach(async () => { for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); } vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('MCP scope authorization failures', () => {

  it('records successful and failed unscoped calls even when the ledger itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onToolCall = vi.fn<NonNullable<ProjectMcpOptions['onToolCall']>>(async () => { throw new Error('Ledger unavailable'); });
    let failing = false;
    const fetcher = vi.fn(async () => {
      if (failing) throw new Error('API unavailable');
      return Response.json([{ id: 'workspace', canvases: [] }]);
    }) as unknown as typeof fetch;
    const client = await connect(fetcher, { onToolCall });
    expect((await client.callTool({ name: 'list_canvases', arguments: {} })).isError).not.toBe(true);
    failing = true;
    expect((await client.callTool({ name: 'list_canvases', arguments: {} })).isError).toBe(true);
    expect(onToolCall.mock.calls.map(([event]) => event.outcome)).toEqual(['success', 'error']);
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith('MCP activity ledger could not record a tool call');
  });

  it('reports malformed scoped workspace output as an error without leaking it', async () => {
    const onToolCall = vi.fn();
    const fetcher = vi.fn(async () => Response.json([{ id: 'workspace', canvases: 'unfiltered private results' }])) as unknown as typeof fetch;
    const client = await connect(fetcher, { allowedCanvasIds: ['canvas'], onToolCall });
    const output = await client.callTool({ name: 'list_canvases', arguments: {} });
    expect(output.isError).toBe(true);
    expect(JSON.stringify(output.content)).toContain('Could not safely filter');
    expect(JSON.stringify(output.content)).not.toContain('private results');
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });
});

describe('MCP scope result contracts', () => {
  it.each([undefined, {}, { content: [] }, { content: [{ text: 12 }] }, { content: [{ text: 'invalid' }] },
    { content: [{ text: '{}' }] }, { content: [{ text: '[null]' }] }, { content: [{ text: '["workspace"]' }] },
    { content: [{ text: '[{"canvases":null}]' }] }])('fails closed for malformed list output %#', value => {
    expect(() => scopedResult('list_canvases', value, new Set(['canvas']))).toThrow('Could not safely filter scoped tool results.');
  });

  it('filters absent or unauthorized identifiers and preserves other protocol content', () => {
    const tail = { type: 'image', data: 'image', mimeType: 'image/png' };
    const value = { content: [{ type: 'text', text: JSON.stringify([
      { id: 'included', canvases: [{ id: 'canvas' }, {}, { id: 'private' }] }, { id: 'empty', canvases: [] },
    ]) }, tail], isError: false };
    const output = scopedResult('list_canvases', value, new Set(['canvas'])) as { content: Array<{ text?: string }> };
    expect(JSON.parse(output.content[0].text!)).toEqual([{ id: 'included', canvases: [{ id: 'canvas' }] }]);
    expect(output.content[1]).toBe(tail);
    const search = scopedResult('search_docs', { content: [{ text: '[null,"text",{}, {"canvasId":"private"}, {"canvasId":"canvas","blockId":"doc"}]' }] }, new Set(['canvas'])) as { content: Array<{ text: string }> };
    expect(JSON.parse(search.content[0].text)).toEqual([{ canvasId: 'canvas', blockId: 'doc' }]);
    expect(scopedResult('read_doc', value, new Set())).toBe(value);
  });

  it('filters paged search results without changing cursor metadata and refuses malformed pages', () => {
    const allowed = new Set(['canvas']);
    const page = { items: [{ canvasId: 'private', blockId: 'secret' }, { canvasId: 'canvas', blockId: 'public' }],
      nextCursor: 'opaque-page', total: 2 };
    const wrapped = { content: [{ type: 'text', text: JSON.stringify(page) }] };
    const result = scopedResult('search_docs', wrapped, allowed) as typeof wrapped;
    expect(JSON.parse(result.content[0].text)).toEqual({ items: [{ canvasId: 'canvas', blockId: 'public' }],
      nextCursor: 'opaque-page', total: 2 });
    for (const text of ['not-json', 'null', '{}', '{"items":{}}', '42']) {
      expect(() => scopedResult('search_docs', { content: [{ type: 'text', text }] }, allowed))
        .toThrow('Could not safely filter scoped tool results.');
    }
  });

  it('returns a structured reviewed conflict and records denied scoped calls', async () => {
    const onToolCall = vi.fn();
    const server = new SdkMcpServer({ name: 'scoped-conflict', version: '1.0.0' });
    const registration = scopedRegistration(server, { allowedCanvasIds: ['canvas'], onToolCall });
    registration.registerTool('edit_doc', { inputSchema: { canvasId: z.string() } }, async () => {
      throw new ApiRequestError(409, 'current-hash', 'The document changed');
    });
    const client = new Client({ name: 'conflict-client', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    connections.push({ server, client });
    const conflict = await client.callTool({ name: 'edit_doc', arguments: { canvasId: 'canvas' } });
    expect(conflict.isError).toBe(true);
    expect(JSON.parse((conflict.content as Array<{ text: string }>)[0].text)).toEqual({
      error: 'The document changed', code: 'conflict', currentContentHash: 'current-hash',
      instruction: 'Download the current file and merge in your environment before retrying; keep your edited working copy.',
    });
    expect((await client.callTool({ name: 'edit_doc', arguments: { canvasId: 'private' } })).isError).toBe(true);
    expect(onToolCall.mock.calls.map(([event]) => event.outcome)).toEqual(['error', 'denied']);
  });

  it('enforces the access level together with an explicit tool allowlist', () => {
    expect(canCallMcpTool('read', 'read_doc')).toBe(true);
    expect(canCallMcpTool('read', 'edit_doc')).toBe(false);
    expect(canCallMcpTool('propose', 'run_workspace_automation')).toBe(false);
    expect(canCallMcpTool('propose', 'edit_doc')).toBe(false);
    expect(canCallMcpTool('write', 'delete_doc', ['read_doc'])).toBe(false);
    expect(canCallMcpTool('write', 'delete_doc', ['delete_doc'])).toBe(true);
  });

  it('omits forbidden tools from the advertised scoped registration', async () => {
    const server = new SdkMcpServer({ name: 'read-only-tools', version: '1.0.0' });
    const registration = scopedRegistration(server, { access: 'read', tools: ['read_doc', 'edit_doc'] });
    registration.registerTool('read_doc', { annotations: { readOnlyHint: true }, inputSchema: {} }, async () => ({ content: [{ type: 'text', text: '{}' }] }));
    expect(registration.registerTool('edit_doc', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: '{}' }] })))
      .toBeDefined();
    const client = new Client({ name: 'read-only-client', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    connections.push({ server, client });
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['read_doc']);
  });

  it('fails closed when SDK extension tools omit the IDs required for scope checks', async () => {
    const server = new SdkMcpServer({ name: 'extension-contract', version: '1.0.0' });
    const registration = scopedRegistration(server, { allowedCanvasIds: ['canvas'] });
    expect(registration.server).toBe(server.server);
    for (const name of ['read_canvas']) {
      registration.registerTool(name, { inputSchema: { canvasId: z.string().optional(), workspaceId: z.string().optional() } },
        async () => ({ content: [{ type: 'text', text: '[]' }] }));
    }
    const client = new Client({ name: 'extension-client', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    connections.push({ server, client });
    for (const name of ['read_canvas']) {
      expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
    }
  });
});
