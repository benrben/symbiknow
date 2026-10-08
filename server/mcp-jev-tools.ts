import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jevActions } from '../shared/jev-types.js';
import { CanvasApi, result } from './mcp-api.js';

const canvasId = z.string().min(1);
const blockId = z.string().min(1);
const base = (id: string) => `/canvases/${encodeURIComponent(id)}/jev/agent`;
type ReadInput = { canvasId: string; blockId?: string; query?: string; limit?: number; cursor?: string };

function stateQuery(name: string, input: ReadInput): string {
  const query = new URLSearchParams({ view: name });
  if (input.blockId) query.set('blockId', input.blockId);
  if (input.query) query.set('query', input.query);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor) query.set('cursor', input.cursor);
  return base(input.canvasId) + '/state?' + query;
}

async function readJev(api: CanvasApi, name: string, input: ReadInput): Promise<unknown> {
  if (name === 'find_by') return api.request('/symbi/find', 'POST', { question: input.query
    || (input.blockId ? (await api.block(input.canvasId, input.blockId)).title : ''),
    mode: 'semantic', canvasId: input.canvasId, limit: input.limit, cursor: input.cursor });
  if (name === 'related') return api.request('/symbi/related', 'POST', { canvasId: input.canvasId,
    blockId: input.blockId, limit: input.limit, cursor: input.cursor });
  return api.request(stateQuery(name, input));
}

const reads = {
  jev_profile: 'Read source profiles, categories, and evidence coverage for documents in a canvas.',
  find_by: 'Find documents in a canvas using semantic source retrieval. Provide a query or a document whose title supplies the query.',
  related: 'Find source-backed related documents within a canvas, optionally relative to one document.',
  memory_map: 'Read the knowledge map and source relationships for a canvas.',
  jev_activity: 'Read Reflex jobs, decisions, and activity in the granted canvas.',
  brain_inbox: 'Read pending source-grounded organization proposals and review state for a canvas.',
};

export function registerJevTools(server: McpServer, api: CanvasApi): void {
  for (const [name, description] of Object.entries(reads)) {
    server.registerTool(name, { description, _meta: { apiRoutes: name === 'find_by'
      ? [{ method: 'POST', path: '/symbi/find' }, { method: 'GET', path: '/canvases/:canvasId/blocks/:blockId' }]
      : name === 'related' ? [{ method: 'POST', path: '/symbi/related' }]
        : [{ method: 'GET', path: '/canvases/:canvasId/jev/agent/state', queryEquals: { view: name } }] }, annotations: { readOnlyHint: true },
      inputSchema: { canvasId, blockId: blockId.optional(), query: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() } },
    async input => result(await readJev(api, name, input)));
  }
  server.registerTool('jev_do', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/jev/agent/actions","bodyFields":["action","blockIds","query","options","idempotencyKey"]}], permission: 'propose' }, description: 'Run a typed Reflex action, including profile, label, link, file, suggested home canvas, and duplicate detection. Returns a durable job; proposed organization changes require an authorized approval.',

    inputSchema: { canvasId, action: z.enum(jevActions), blockIds: z.array(blockId).max(20).optional(), query: z.string().optional(),
      options: z.record(z.string(), z.json()).optional(), idempotencyKey: z.string().optional() } },
  async ({ canvasId: id, ...input }) => result(await api.request(base(id) + '/actions', 'POST', input)));
  server.registerTool('jev_job', { _meta: { apiRoutes: [{ method: 'GET', path: '/canvases/:canvasId/jev/agent/state', queryEquals: { view: 'jev_job' } }, { method: 'GET', path: '/canvases/:canvasId/jev/agent/progress' }, { method: 'GET', path: '/canvases/:canvasId/jev/agent/inspect' }] }, description: 'Read a requested Reflex job, source evidence, review proposals, and document progress in its granted canvas. Supply action to inspect one current action decision and its evidence.',
    annotations: { readOnlyHint: true }, inputSchema: { canvasId, jobId: z.string().min(1), action: z.enum(jevActions).optional() } }, async ({ canvasId: id, jobId, action }) => {
      if (action) return result(await api.request(base(id) + '/inspect?' + new URLSearchParams({ jobId, action })));
      const value = await api.request(base(id) + '/state?' + new URLSearchParams({ view: 'jev_job', jobId }));
      if (!value) throw new Error('Job not found in the granted scope');
      const progress = await api.request(base(id) + '/progress') as { documents?: Array<{ jobId: string }> };
      return result({ ...value as Record<string, unknown>,
        progress: progress.documents?.find(document => document.jobId === jobId) ?? null });
    });
  server.registerTool('jev_resolve', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/jev/agent/proposals/:proposalId/:decision","bodyFields":[]}], permission: 'approve' }, description: 'Apply, dismiss, or suppress one current Reflex proposal. Requires an explicit reviewer grant; applying revalidates its source evidence.',
     inputSchema: { canvasId, proposalId: z.string().min(1), decision: z.enum(['apply', 'dismiss', 'suppress']) } },
  async ({ canvasId: id, proposalId, decision }) => result(await api.request(`${base(id)}/proposals/${encodeURIComponent(proposalId)}/${decision}`, 'POST')));
  server.registerTool('jev_undo', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/jev/agent/receipts/:receiptId/undo","bodyFields":[]}], permission: 'approve' }, description: 'Undo a saved Reflex receipt after verifying its current result. Requires an explicit reviewer grant.',
     inputSchema: { canvasId, receiptId: z.string().min(1) } },
  async ({ canvasId: id, receiptId }) => result(await api.request(`${base(id)}/receipts/${encodeURIComponent(receiptId)}/undo`, 'POST')));
  server.registerTool('jev_configure', { _meta: { apiRoutes: [{"method":"PUT","path":"/canvases/:canvasId/jev/agent/settings"}], permission: 'configure' }, description: 'Update Reflex settings for the workspace containing this canvas. Requires an explicit configuration grant.',
     inputSchema: { canvasId, settings: z.record(z.string(), z.json()) } },
  async ({ canvasId: id, settings }) => result(await api.request(base(id) + '/settings', 'PUT', settings)));
}
