import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isHtmlDocument, storedDocument } from '../shared/file-transfer.js';
import { CanvasApi, canvasPath, result } from './mcp-api.js';
import { uploadFile, downloadFile, type UploadArgs } from './mcp-files.js';

const canvasId = z.string().min(1).describe('Canvas ID from list_canvases');
const blockId = z.string().min(1).describe('Document block ID');
const content = z.string().max(999_900).describe('Complete file source, not a partial patch');
const expectedContentHash = z.string().optional()
  .describe('contentHash from read_doc. The write fails with a conflict if someone changed the file since you read it.');
const message = z.string().max(180).optional().describe('Revision message for this file’s history');
function effectiveDocument<T extends { kind: string; content: string }>(block: T): T | (Omit<T, 'kind'> & { kind: 'html'; storageKind: string }) {
  return isHtmlDocument(block.content) ? { ...block, kind: 'html', storageKind: block.kind } : block;
}


async function changeLink(api: CanvasApi, id: string, fromId: string, toId: string, connect: boolean) {
  return api.request(`${canvasPath(id)}/links`, 'POST', { fromBlockId: fromId, toBlockId: toId, action: connect ? 'link' : 'unlink' });
}

const kinds = z.enum(['markdown', 'html', 'slides', 'website', 'mdx']).describe(
  'Loader. markdown: Markdown. html: a complete HTML page, rendered interactively (saved as Markdown with format: html frontmatter). '
  + 'slides: a Marp deck. mdx: MDX with the built-in components. website: only for a documentation site that MkDocs, Hugo, or Docusaurus '
  + 'builds from a source folder named in frontmatter — never for an HTML page.');

export function registerDocumentTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('list_canvases', { description: 'List workspaces and canvases with document counts and the canvas metadata modification timestamp.' },
    async () => result(await api.request('/workspaces?stats=1')));
  server.registerTool('read_canvas', { description: 'Read a canvas. Set includeContent=false for a compact metadata view; use read_doc for a complete source. limit/cursor paginate blocks.', inputSchema: {
    canvasId, includeContent: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
  } }, async ({ canvasId: id, includeContent, limit, cursor }) => {
    const query = new URLSearchParams();
    if (includeContent === false) query.set('includeContent', 'false');
    if (limit !== undefined) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    return result(await api.request(canvasPath(id) + (query.size ? `?${query}` : '')));
  });
  server.registerTool('search_docs', { description: 'Locally search source text and metadata, with scoped bounded results and no provider call.', inputSchema: {
    query: z.string().min(1), canvasId: canvasId.optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
  } }, async ({ query, canvasId: id, limit, cursor }) => {
    return result(await api.request('/search?q=' + encodeURIComponent(query)
      + (id ? '&canvasId=' + encodeURIComponent(id) : '')
      + (limit !== undefined ? '&limit=' + limit : '')
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')));
  });
  server.registerTool('read_doc', { description: 'Read complete source, metadata, lock, and contentHash. Optional branch reads leave the shared visible document unchanged.', inputSchema: {
    canvasId, blockId, branch: z.string().optional(),
  } }, async ({ canvasId: id, blockId: docId, branch }) => result(effectiveDocument(branch
    ? await api.request<{ kind: string; content: string }>(canvasPath(id, docId) + '?branch=' + encodeURIComponent(branch)) : await api.block(id, docId))));
  server.registerTool('create_doc', { description: 'Create a document on the shared canvas. For an HTML page, set kind to html (or use upload_file with a .html filename).', inputSchema: {
    canvasId, title: z.string().min(1), content: content.optional(), kind: kinds.optional(), x: z.number().optional(), y: z.number().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  } }, async ({ canvasId: id, ...input }) => result(effectiveDocument(await api.request<{ kind: string; content: string }>(canvasPath(id) + '/blocks', 'POST', storedDocument(input)))));
  server.registerTool('import_documents', { description: 'Import up to 20 documents with per-document idempotency keys. Returns compact durable receipts and per-document errors.', inputSchema: {
    canvasId, documents: z.array(z.object({ title: z.string().min(1), content: content.optional(), kind: kinds.optional(),
      idempotencyKey: z.string().min(1).max(128), x: z.number().optional(), y: z.number().optional() })).min(1).max(20),
  } }, async ({ canvasId: id, documents }) => result(await api.request(canvasPath(id) + '/imports', 'POST', {
    documents: documents.map(document => storedDocument(document)),
  })));
  server.registerTool('edit_doc', { description: 'Edit document title, kind, or complete source. Use upload_file to replace a whole local file.', inputSchema: {
    canvasId, blockId, title: z.string().min(1).optional(), content: content.optional(), kind: kinds.optional(), expectedContentHash, message,
    branch: z.string().optional(),
  } }, async ({ canvasId: id, blockId: docId, ...patch }) => {
    if (!patch.expectedContentHash) throw new Error('expectedContentHash from read_doc is required for edit_doc.');
    const { branch, ...edit } = patch;
    return result(effectiveDocument(await api.request<{ kind: string; content: string }>(canvasPath(id, docId)
      + (branch ? '?branch=' + encodeURIComponent(branch) : ''), 'PUT', storedDocument(edit))));
  });
  server.registerTool('delete_doc', { description: 'Delete a document after reading its current contentHash. Existing references are reviewed before deletion.', inputSchema: { canvasId, blockId, expectedContentHash: z.string().min(1) } },
    async ({ canvasId: id, blockId: docId, expectedContentHash: hash }) => result(await api.request(canvasPath(id, docId), 'DELETE', { expectedContentHash: hash })));
  server.registerTool('move_block', { description: 'Move a document on the infinite canvas.', inputSchema: {
    canvasId, blockId, x: z.number(), y: z.number(),
  } }, async ({ canvasId: id, blockId: docId, x, y }) => {
    const block = await api.request<{ id: string; x: number; y: number; metadataRevision?: number }>(canvasPath(id, docId), 'PUT', { x, y });
    return result({ blockId: block.id, x: block.x, y: block.y, metadataRevision: block.metadataRevision });
  });
  const linkSchema = { canvasId, fromBlockId: blockId, toBlockId: blockId };
  server.registerTool('link_blocks', { description: 'Connect two shared canvas documents.', inputSchema: linkSchema },
    async ({ canvasId: id, fromBlockId, toBlockId }) => result(await changeLink(api, id, fromBlockId, toBlockId, true)));
  server.registerTool('unlink_blocks', { description: 'Remove a directed connection between documents.', inputSchema: linkSchema },
    async ({ canvasId: id, fromBlockId, toBlockId }) => result(await changeLink(api, id, fromBlockId, toBlockId, false)));
}

export function registerFileTools(server: McpServer, api: CanvasApi, localFiles: boolean): void {
  const uploadSchema = {
    canvasId, blockId: blockId.optional().describe('Set to replace the entire saved document'), filename: z.string().optional()
      .describe('Name ending in .md, .mdx, or .html'), content: content.optional(), title: z.string().min(1).optional(),
    x: z.number().optional(), y: z.number().optional(), expectedContentHash, message,
    idempotencyKey: z.string().min(1).max(128).optional(),
    ...(localFiles ? { sourcePath: z.string().optional().describe('Local file to read instead of content') } : {}),
  };
  server.registerTool('upload_file', { description: localFiles
    ? 'Upload a .md, .mdx, or .html file. Set blockId to replace the entire saved document. Provide complete content or a local sourcePath.'
    : 'Upload a .md, .mdx, or .html file as complete content with a filename. Set blockId to replace the entire saved document.', inputSchema: uploadSchema },
  async args => result(await uploadFile(api, args as UploadArgs)));
  server.registerTool('download_file', { description: localFiles
    ? 'Return a document’s full saved source and contentHash. Optionally write it to a local destinationPath; overwrite requires true.'
    : 'Return a document’s full saved source, filename, and contentHash.', inputSchema: {
    canvasId, blockId, ...(localFiles ? { destinationPath: z.string().optional(), overwrite: z.boolean().optional() } : {}),
  } }, async args => result(await downloadFile(api, args as { canvasId: string; blockId: string })));
}

export function registerCoordinationTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('claim_doc', { description: 'Lock a document while you edit it. Others cannot change its content until you release it or the lock expires.', inputSchema: {
    canvasId, blockId, ttlSeconds: z.number().int().min(30).max(3600).optional().describe('Lock length, default 600'),
    note: z.string().max(200).optional(), force: z.boolean().optional().describe('Take over another agent’s lock'),
  } }, async ({ canvasId: id, blockId: docId, ...input }) => result(await api.request(canvasPath(id, docId) + '/lock', 'POST', input)));
  server.registerTool('release_doc', { description: 'Release your document lock.', inputSchema: { canvasId, blockId, force: z.boolean().optional() } },
    async ({ canvasId: id, blockId: docId, force }) => result(await api.request(canvasPath(id, docId) + '/lock' + (force ? '?force=1' : ''), 'DELETE')));
  const taskId = z.string().min(1).describe('Task ID from list_tasks');
  const status = z.enum(['todo', 'in_progress', 'blocked', 'done']);
  server.registerTool('list_tasks', { description: 'List tasks. Optional filters and limit/cursor return a bounded page.', inputSchema: {
    canvasId, status: status.optional(), assignee: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
  } }, async ({ canvasId: id, status: state, assignee, limit, cursor }) => {
    const params = new URLSearchParams();
    if (state) params.set('status', state);
    if (assignee) params.set('assignee', assignee);
    if (limit !== undefined) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    return result(await api.request(canvasPath(id) + '/tasks' + (params.size ? `?${params}` : '')));
  });
  server.registerTool('create_task', { description: 'Add a task to the canvas board so people and agents can coordinate.', inputSchema: {
    canvasId, title: z.string().min(1).max(160), detail: z.string().max(4000).optional(), status: status.optional(),
    assignee: z.string().max(48).optional(), blockIds: z.array(z.string()).max(20).optional().describe('Related documents'),
    boardOrder: z.number().finite().optional(),
  } }, async ({ canvasId: id, ...input }) => result(await api.request(canvasPath(id) + '/tasks', 'POST', input)));
  server.registerTool('update_task', { description: 'Change a task’s title, detail, status, assignee, or related documents.', inputSchema: {
    canvasId, taskId, title: z.string().min(1).max(160).optional(), detail: z.string().max(4000).optional(), status: status.optional(),
    assignee: z.string().max(48).nullable().optional(), blockIds: z.array(z.string()).max(20).optional(),
    boardOrder: z.number().finite().optional(), expectedRevision: z.number().int().nonnegative().optional(),
  } }, async ({ canvasId: id, taskId: task, ...input }) => result(await api.request(`${canvasPath(id)}/tasks/${encodeURIComponent(task)}`, 'PUT', input)));
  server.registerTool('delete_task', { description: 'Delete a task after reviewing its revision. Comments and document references remain in durable task audit history.', inputSchema: {
    canvasId, taskId, expectedRevision: z.number().int().nonnegative(),
  } }, async ({ canvasId: id, taskId: task, expectedRevision }) => result(await api.request(`${canvasPath(id)}/tasks/${encodeURIComponent(task)}`, 'DELETE', { expectedRevision })));
  server.registerTool('task_history', { description: 'Read bounded, durable task changes and Undo event IDs.', inputSchema: {
    canvasId, taskId, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
  } }, async ({ canvasId: id, taskId: task, limit, cursor }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    return result(await api.request(`${canvasPath(id)}/tasks/${encodeURIComponent(task)}/history` + (params.size ? `?${params}` : '')));
  });
  server.registerTool('undo_task', { description: 'Undo the latest task change when every affected task still matches the reviewed event.', inputSchema: {
    canvasId, taskId, eventId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
  } }, async ({ canvasId: id, taskId: task, eventId, expectedRevision }) => result(await api.request(
    `${canvasPath(id)}/tasks/${encodeURIComponent(task)}/undo`, 'POST', { eventId, expectedRevision })));
  server.registerTool('claim_task', { description: 'Assign a task to yourself and mark it in progress.', inputSchema: { canvasId, taskId, force: z.boolean().optional() } },
    async ({ canvasId: id, taskId: task, force }) => result(await api.request(`${canvasPath(id)}/tasks/${encodeURIComponent(task)}/claim`, 'POST', { force: force ?? false })));
  server.registerTool('comment_task', { description: 'Add a progress note to a task.', inputSchema: { canvasId, taskId, text: z.string().min(1).max(2000) } },
    async ({ canvasId: id, taskId: task, text }) => result(await api.request(`${canvasPath(id)}/tasks/${encodeURIComponent(task)}/comments`, 'POST', { text })));
}

export function registerVersionTools(server: McpServer, api: CanvasApi): void {
  const versionPath = (id: string, docId: string) => canvasPath(id, docId) + '/versions';
  server.registerTool('list_versions', { description: 'List document branches and UTC ISO 8601 commits. Optional limit/cursor paginate revisions.', inputSchema: {
    canvasId, blockId, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
  } }, async ({ canvasId: id, blockId: docId, limit, cursor }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    return result(await api.request(versionPath(id, docId) + (params.size ? `?${params}` : '')));
  });
  const name = z.string().min(1).describe('Branch name');
  server.registerTool('create_branch', { description: 'Create a branch for one document file.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/branches', 'POST', { name: branch })));
  server.registerTool('delete_branch', { description: 'Delete a fully merged non-current document branch. Current, main, and unmerged branches are protected.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/branches/' + encodeURIComponent(branch), 'DELETE')));
  server.registerTool('switch_branch', { description: 'Legacy workspace mutation: switch the shared visible document branch for everyone. For private branch work, use read_doc/edit_doc with branch.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/switch', 'POST', { name: branch })));
  server.registerTool('merge_branch', { description: 'Merge another branch of one document file. Conflicts leave it unchanged.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/merge', 'POST', { name: branch })));
  server.registerTool('restore_revision', { description: 'Restore one document file to a prior revision as a new commit.', inputSchema: { canvasId, blockId, revision: z.string().min(7) } },
    async ({ canvasId: id, blockId: docId, revision }) => result(await api.request(versionPath(id, docId) + '/restore', 'POST', { revision })));
}
