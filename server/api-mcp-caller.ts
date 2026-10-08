import type { RouteContext } from './api-context.js';
import { z } from 'zod';
import { bearerToken } from './auth.js';
import { readBody, sendJson } from './api-http.js';
import { jevApiPrincipal } from './jev-api-principal.js';
import { ApiError } from './errors.js';
import { projectMcpMetadata } from './mcp-registry.js';
import { safeMcpToolEvent } from './mcp-activity.js';
import { recordMcpToolEvent } from './mcp-http-activity.js';

const eventSchema = z.object({ tool: z.string().refine(name => projectMcpMetadata().some(tool => tool.name === name)),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime(), outcome: z.enum(['success', 'error', 'denied']),
  args: z.object({ canvasIds: z.array(z.string()).max(20), blockIds: z.array(z.string()).max(20) }).strict(),
  result: z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string().max(256) }).strict()).max(1) }).strict().optional(),
}).strict();

async function recordCallerEvent(context: RouteContext, principal: Awaited<ReturnType<typeof jevApiPrincipal>>) {
  const parsed = eventSchema.safeParse(await readBody(context.request));
  if (!parsed.success) throw new ApiError(400, 'A sanitized MCP tool event is required');
  const token = await context.store.mcpTokenIdentity(bearerToken(context.request));
  await recordMcpToolEvent(context.store, { ...principal, name: token?.name ?? principal.id }, safeMcpToolEvent(parsed.data));
  sendJson(context.response, 200, { ok: true });
}

/** Credentials identify only their current grants; no client-supplied permissions are trusted. */
export async function mcpCallerRoute(context: RouteContext): Promise<boolean> {
  const caller = context.method === 'GET' && context.route === '/api/mcp/caller';
  const audit = context.method === 'POST' && context.route === '/api/mcp/calls';
  if (!caller && !audit) return false;
  const principal = await jevApiPrincipal(context.store, context.request, true);
  const { id, access, allowedCanvasIds, tools, canApprove, canConfigure } = principal;
  if (caller) sendJson(context.response, 200, { id, access, allowedCanvasIds, tools, canApprove, canConfigure });
  else await recordCallerEvent(context, principal);
  return true;
}
