import type { RouteContext } from './api-context.js';
import { readBody, sendJson } from './api-http.js';
import { fileDownloadSchema, fileUploadSchema } from './mcp-file-tools.js';
import { checkoutFile, commitFileUpload } from './file-checkouts.js';
import { jevApiPrincipal } from './jev-api-principal.js';
import { ApiError } from './errors.js';
import type { ZodType } from 'zod';

function parsedBody<T>(schema: ZodType<T>, body: Record<string, unknown>): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map(issue => issue.message).join('; '));
  return parsed.data;
}
export async function fileCheckoutRoutes(context: RouteContext): Promise<boolean> {
  if (context.method !== 'POST' || !['/api/file-checkouts', '/api/file-uploads'].includes(context.route)) return false;
  const principal = await jevApiPrincipal(context.store, context.request, true);
  const body = await readBody(context.request);
  context.signal.throwIfAborted();
  const value = context.route === '/api/file-checkouts'
    ? await checkoutFile(context.store, principal, parsedBody(fileDownloadSchema, body))
    : await commitFileUpload(context.store, principal, parsedBody(fileUploadSchema, body));
  sendJson(context.response, 200, value);
  return true;
}
