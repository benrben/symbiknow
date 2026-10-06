import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jevActions } from '../shared/jev-types.js';
import { CanvasApi, result } from './mcp-api.js';

const canvasId = z.string().min(1);
const blockId = z.string().min(1);
const base = (id: string) => `/canvases/${encodeURIComponent(id)}/jev/agent`;
type CompatibilityInput = { canvasId: string; blockId?: string; query?: string; limit?: number; cursor?: string };

function stateQuery(name: string, input: CompatibilityInput): string {
  const query = new URLSearchParams({ view: name });
  if (input.blockId) query.set('blockId', input.blockId);
  if (input.query) query.set('query', input.query);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor) query.set('cursor', input.cursor);
  return base(input.canvasId) + '/state?' + query;
}

async function compatibilityRead(api: CanvasApi, name: string, input: CompatibilityInput): Promise<unknown> {
  if (name === 'find_by') return api.request('/symbi/find', 'POST', { question: input.query
    || (input.blockId ? (await api.block(input.canvasId, input.blockId)).title : ''),
    mode: 'semantic', canvasId: input.canvasId, limit: input.limit, cursor: input.cursor });
  if (name === 'related') return api.request('/symbi/related', 'POST', { canvasId: input.canvasId,
    blockId: input.blockId, limit: input.limit, cursor: input.cursor });
  return api.request(stateQuery(name, input));
}

export function registerJevTools(server: McpServer, api: CanvasApi): void {
  for (const name of ['jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox'] as const) {
    server.registerTool(name, { description: `Compatibility read for ${name.replaceAll('_', ' ')}. Use ask_symbi or symbi_reflex for new agents. No organization action is started.`,
      inputSchema: { canvasId, blockId: blockId.optional(), query: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() } }, async input => {
      return result(await compatibilityRead(api, name, input));
    });
  }
  for (const name of ['jev_do', 'jev_propose']) server.registerTool(name, { description: 'Request a typed Symbi Reflex action. Saved changes remain proposals for an authorized workspace reviewer.',
    inputSchema: { canvasId, action: z.enum(jevActions), blockIds: z.array(blockId).max(20).optional(), query: z.string().optional(),
      options: z.record(z.string(), z.json()).optional(), idempotencyKey: z.string().optional() } },
  async ({ canvasId: id, ...input }) => result(await api.request(base(id) + '/actions', 'POST', input)));
  server.registerTool('jev_job', { description: 'Read a previously requested scoped job and its review proposals.',
    inputSchema: { canvasId, jobId: z.string().min(1) } }, async ({ canvasId: id, jobId }) => {
      const value = await api.request(base(id) + '/state?' + new URLSearchParams({ view: 'jev_job', jobId }));
      if (!value) throw new Error('Job not found in the granted scope');
      const progress = await api.request(base(id) + '/progress') as { documents?: Array<{ jobId: string }> };
      return result({ ...value as Record<string, unknown>,
        progress: progress.documents?.find(document => document.jobId === jobId) ?? null });
    });
}
