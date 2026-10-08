import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { discoverMcpTools, mcpResultValue } from './mcp-client-tools.js';

const connections: Array<{ client: Client; server: Server }> = [];
afterEach(async () => { for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); } });

const tool = (name: string) => ({ name, description: `Run ${name}`, inputSchema: { type: 'object' as const, properties: {} } });

async function pagedServer(pages: Record<string, { names: string[]; nextCursor?: string }>) {
  const server = new Server({ name: 'paged-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    const page = pages[request.params?.cursor ?? 'first'];
    return { tools: page.names.map(tool), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  });
  const client = new Client({ name: 'discovery-client', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  connections.push({ client, server });
  return client;
}

describe('MCP tool discovery', () => {
  it('follows every page of the catalog', async () => {
    const client = await pagedServer({ first: { names: ['read_doc'], nextCursor: 'page-2' }, 'page-2': { names: ['edit_doc'] } });
    expect((await discoverMcpTools(client)).map(item => item.name)).toEqual(['read_doc', 'edit_doc']);
  });

  it('refuses a catalog that repeats a pagination cursor instead of looping forever', async () => {
    const client = await pagedServer({ first: { names: ['read_doc'], nextCursor: 'page-2' }, 'page-2': { names: ['edit_doc'], nextCursor: 'page-2' } });
    await expect(discoverMcpTools(client)).rejects.toThrow('MCP tool discovery returned a repeated pagination cursor.');
  });
});

describe('MCP tool result values', () => {
  it('prefers structured content, parses JSON text, keeps plain text, and passes other content through', () => {
    expect(mcpResultValue({ structuredContent: { id: 'doc' }, content: [{ type: 'text', text: '{"id":"ignored"}' }] })).toEqual({ id: 'doc' });
    expect(mcpResultValue({ content: [{ type: 'text', text: '{"id":' }, { type: 'image', data: 'x' }, { type: 'text', text: '"doc"}' }] })).toEqual({ id: 'doc' });
    expect(mcpResultValue({ content: [{ type: 'text', text: 'Saved revision 4' }] })).toBe('Saved revision 4');
    expect(mcpResultValue({ content: 'legacy text result' })).toBe('legacy text result');
    expect(mcpResultValue({})).toBeUndefined();
  });
});
