import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CanvasApi, result } from './mcp-api.js';

const canvasId = z.string().min(1).optional();
const documentIds = z.array(z.string().min(1)).max(20).optional();

/** The only default brain tools; automatic organization remains internal. */
export function registerSymbiBrainTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('ask_symbi', { description: 'Find source-backed knowledge. semantic uses only local retrieval; logic and combined use configured inference. Set navigate=true for an explicit canvas deep link.',
    inputSchema: { question: z.string().min(1).max(1000), mode: z.enum(['semantic', 'logic', 'combined']), canvasId, documentIds,
      limit: z.number().int().min(1).max(24).optional(), cursor: z.string().optional(),
      continuationId: z.string().max(128).optional(), navigate: z.boolean().optional() } },
  async input => result(await api.request('/symbi/ask', 'POST', input)));
  server.registerTool('symbi_reflex', { description: 'Check a claim against scoped source evidence. Returns yes, no, or insufficient_evidence without changing documents or organization.',
    inputSchema: { claim: z.string().min(1).max(1000), canvasId, documentIds, comparisonDocumentId: z.string().min(1).optional() } },
  async input => result(await api.request('/symbi/reflex', 'POST', input)));
}
