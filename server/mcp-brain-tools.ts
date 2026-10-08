import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CanvasApi, result } from './mcp-api.js';

const canvasId = z.string().min(1).max(64).optional();
const documentIds = z.array(z.string().min(1).max(64)).max(20).optional();

/** Source-backed retrieval and claim checking share the canonical MCP catalog. */
export function registerSymbiBrainTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('ask_symbi', { _meta: { apiRoutes: [{"method":"POST","path":"/symbi/ask","bodyFields":["question","mode","canvasId","documentIds","limit","cursor","continuationId","navigate"]}] }, annotations: { readOnlyHint: true }, description: 'Find source-backed knowledge. semantic uses only local retrieval; logic and combined use configured inference. Optional canvasId and documentIds narrow the source selection; omitted or empty documentIds means no selection filter. Caller permissions always restrict accessible sources. Set navigate=true for an explicit canvas deep link.',
    inputSchema: { question: z.string().min(1).max(1000), mode: z.enum(['semantic', 'logic', 'combined']), canvasId, documentIds,
      limit: z.number().int().min(1).max(24).optional(), cursor: z.string().max(2000).optional(),
      continuationId: z.string().max(128).optional(), navigate: z.boolean().optional() } },
  async input => result(await api.request('/symbi/ask', 'POST', input)));
  server.registerTool('symbi_reflex', { _meta: { apiRoutes: [{"method":"POST","path":"/symbi/reflex","bodyFields":["claim","canvasId","documentIds","comparisonDocumentId"]}] }, annotations: { readOnlyHint: true }, description: 'Check a claim against scoped source evidence. Returns yes, no, or insufficient_evidence without changing documents or organization.',
    inputSchema: { claim: z.string().min(1).max(1000), canvasId, documentIds, comparisonDocumentId: z.string().min(1).max(64).optional() } },
  async input => result(await api.request('/symbi/reflex', 'POST', input)));
}
