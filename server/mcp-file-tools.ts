import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CanvasApi, result } from './mcp-api.js';
import { downloadFile, uploadFile } from './mcp-files.js';

export const fileKinds = z.enum(['markdown', 'html', 'slides', 'website', 'mdx']);
export const fileUploadSchema = z.object({
  mode: z.enum(['replace', 'create', 'propose']), canvasId: z.string().min(1), checkoutId: z.string().uuid().optional(),
  filename: z.string().min(1), content: z.string().max(999_900), idempotencyKey: z.string().min(1).max(128),
  kind: fileKinds.optional(), title: z.string().min(1).max(200).optional(), x: z.number().optional(), y: z.number().optional(),
  message: z.string().max(120).optional(),
});
export const fileDownloadSchema = z.object({ canvasId: z.string().min(1), blockId: z.string().min(1), branch: z.string().min(1).optional() });

export function registerFileTools(server: McpServer, api: CanvasApi, localFiles: boolean): void {
  server.registerTool('download_file', { _meta: { apiRoutes: [{"method":"POST","path":"/file-checkouts","bodyFields":["canvasId","blockId","branch"]}], documentResult: true }, annotations: { readOnlyHint: true }, description: 'Download exact source and an authoritative working-copy manifest. Edit the file locally, then upload_file with mode=replace and its checkoutId. Branch downloads leave the visible branch unchanged.', inputSchema: {
    ...fileDownloadSchema.shape,
    ...(localFiles ? { destinationPath: z.string().min(1).optional().describe('Local file path; for a website package, a project directory with actual editable files'), overwrite: z.boolean().optional() } : {}),
  } }, async args => result(await downloadFile(api, args)));
  server.registerTool('upload_file', { _meta: { apiRoutes: [{"method":"POST","path":"/file-uploads","bodyFields":["mode","canvasId","checkoutId","filename","content","idempotencyKey","kind","title","x","y","message"]}], permission: 'propose', documentResult: true, publishProposal: true }, description: 'Commit a complete edited file through MCP. mode=replace requires checkoutId from download_file; mode=create explicitly creates a new document; mode=propose prepares a reviewable replacement. idempotencyKey is required and retries return the original receipt. Replacement preserves format and metadata unless explicitly changed.', inputSchema: {
    ...fileUploadSchema.shape, filename: fileUploadSchema.shape.filename.optional(), content: fileUploadSchema.shape.content.optional(),
    ...(localFiles ? { sourcePath: z.string().min(1).optional().describe('Local edited file, or a downloaded website project directory') } : {}),
  } }, async args => result(await uploadFile(api, args)));
}
