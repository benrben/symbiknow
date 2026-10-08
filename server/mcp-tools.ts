import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isHtmlDocument } from '../shared/file-transfer.js';
import { CanvasApi, canvasPath, result } from './mcp-api.js';

const canvasId = z.string().min(1).describe('Canvas ID from list_canvases');
const blockId = z.string().min(1).describe('Document block ID');
function effectiveDocument<T extends { kind: string; content: string }>(block: T): T | (Omit<T, 'kind'> & { kind: 'html'; storageKind: string }) {
  return isHtmlDocument(block.content) ? { ...block, kind: 'html', storageKind: block.kind } : block;
}


async function changeLink(api: CanvasApi, id: string, fromId: string, toId: string, connect: boolean) {
  return api.request(`${canvasPath(id)}/links`, 'POST', { fromBlockId: fromId, toBlockId: toId, action: connect ? 'link' : 'unlink' });
}

export function registerDocumentTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('list_canvases', { _meta: { apiRoutes: [{"method":"GET","path":"/workspaces"}] }, annotations: { readOnlyHint: true }, description: 'List workspaces and canvases with document counts and the canvas metadata modification timestamp.' },
    async () => result(await api.request('/workspaces?stats=1')));
  server.registerTool('read_canvas', { _meta: { apiRoutes: [{"method":"GET","path":"/canvases/:canvasId"}] }, annotations: { readOnlyHint: true }, description: 'Read a canvas. Set includeContent=false for a compact metadata view; use read_doc for a complete source. limit/cursor paginate blocks.', inputSchema: {
    canvasId, includeContent: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
  } }, async ({ canvasId: id, includeContent, limit, cursor }) => {
    const query = new URLSearchParams();
    if (includeContent === false) query.set('includeContent', 'false');
    if (limit !== undefined) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    return result(await api.request(canvasPath(id) + (query.size ? `?${query}` : '')));
  });
  server.registerTool('search_docs', { _meta: { apiRoutes: [{"method":"GET","path":"/search"}] }, annotations: { readOnlyHint: true }, description: 'Locally search source text and metadata, with scoped bounded results and no provider call.', inputSchema: {
    query: z.string().min(1), canvasId: canvasId.optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
  } }, async ({ query, canvasId: id, limit, cursor }) => {
    return result(await api.request('/search?q=' + encodeURIComponent(query)
      + (id ? '&canvasId=' + encodeURIComponent(id) : '')
      + (limit !== undefined ? '&limit=' + limit : '')
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')));
  });
  server.registerTool('read_doc', { _meta: { apiRoutes: [{"method":"GET","path":"/canvases/:canvasId/blocks/:blockId"}], documentResult: true }, annotations: { readOnlyHint: true }, description: 'Read complete source, metadata, lock, and contentHash. Optional branch reads leave the shared visible document unchanged.', inputSchema: {
    canvasId, blockId, branch: z.string().optional(),
  } }, async ({ canvasId: id, blockId: docId, branch }) => result(effectiveDocument(branch
    ? await api.request<{ kind: string; content: string }>(canvasPath(id, docId) + '?branch=' + encodeURIComponent(branch)) : await api.block(id, docId))));
  server.registerTool('delete_doc', { _meta: { apiRoutes: [{"method":"DELETE","path":"/canvases/:canvasId/blocks/:blockId","bodyFields":["expectedContentHash"]}] }, description: 'Delete a document after reading its current contentHash. Existing references are reviewed before deletion.', inputSchema: { canvasId, blockId, expectedContentHash: z.string().min(1) } },
    async ({ canvasId: id, blockId: docId, expectedContentHash: hash }) => result(await api.request(canvasPath(id, docId), 'DELETE', { expectedContentHash: hash })));
  server.registerTool('move_block', { _meta: { apiRoutes: [{"method":"PUT","path":"/canvases/:canvasId/blocks/:blockId","bodyFields":["x","y"]}], documentResult: true }, description: 'Move a document on the infinite canvas.', inputSchema: {
    canvasId, blockId, x: z.number(), y: z.number(),
  } }, async ({ canvasId: id, blockId: docId, x, y }) => {
    const block = await api.request<{ id: string; x: number; y: number; metadataRevision?: number }>(canvasPath(id, docId), 'PUT', { x, y });
    return result({ blockId: block.id, x: block.x, y: block.y, metadataRevision: block.metadataRevision });
  });
  const linkSchema = { canvasId, fromBlockId: blockId, toBlockId: blockId };
  server.registerTool('move_document', {
    _meta: { apiRoutes: [{ method: 'POST', path: '/canvases/:canvasId/blocks/:blockId/move', bodyFields: ['targetCanvasId'] }] },
    description: 'Move a document to another permitted canvas while retaining its file, history, and references.',
    inputSchema: { canvasId, blockId, targetCanvasId: canvasId },
  }, async ({ canvasId: id, blockId: docId, targetCanvasId }) =>
    result(await api.request(canvasPath(id, docId) + '/move', 'POST', { targetCanvasId })));
  server.registerTool('link_blocks', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/links","bodyFields":["fromBlockId","toBlockId","action"],"equals":{"action":"link"}}] }, description: 'Connect two shared canvas documents.', inputSchema: linkSchema },
    async ({ canvasId: id, fromBlockId, toBlockId }) => result(await changeLink(api, id, fromBlockId, toBlockId, true)));
  server.registerTool('unlink_blocks', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/links","bodyFields":["fromBlockId","toBlockId","action"],"equals":{"action":"unlink"}}] }, description: 'Remove a directed connection between documents.', inputSchema: linkSchema },
    async ({ canvasId: id, fromBlockId, toBlockId }) => result(await changeLink(api, id, fromBlockId, toBlockId, false)));
}

export function registerCoordinationTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('claim_doc', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/blocks/:blockId/lock","bodyFields":["ttlSeconds","note","force"]}] }, description: 'Lock a document while you edit it. Others cannot change its content until you release it or the lock expires.', inputSchema: {
    canvasId, blockId, ttlSeconds: z.number().int().min(30).max(3600).optional().describe('Lock length, default 600'),
    note: z.string().max(200).optional(), force: z.boolean().optional().describe('Take over another agent’s lock'),
  } }, async ({ canvasId: id, blockId: docId, ...input }) => result(await api.request(canvasPath(id, docId) + '/lock', 'POST', input)));
  server.registerTool('release_doc', { _meta: { apiRoutes: [{"method":"DELETE","path":"/canvases/:canvasId/blocks/:blockId/lock","bodyFields":[]}] }, description: 'Release your document lock.', inputSchema: { canvasId, blockId, force: z.boolean().optional() } },
    async ({ canvasId: id, blockId: docId, force }) => result(await api.request(canvasPath(id, docId) + '/lock' + (force ? '?force=1' : ''), 'DELETE')));
}

export function registerVersionTools(server: McpServer, api: CanvasApi): void {
  const versionPath = (id: string, docId: string) => canvasPath(id, docId) + '/versions';
  server.registerTool('list_versions', { _meta: { apiRoutes: [{"method":"GET","path":"/canvases/:canvasId/blocks/:blockId/versions"}] }, annotations: { readOnlyHint: true }, description: 'List document branches and UTC ISO 8601 commits. Optional limit/cursor paginate revisions.', inputSchema: {
    canvasId, blockId, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
  } }, async ({ canvasId: id, blockId: docId, limit, cursor }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    return result(await api.request(versionPath(id, docId) + (params.size ? `?${params}` : '')));
  });
  const name = z.string().min(1).describe('Branch name');
  server.registerTool('create_branch', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/blocks/:blockId/versions/branches","bodyFields":["name"]}] }, description: 'Create a branch for one document file.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/branches', 'POST', { name: branch })));
  server.registerTool('delete_branch', { _meta: { apiRoutes: [{"method":"DELETE","path":"/canvases/:canvasId/blocks/:blockId/versions/branches/:name","bodyFields":[]}] }, description: 'Delete a fully merged non-current document branch. Current, main, and unmerged branches are protected.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/branches/' + encodeURIComponent(branch), 'DELETE')));
  server.registerTool('switch_branch', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/blocks/:blockId/versions/switch","bodyFields":["name"]}] }, description: 'Switch the shared visible document branch for everyone. Use branch-targeted download_file/upload_file for private branch editing.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/switch', 'POST', { name: branch })));
  server.registerTool('merge_branch', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/blocks/:blockId/versions/merge","bodyFields":["name"]}] }, description: 'Merge another branch of one document file. Conflicts leave it unchanged.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/merge', 'POST', { name: branch })));
  server.registerTool('restore_revision', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/blocks/:blockId/versions/restore","bodyFields":["revision"]}] }, description: 'Restore one document file to a prior revision as a new commit.', inputSchema: { canvasId, blockId, revision: z.string().min(7) } },
    async ({ canvasId: id, blockId: docId, revision }) => result(await api.request(versionPath(id, docId) + '/restore', 'POST', { revision })));
}
