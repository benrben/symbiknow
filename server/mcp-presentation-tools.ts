import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CanvasDocument } from '../shared/types.js';
import { storedDocument } from '../shared/file-transfer.js';
import { groupLabel, groupPath, normalizedGroup } from '../shared/groups.js';
import { ApiRequestError, CanvasApi, canvasPath, result } from './mcp-api.js';

const canvasId = z.string().min(1);
function presentation(value: Record<string, unknown>) {
  return { ...result(value), structuredContent: { presentation: value } };
}
function resolveGroup(canvas: CanvasDocument, requested: string): string | undefined {
  const groups = [...new Set(canvas.blocks.flatMap(block => groupPath(normalizedGroup(block.group) ?? '__ungrouped')))];
  if (groups.includes(requested)) return requested;
  const comparable = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return groups.find(group => comparable(canvas.groupLabels?.[group] ?? groupLabel(group)) === comparable(requested));
}
async function checkedSourceIds(api: CanvasApi, sourceIds: string[]): Promise<Set<string>> {
  const checked = await Promise.all([...new Set(sourceIds)].map(async id => {
    const separator = id.indexOf(':');
    if (separator <= 0 || separator === id.length - 1) return undefined;
    try { await api.block(id.slice(0, separator), id.slice(separator + 1)); return id; }
    catch (error) { if (error instanceof ApiRequestError && [403, 404].includes(error.status)) return undefined; throw error; }
  }));
  return new Set(checked.filter((id): id is string => id !== undefined));
}

export function registerPresentationTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('show_doc_on_canvas', { _meta: { apiRoutes: [{"method":"GET","path":"/canvases/:canvasId/blocks/:blockId"}], presentation: true }, description: 'Return a document navigation request and deep link. Connected UIs reveal the document; no saved content changes.',
    
    annotations: { readOnlyHint: true },
    inputSchema: { canvasId, blockId: z.string().min(1) } }, async ({ canvasId: id, blockId }) => {
    const block = await api.block(id, blockId);
    if (block.archived) throw new Error('Archived documents cannot be shown on the canvas');
    return presentation({ navigation: { kind: 'document', canvasId: id, blockId, title: block.title },
      url: `/?canvas=${encodeURIComponent(id)}&document=${encodeURIComponent(blockId)}` });
  });
  server.registerTool('show_group_on_canvas', { _meta: { apiRoutes: [{"method":"GET","path":"/canvases/:canvasId"}], presentation: true }, description: 'Return a group navigation request. Accept the stored group key or its displayed title.',
    
    annotations: { readOnlyHint: true },
    inputSchema: { canvasId, group: z.string().min(1) } }, async ({ canvasId: id, group: requested }) => {
    const canvas = await api.request<CanvasDocument>(canvasPath(id));
    const group = resolveGroup(canvas, requested);
    if (!group) throw new Error('Group not found on the requested canvas');
    return presentation({ navigation: { kind: 'group', canvasId: id, group, title: canvas.groupLabels?.[group] ?? groupLabel(group) },
      url: `/?canvas=${encodeURIComponent(id)}&group=${encodeURIComponent(group)}` });
  });
  server.registerTool('draw_research_canvas', { description: 'Return a session research graph for a connected UI, with typed source blocks and meaningful edges. Does not overwrite saved documents.',
    _meta: { apiRoutes: [{ method: 'GET', path: '/canvases/:canvasId' }, { method: 'GET', path: '/canvases/:canvasId/blocks/:blockId' }], presentation: true },
    annotations: { readOnlyHint: true },
    inputSchema: { canvasId, query: z.string().min(1), layout: z.enum(['roadmap', 'kanban', 'architecture', 'mindmap']).optional(),
      blocks: z.array(z.object({ id: z.string().min(1).max(64), type: z.enum(['text', 'diagram', 'task', 'section']),
        kind: z.enum(['markdown', 'html', 'slides', 'website', 'mdx']).optional(), title: z.string().min(1).max(160),
        content: z.string().min(1).max(20_000), sourceIds: z.array(z.string()).max(12), lane: z.string().max(64).optional() })).min(1).max(12),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(80).optional() })).max(24) },
  }, async ({ canvasId: id, query, layout, blocks, edges }) => {
    await api.request(canvasPath(id) + '?includeContent=false');
    const ids = new Set(blocks.map(block => block.id));
    if (ids.size !== blocks.length) throw new Error('Research block IDs must be unique');
    if (edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)) throw new Error('Research edges must connect distinct existing blocks');
    const sources = await checkedSourceIds(api, blocks.flatMap(block => block.sourceIds));
    return presentation({ researchPatch: { query, layout, blocks: blocks.map(block => ({ ...block,
      ...storedDocument({ kind: block.kind, content: block.content }), sourceIds: [...new Set(block.sourceIds)].filter(source => sources.has(source)) })), edges } });
  });
}
