import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CanvasApi } from './mcp-api.js';
import { registerPresentationTools } from './mcp-presentation-tools.js';

const roadmap = {
  id: 'roadmap', name: 'Product roadmap', groupLabels: { 'area:launch_plan': 'Launch Plan!' },
  blocks: [
    { id: 'launch', title: 'Launch checklist', content: '# Launch', group: 'area:launch_plan' },
    { id: 'standup', title: 'Standup notes', content: '# Standup', group: 'work' },
    { id: 'loose', title: 'Loose idea', content: '# Idea' },
  ],
};
const documents: Record<string, { status: number; body: Record<string, unknown> }> = {
  launch: { status: 200, body: { id: 'launch', title: 'Launch checklist', content: '# Launch' } },
  retired: { status: 200, body: { id: 'retired', title: 'Retired plan', content: '# Old', archived: true } },
  missing: { status: 404, body: { error: 'Document not found' } },
  restricted: { status: 403, body: { error: 'Forbidden' } },
  broken: { status: 500, body: { error: 'Storage failed while reading the document' } },
};

/** Canvas API boundary that answers like the real routes for one canvas. */
const fetcher = (async (input: string) => {
  const { pathname } = new URL(input);
  const block = /^\/api\/canvases\/roadmap\/blocks\/([^/]+)$/.exec(pathname);
  if (block) return Response.json(documents[block[1]].body, { status: documents[block[1]].status });
  if (pathname === '/api/canvases/roadmap') return Response.json(roadmap);
  return Response.json({ error: 'Canvas not found' }, { status: 404 });
}) as unknown as typeof fetch;

const connections: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => { for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); } });

async function connect() {
  const server = new McpServer({ name: 'presentation-tools', version: '1.0.0' });
  registerPresentationTools(server, new CanvasApi('http://127.0.0.1:8787/api', fetcher, {}));
  const client = new Client({ name: 'presentation-client', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  connections.push({ client, server });
  return async (name: string, args: Record<string, unknown>) => {
    const output = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { presentation: Record<string, unknown> } };
    return { isError: output.isError === true, text: output.content[0].text, presentation: output.structuredContent?.presentation };
  };
}

describe('show_group_on_canvas', () => {
  it('accepts a stored key, a saved label, or a default label written in another style', async () => {
    const call = await connect();
    expect((await call('show_group_on_canvas', { canvasId: 'roadmap', group: 'lane:work' })).presentation).toEqual({
      navigation: { kind: 'group', canvasId: 'roadmap', group: 'lane:work', title: 'Active work' }, url: '/?canvas=roadmap&group=lane%3Awork' });
    expect((await call('show_group_on_canvas', { canvasId: 'roadmap', group: '  launch   plan ' })).presentation)
      .toMatchObject({ navigation: { group: 'area:launch_plan', title: 'Launch Plan!' } });
    expect((await call('show_group_on_canvas', { canvasId: 'roadmap', group: 'ACTIVE-WORK' })).presentation)
      .toMatchObject({ navigation: { group: 'lane:work', title: 'Active work' } });
  });

  it('reports a group that is not on the canvas', async () => {
    const call = await connect();
    const output = await call('show_group_on_canvas', { canvasId: 'roadmap', group: 'Quarterly budget' });
    expect(output).toMatchObject({ isError: true, presentation: undefined });
    expect(output.text).toContain('Group not found on the requested canvas');
  });
});

describe('show_doc_on_canvas', () => {
  it('links to a live document and refuses an archived one', async () => {
    const call = await connect();
    expect((await call('show_doc_on_canvas', { canvasId: 'roadmap', blockId: 'launch' })).presentation).toEqual({
      navigation: { kind: 'document', canvasId: 'roadmap', blockId: 'launch', title: 'Launch checklist' }, url: '/?canvas=roadmap&document=launch' });
    const archived = await call('show_doc_on_canvas', { canvasId: 'roadmap', blockId: 'retired' });
    expect(archived.isError).toBe(true);
    expect(archived.text).toContain('Archived documents cannot be shown on the canvas');
  });
});

describe('draw_research_canvas', () => {
  const block = (id: string, sourceIds: string[] = []) => ({ id, type: 'text', title: `Finding ${id}`, content: `Evidence for ${id}`, sourceIds });

  it('keeps only readable, well-formed source IDs on each research block', async () => {
    const call = await connect();
    const output = await call('draw_research_canvas', { canvasId: 'roadmap', query: 'launch risks', blocks: [
      block('risk', ['roadmap:launch', 'roadmap:launch', 'roadmap:missing', 'roadmap:restricted', 'launch', ':launch', 'roadmap:']),
      { ...block('page'), kind: 'html', content: '<p>Launch page</p>' },
    ], edges: [{ from: 'risk', to: 'page', label: 'explains' }] });
    const patch = output.presentation!.researchPatch as { blocks: Array<{ id: string; kind?: string; sourceIds: string[] }>; edges: unknown[] };
    expect(patch.blocks.map(item => [item.id, item.sourceIds])).toEqual([['risk', ['roadmap:launch']], ['page', []]]);
    expect(patch.blocks[1].kind).toBe('markdown');
    expect(patch.edges).toEqual([{ from: 'risk', to: 'page', label: 'explains' }]);
  });

  it.each([
    ['duplicate block IDs', [block('risk'), block('risk')], [], 'Research block IDs must be unique'],
    ['an edge to an unknown block', [block('risk')], [{ from: 'risk', to: 'ghost' }], 'Research edges must connect distinct existing blocks'],
    ['an edge from an unknown block', [block('risk')], [{ from: 'ghost', to: 'risk' }], 'Research edges must connect distinct existing blocks'],
    ['a self edge', [block('risk')], [{ from: 'risk', to: 'risk' }], 'Research edges must connect distinct existing blocks'],
    ['an unreadable source', [block('risk', ['roadmap:broken'])], [], 'Storage failed while reading the document'],
  ])('refuses %s', async (_case, blocks, edges, message) => {
    const call = await connect();
    const output = await call('draw_research_canvas', { canvasId: 'roadmap', query: 'launch risks', blocks, edges });
    expect(output.isError).toBe(true);
    expect(output.text).toContain(message);
  });
});
