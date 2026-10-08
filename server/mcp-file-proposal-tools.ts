import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CanvasApi, result } from './mcp-api.js';

const inputSchema = { canvasId: z.string().min(1), proposalId: z.string().uuid() };
export function registerFileProposalTools(server: McpServer, api: CanvasApi): void {
  server.registerTool('read_file_proposal', { _meta: { apiRoutes: [{"method":"GET","path":"/file-proposals/:proposalId"}] }, description: 'Read an uploaded file proposal or its saved receipt in the granted canvas.',
    annotations: { readOnlyHint: true }, inputSchema }, async ({ canvasId, proposalId }) =>
    result(await api.request(`/file-proposals/${proposalId}?canvasId=${encodeURIComponent(canvasId)}`)));
  for (const operation of ['apply', 'undo'] as const) {
    server.registerTool(`${operation}_file_proposal`, { description: `${operation === 'apply' ? 'Apply' : 'Undo'} an uploaded file proposal with checked document versions and website assets. Requires an explicit approval grant.`,
      _meta: { apiRoutes: [{ method: 'POST', path: `/file-proposals/:proposalId/${operation}`, bodyFields: ['canvasId'] }], permission: 'approve', documentResult: true, publishProposal: true }, inputSchema }, async ({ canvasId, proposalId }) =>
      result(await api.request(`/file-proposals/${proposalId}/${operation}`, 'POST', { canvasId })));
  }
}
