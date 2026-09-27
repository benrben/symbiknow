import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { storedDocument, uploadedSource } from '../shared/file-transfer.js';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import type { AutomationKind } from '../shared/insights.js';

const defaultApi = `http://127.0.0.1:${process.env.PORT || '8787'}/api`;
const canvasId = z.string().min(1).describe('Canvas ID from list_canvases');
const workspaceId = z.string().min(1).describe('Workspace ID from list_canvases');
const blockId = z.string().min(1).describe('Document block ID');
const content = z.string().max(999_900).describe('Complete file source, not a partial patch');
const expectedContentHash = z.string().optional()
  .describe('contentHash from read_doc. The write fails with a conflict if someone changed the file since you read it.');
const message = z.string().max(180).optional().describe('Revision message for this file’s history');
const groupBy = z.enum(['work_area', 'purpose', 'lane']).optional()
  .describe('Group documents by Jev work area (default), purpose, or reading lane');

const instructions = `SymbiKnow is an infinite canvas where people and AI organize ideas and build knowledge together. Each document is a Markdown file that people and agents can connect, group, edit, and review.
Workflow for editing safely:
1. list_canvases, then read_canvas or search_docs to find documents. read_doc returns contentHash.
2. claim_doc before a longer edit so other agents see you are working on it; release_doc when done.
3. edit_doc or upload_file with expectedContentHash to avoid overwriting someone else's change. Every content change is a Git revision attributed to you.
4. Coordinate work with list_tasks, create_task, claim_task, update_task, and comment_task.
Each document has its own Git history: list_versions, create_branch, switch_branch, merge_branch, restore_revision.
Jev tools (regroup_canvas, organize_canvas, connect_documents, classify_work_areas, label_purposes, assign_reviewers) change the canvas immediately.
find_duplicates, connect_across_canvases, and score_documents only suggest or score. merge_documents changes saved files and requires reviewed content hashes; undo_merge reverts a merge by its returned mergeId if those files remain unchanged.
run_workspace_automation previews by default; apply only selected action IDs from that preview with dryRun false.`;

const knownClients: Record<string, string> = {
  'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'codex-mcp-client': 'Codex', codex: 'Codex', cursor: 'Cursor', 'cursor-vscode': 'Cursor',
};

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function canvasPath(id: string, docId?: string): string {
  const base = `/canvases/${encodeURIComponent(id)}`;
  return docId ? `${base}/blocks/${encodeURIComponent(docId)}` : base;
}

class CanvasApi {
  constructor(private readonly base: string, private readonly fetcher: typeof fetch,
    private readonly headers: () => Record<string, string>) {}

  async request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try { response = await this.fetcher(this.base + route, { method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new Error(`Canvas API is unavailable at ${this.base}`); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || `Canvas API request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }

  async block(id: string, docId: string): Promise<CanvasBlock> {
    const canvas = await this.request<CanvasDocument>(canvasPath(id));
    const block = canvas.blocks.find(item => item.id === docId);
    if (!block) throw new Error('Document not found.');
    return block;
  }
}

type UploadArgs = { canvasId: string; blockId?: string; filename?: string; sourcePath?: string;
  content?: string; title?: string; x?: number; y?: number; expectedContentHash?: string; message?: string };

async function uploadInput(args: UploadArgs) {
  if (args.content !== undefined && args.sourcePath !== undefined) throw new Error('Provide content or sourcePath, not both.');
  if (args.content === undefined && args.sourcePath === undefined) throw new Error('Provide the complete file content.');
  let source = args.content;
  if (args.sourcePath !== undefined) {
    const file = path.resolve(args.sourcePath);
    if ((await stat(file)).size > 999_900) throw new Error('The file is too large for a canvas document.');
    source = await readFile(file, 'utf8');
  }
  const filename = args.filename ?? (args.sourcePath ? path.basename(args.sourcePath) : undefined);
  if (!filename) throw new Error('filename is required when uploading content.');
  return uploadedSource(filename, source!);
}

async function uploadFile(api: CanvasApi, args: UploadArgs) {
  const source = await uploadInput(args);
  const title = args.title ?? source.title;
  if (args.blockId) return { ...(await api.request<CanvasBlock>(canvasPath(args.canvasId, args.blockId), 'PUT', {
    content: source.content, kind: source.kind, ...(args.title === undefined ? {} : { title }),
    ...(args.expectedContentHash ? { expectedContentHash: args.expectedContentHash } : {}), ...(args.message ? { message: args.message } : {}),
  })), overwritten: true };
  return { ...(await api.request<CanvasBlock>(canvasPath(args.canvasId) + '/blocks', 'POST', {
    title, kind: source.kind, content: source.content, x: args.x, y: args.y,
  })), overwritten: false };
}

async function downloadFile(api: CanvasApi, args: { canvasId: string; blockId: string; destinationPath?: string; overwrite?: boolean }) {
  const block = await api.block(args.canvasId, args.blockId);
  const filename = path.basename(block.file);
  if (args.destinationPath) await writeFile(path.resolve(args.destinationPath), block.content, { flag: args.overwrite ? 'w' : 'wx' });
  return { blockId: block.id, filename, title: block.title, kind: block.kind, contentHash: block.contentHash,
    content: block.content, ...(args.destinationPath ? { savedTo: path.resolve(args.destinationPath) } : {}) };
}

async function changeLink(api: CanvasApi, id: string, fromId: string, toId: string, connect: boolean) {
  const canvas = await api.request<CanvasDocument>(canvasPath(id));
  const source = canvas.blocks.find(block => block.id === fromId);
  if (!source || !canvas.blocks.some(block => block.id === toId)) throw new Error('Both documents must exist on the canvas.');
  const links = connect ? [...new Set([...source.links, toId])] : source.links.filter(link => link !== toId);
  return api.request<CanvasBlock>(canvasPath(id, fromId), 'PUT', { links });
}

const kinds = z.enum(['markdown', 'html', 'slides', 'website', 'mdx']).describe(
  'Loader. markdown: Markdown. html: a complete HTML page, rendered interactively (saved as Markdown with format: html frontmatter). '
  + 'slides: a Marp deck. mdx: MDX with the built-in components. website: only for a documentation site that MkDocs, Hugo, or Docusaurus '
  + 'builds from a source folder named in frontmatter — never for an HTML page.');

function registerDocumentTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('list_canvases', { description: 'List shared workspaces and canvases.' },
    async () => result(await api.request('/workspaces')));
  server.registerTool('read_canvas', { description: 'Read all documents, positions, groups, links, and locks on a canvas.', inputSchema: { canvasId } },
    async ({ canvasId: id }) => result(await api.request(canvasPath(id))));
  server.registerTool('search_docs', { description: 'Search documents across every shared canvas.', inputSchema: { query: z.string().min(1) } },
    async ({ query }) => result(await api.request('/search?q=' + encodeURIComponent(query))));
  server.registerTool('read_doc', { description: 'Read a document’s full source, metadata, lock, and contentHash.', inputSchema: { canvasId, blockId } },
    async ({ canvasId: id, blockId: docId }) => result(await api.block(id, docId)));
  server.registerTool('create_doc', { description: 'Create a document on the shared canvas. For an HTML page, set kind to html (or use upload_file with a .html filename).', inputSchema: {
    canvasId, title: z.string().min(1), content: content.optional(), kind: kinds.optional(), x: z.number().optional(), y: z.number().optional(),
  } }, async ({ canvasId: id, ...input }) => result(await api.request(canvasPath(id) + '/blocks', 'POST', storedDocument(input))));
  server.registerTool('edit_doc', { description: 'Edit document title, kind, or complete source. Use upload_file to replace a whole local file.', inputSchema: {
    canvasId, blockId, title: z.string().min(1).optional(), content: content.optional(), kind: kinds.optional(), expectedContentHash, message,
  } }, async ({ canvasId: id, blockId: docId, ...patch }) => result(await api.request(canvasPath(id, docId), 'PUT', storedDocument(patch))));
  server.registerTool('delete_doc', { description: 'Delete a document and its saved Markdown file.', inputSchema: { canvasId, blockId } },
    async ({ canvasId: id, blockId: docId }) => result(await api.request(canvasPath(id, docId), 'DELETE')));
  server.registerTool('move_block', { description: 'Move a document on the infinite canvas.', inputSchema: {
    canvasId, blockId, x: z.number(), y: z.number(),
  } }, async ({ canvasId: id, blockId: docId, x, y }) => result(await api.request(canvasPath(id, docId), 'PUT', { x, y })));
  const linkSchema = { canvasId, fromBlockId: blockId, toBlockId: blockId };
  server.registerTool('link_blocks', { description: 'Connect two shared canvas documents.', inputSchema: linkSchema },
    async ({ canvasId: id, fromBlockId, toBlockId }) => result(await changeLink(api, id, fromBlockId, toBlockId, true)));
  server.registerTool('unlink_blocks', { description: 'Remove a directed connection between documents.', inputSchema: linkSchema },
    async ({ canvasId: id, fromBlockId, toBlockId }) => result(await changeLink(api, id, fromBlockId, toBlockId, false)));
}

function registerFileTools(server: McpServer, api: CanvasApi, localFiles: boolean): void {
  const uploadSchema = {
    canvasId, blockId: blockId.optional().describe('Set to replace the entire saved document'), filename: z.string().optional()
      .describe('Name ending in .md, .mdx, or .html'), content: content.optional(), title: z.string().min(1).optional(),
    x: z.number().optional(), y: z.number().optional(), expectedContentHash, message,
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

function registerCoordinationTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('claim_doc', { description: 'Lock a document while you edit it. Others cannot change its content until you release it or the lock expires.', inputSchema: {
    canvasId, blockId, ttlSeconds: z.number().int().min(30).max(3600).optional().describe('Lock length, default 600'),
    note: z.string().max(200).optional(), force: z.boolean().optional().describe('Take over another agent’s lock'),
  } }, async ({ canvasId: id, blockId: docId, ...input }) => result(await api.request(canvasPath(id, docId) + '/lock', 'POST', input)));
  server.registerTool('release_doc', { description: 'Release your document lock.', inputSchema: { canvasId, blockId, force: z.boolean().optional() } },
    async ({ canvasId: id, blockId: docId, force }) => result(await api.request(canvasPath(id, docId) + '/lock' + (force ? '?force=1' : ''), 'DELETE')));
  const taskId = z.string().min(1).describe('Task ID from list_tasks');
  const status = z.enum(['todo', 'in_progress', 'blocked', 'done']);
  server.registerTool('list_tasks', { description: 'List the shared task board for a canvas, including who claimed each task.', inputSchema: { canvasId } },
    async ({ canvasId: id }) => result(await api.request(canvasPath(id) + '/tasks')));
  server.registerTool('create_task', { description: 'Add a task to the canvas board so people and agents can coordinate.', inputSchema: {
    canvasId, title: z.string().min(1).max(160), detail: z.string().max(4000).optional(), status: status.optional(),
    assignee: z.string().max(48).optional(), blockIds: z.array(z.string()).max(20).optional().describe('Related documents'),
  } }, async ({ canvasId: id, ...input }) => result(await api.request(canvasPath(id) + '/tasks', 'POST', input)));
  server.registerTool('update_task', { description: 'Change a task’s title, detail, status, assignee, or related documents.', inputSchema: {
    canvasId, taskId, title: z.string().min(1).max(160).optional(), detail: z.string().max(4000).optional(), status: status.optional(),
    assignee: z.string().max(48).nullable().optional(), blockIds: z.array(z.string()).max(20).optional(),
  } }, async ({ canvasId: id, taskId: task, ...input }) => result(await api.request(`${canvasPath(id)}/tasks/${encodeURIComponent(task)}`, 'PUT', input)));
  server.registerTool('claim_task', { description: 'Assign a task to yourself and mark it in progress.', inputSchema: { canvasId, taskId, force: z.boolean().optional() } },
    async ({ canvasId: id, taskId: task, force }) => result(await api.request(`${canvasPath(id)}/tasks/${encodeURIComponent(task)}/claim`, 'POST', { force: force ?? false })));
  server.registerTool('comment_task', { description: 'Add a progress note to a task.', inputSchema: { canvasId, taskId, text: z.string().min(1).max(2000) } },
    async ({ canvasId: id, taskId: task, text }) => result(await api.request(`${canvasPath(id)}/tasks/${encodeURIComponent(task)}/comments`, 'POST', { text })));
}

function registerJevTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('analyze_canvas', { description: 'Ask TypeSafe Jev for read-only canvas insights, including document classification.', inputSchema: {
    canvasId, query: z.string().optional(),
  } }, async ({ canvasId: id, query = '' }) => result(await api.request(canvasPath(id) + '/insights', 'POST', { query })));
  server.registerTool('find_duplicates', { description: 'Find duplicate documents and reviewable merge plans without changing saved files.', inputSchema: {
    canvasId, blockId: blockId.optional(), crossCanvas: z.boolean().optional(),
  } }, async ({ canvasId: id, blockId: docId, crossCanvas }) => result(await api.request(canvasPath(id) + '/duplicates', 'POST', {
    ...(docId ? { blockId: docId } : {}), crossCanvas: crossCanvas ?? false,
  })));
  server.registerTool('merge_documents', { description: 'Merge reviewed duplicates into complete replacement content. Requires current content hashes for every affected document.', inputSchema: {
    canvasId, keepBlockId: blockId, mergeBlockIds: z.array(blockId).min(1).max(10), content,
    expectedContentHashes: z.record(z.string(), z.string()).describe('Map from every keeper/merged block ID to contentHash from read_doc'),
  } }, async ({ canvasId: id, keepBlockId, mergeBlockIds, content: mergedContent, expectedContentHashes }) => {
    for (const docId of [keepBlockId, ...mergeBlockIds]) {
      if (!expectedContentHashes[docId]) throw new Error(`Missing expectedContentHash for ${docId}`);
    }
    return result(await api.request(canvasPath(id) + '/merge', 'POST', {
      keepBlockId, mergeBlockIds, content: mergedContent, expectedContentHashes,
    }));
  });
  server.registerTool('undo_merge', { description: 'Undo a document merge using the mergeId returned by merge_documents. The undo fails if affected documents changed after the merge.', inputSchema: {
    mergeId: z.string().regex(/^[a-f0-9-]{36}$/).describe('mergeId returned by merge_documents'),
  } }, async ({ mergeId }) => result(await api.request(`/merges/${encodeURIComponent(mergeId)}/undo`, 'POST', {})));
  server.registerTool('connect_across_canvases', { description: 'Suggest related documents across canvases in one workspace without saving links.', inputSchema: {
    canvasId,
  } }, async ({ canvasId: id }) => result(await api.request(canvasPath(id) + '/cross-connections', 'POST', {})));
  server.registerTool('score_documents', { description: 'Score document quality and canvas health without changing saved documents.', inputSchema: {
    canvasId,
  } }, async ({ canvasId: id }) => result(await api.request(canvasPath(id) + '/quality', 'POST', {})));
  const workspaceKinds = z.enum(['layout', 'connection', 'regroup', 'purpose', 'work_area', 'reviewer',
    'cross_connect', 'dedupe', 'tidy', 'connect_all']);
  server.registerTool('run_workspace_automation', { description: 'Preview a Jev automation across a workspace by default. To apply, supply dryRun false and selected actionIds from a preview.', inputSchema: {
    workspaceId, kind: workspaceKinds, dryRun: z.boolean().optional(), runId: z.string().optional(),
    actionIds: z.array(z.string()).optional(),
  } }, async ({ workspaceId: id, kind, dryRun, runId, actionIds }) => {
    if (dryRun === false && !actionIds) throw new Error('Applying a workspace automation requires actionIds from a preview.');
    return result(await api.request(`/workspaces/${encodeURIComponent(id)}/automations`, 'POST', {
      kind, dryRun: dryRun ?? true, ...(runId ? { runId } : {}), ...(actionIds ? { actionIds } : {}),
    }));
  });
  const automations: Array<[string, AutomationKind, string, boolean]> = [
    ['regroup_canvas', 'regroup', 'Classify documents into groups, place each group on the canvas, and update useful links.', true],
    ['organize_canvas', 'layout', 'Classify documents into groups and place each group on the canvas.', true],
    ['connect_documents', 'connection', 'Add Jev-rated links and remove links Jev rejects.', false],
    ['label_purposes', 'purpose', 'Apply Jev document-purpose labels.', false],
    ['classify_work_areas', 'work_area', 'Apply Jev work-area labels from over 100 choices.', false],
    ['assign_reviewers', 'reviewer', 'Apply Jev reviewer suggestions.', false],
  ];
  for (const [name, kind, description, grouped] of automations) {
    server.registerTool(name, { description, inputSchema: grouped ? { canvasId, groupBy } : { canvasId } },
      async (args: { canvasId: string; groupBy?: string }) => result(await api.request(canvasPath(args.canvasId) + '/automations', 'POST',
        { kind, ...(args.groupBy ? { groupBy: args.groupBy } : {}) })));
  }
}

function registerVersionTools(server: McpServer, api: CanvasApi): void {
  const versionPath = (id: string, docId: string) => canvasPath(id, docId) + '/versions';
  server.registerTool('list_versions', { description: 'List Git branches and recent commits, with authors, for one document file.', inputSchema: { canvasId, blockId } },
    async ({ canvasId: id, blockId: docId }) => result(await api.request(versionPath(id, docId))));
  const name = z.string().min(1).describe('Branch name');
  server.registerTool('create_branch', { description: 'Create a branch for one document file.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/branches', 'POST', { name: branch })));
  server.registerTool('switch_branch', { description: 'Switch one document file to an existing branch.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/switch', 'POST', { name: branch })));
  server.registerTool('merge_branch', { description: 'Merge another branch of one document file. Conflicts leave it unchanged.', inputSchema: { canvasId, blockId, name } },
    async ({ canvasId: id, blockId: docId, name: branch }) => result(await api.request(versionPath(id, docId) + '/merge', 'POST', { name: branch })));
  server.registerTool('restore_revision', { description: 'Restore one document file to a prior revision as a new commit.', inputSchema: { canvasId, blockId, revision: z.string().min(7) } },
    async ({ canvasId: id, blockId: docId, revision }) => result(await api.request(versionPath(id, docId) + '/restore', 'POST', { revision })));
}

export type ProjectMcpOptions = {
  /** stdio agents run on the agent's machine, so they may read and write local files. Remote HTTP agents may not. */
  localFiles?: boolean;
  /** Extra API headers, such as authorization. */
  headers?: Record<string, string>;
  /** Suffix added to the connecting client's name, such as the MCP token name. */
  actorSuffix?: string;
};

export function createProjectMcpServer(apiBase = process.env.CANVAS_API_URL || defaultApi, fetcher: typeof fetch = fetch,
  options: ProjectMcpOptions = {}): McpServer {
  const server = new McpServer({ name: 'symbiknow', version: '0.2.0' }, { instructions });
  const token = process.env.CANVAS_API_TOKEN || process.env.SYMBIKNOW_ACCESS_TOKEN || process.env.ALLTEAM_ACCESS_TOKEN;
  const actor = () => {
    const client = server.server.getClientVersion()?.name ?? '';
    const name = process.env.SYMBIKNOW_AGENT_NAME || process.env.ALLTEAM_AGENT_NAME || knownClients[client.toLowerCase()] || client || 'MCP agent';
    return [name, options.actorSuffix].filter(Boolean).join(' - ').slice(0, 48);
  };
  const api = new CanvasApi(apiBase.replace(/\/$/, ''), fetcher, () => ({
    'x-symbiknow-actor': actor(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers,
  }));
  registerDocumentTools(server, api);
  registerFileTools(server, api, options.localFiles ?? true);
  registerCoordinationTools(server, api);
  registerJevTools(server, api);
  registerVersionTools(server, api);
  return server;
}

export async function startProjectMcpServer(): Promise<void> {
  await createProjectMcpServer().connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startProjectMcpServer().catch(error => { console.error(error); process.exitCode = 1; });
}
