import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mcpCanvasIds, scopedRegistration } from './mcp-scope.js';

const connections: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => { for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); } });

describe('MCP canvas identifiers in tool input', () => {
  it('collects canvases from nested arrays, source IDs, and canvas ID lists', () => {
    expect(mcpCanvasIds([{ canvasId: 'roadmap' }, [{ targetCanvasId: 'archive' }], 'loose text'])).toEqual(['roadmap', 'archive']);
    expect(mcpCanvasIds({ blocks: [{ sourceIds: ['research:interview', 'unscoped-note', 7, 'roadmap:launch'] }] })).toEqual(['research', 'roadmap']);
    expect(mcpCanvasIds({ canvasIds: ['roadmap', 3], sourceCanvasIds: ['research'], targetCanvasIds: [] })).toEqual(['roadmap', 'research']);
    expect(mcpCanvasIds({ canvasId: 42, edges: [[{ sourceCanvasId: 'research' }]] })).toEqual(['research']);
    expect(mcpCanvasIds(null)).toEqual([]);
  });

  it('denies a scoped call whose source IDs reach outside the allowed canvases', async () => {
    const onToolCall = vi.fn();
    const server = new McpServer({ name: 'scoped-sources', version: '1.0.0' });
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{}' }] }));
    scopedRegistration(server, { allowedCanvasIds: ['roadmap'], onToolCall })
      .registerTool('draw_research_canvas', { inputSchema: { canvasId: z.string(), sourceIds: z.array(z.string()) } }, handler);
    const client = new Client({ name: 'scoped-client', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    connections.push({ client, server });
    const denied = await client.callTool({ name: 'draw_research_canvas', arguments: { canvasId: 'roadmap', sourceIds: ['private:salary-notes'] } });
    expect(denied.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });
});

describe('MCP scoped call outcomes', () => {
  it('records a tool result that reports an error as an error outcome', async () => {
    const onToolCall = vi.fn();
    const server = new McpServer({ name: 'scoped-errors', version: '1.0.0' });
    scopedRegistration(server, { allowedCanvasIds: ['roadmap'], onToolCall })
      .registerTool('read_doc', { annotations: { readOnlyHint: true }, inputSchema: { canvasId: z.string() } },
        async () => ({ isError: true, content: [{ type: 'text' as const, text: 'Document not found' }] }));
    const client = new Client({ name: 'scoped-client', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    connections.push({ client, server });
    const output = await client.callTool({ name: 'read_doc', arguments: { canvasId: 'roadmap' } });
    expect(output).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Document not found' }] });
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: 'read_doc', outcome: 'error',
      result: expect.objectContaining({ isError: true }) }));
  });
});
