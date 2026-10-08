import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { recordMcpRead } from './chat-mcp-citations.js';
import type { SymbiToolContext } from './symbi-mcp-client.js';

const connections: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => { for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); } });

/** A canonical read_canvas tool whose stored canvas has a malformed (non-text) name. */
async function canvasReader() {
  const reads: string[] = [];
  const server = new McpServer({ name: 'citation-canvases', version: '1.0.0' });
  server.registerTool('read_canvas', { inputSchema: { canvasId: z.string(), includeContent: z.boolean() } }, async ({ canvasId }) => {
    reads.push(canvasId);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ id: canvasId, name: 42, blocks: [] }) }] };
  });
  const client = new Client({ name: 'citation-client', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  connections.push({ client, server });
  return { client, reads };
}

function citationContext(): SymbiToolContext {
  const context: Pick<SymbiToolContext, 'canvasId' | 'query' | 'workdir' | 'navigationRequests' | 'researchPatches'> = {
    canvasId: 'research', query: 'What did interviews say?', workdir: '/tmp/symbi-conversation', navigationRequests: [], researchPatches: [] };
  return context as SymbiToolContext;
}

describe('MCP read citations', () => {
  it('falls back to the canvas ID when the canvas name is missing or not text, and omits evidence for a blank document', async () => {
    const { client, reads } = await canvasReader();
    const context = citationContext();
    await recordMcpRead(client, 'search_docs', { query: 'interviews' }, [{ canvasId: 'research', blockId: 'blank' }], context);
    expect(context.canvasNames).toBeUndefined();
    await recordMcpRead(client, 'read_canvas', { canvasId: 'research' }, null, context);
    expect(context.canvasNames?.has('research')).toBe(false);
    await recordMcpRead(client, 'read_doc', { canvasId: 'research', blockId: 'blank' },
      { id: 'blank', title: 'Blank interview', content: '   \n', contentHash: 'hash-blank' }, context);
    expect(reads).toEqual(['research']);
    expect(context.readSources).toEqual([{ canvasId: 'research', canvasName: 'research', blockId: 'blank', title: 'Blank interview',
      excerpt: '', relevance: 1, contentHash: 'hash-blank' }]);
  });

  it('uses a remembered canvas title without reading the canvas again and keeps exact evidence', async () => {
    const { client, reads } = await canvasReader();
    const context = citationContext();
    await recordMcpRead(client, 'read_canvas', { canvasId: 'roadmap' }, { id: 'roadmap', name: 'Product roadmap' }, context);
    await recordMcpRead(client, 'read_doc', { canvasId: 'roadmap', blockId: 'launch' },
      { id: 'launch', title: 'Launch checklist', content: '  Ship the beta in May.', contentHash: 'hash-launch' }, context);
    expect(reads).toEqual([]);
    expect(context.readSources).toEqual([expect.objectContaining({ canvasName: 'Product roadmap', excerpt: 'Ship the beta in May.',
      evidence: expect.objectContaining({ passage: 'Ship the beta in May.', passageKind: 'exact', start: 2, end: 23 }) })]);
  });
});
