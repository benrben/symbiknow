import type { JevPrincipal } from '../shared/jev-types.js';
import type { RouteContext } from './api-context.js';
import { readBody, sendJson } from './api-http.js';
import { ApiError } from './errors.js';
import { jevApiPrincipal } from './jev-api-principal.js';
import { getJevRuntime } from './jev/runtime.js';
import { jevApiEndpoint, type JevApiEndpoint } from './jev-api-handlers.js';

async function workspaceScope(context: RouteContext, kind: string, id: string, principal: JevPrincipal) {
  if (kind !== 'canvases') return { workspaceId: id, canvasId: undefined };
  if (principal.allowedCanvasIds && !principal.allowedCanvasIds.includes(id)) throw new ApiError(404, 'Canvas not found');
  return { workspaceId: (await context.store.getCanvasSummary(id)).workspaceId, canvasId: id };
}

async function dispatch(context: RouteContext, endpoint: JevApiEndpoint, operation: string, principal: JevPrincipal, workspaceId: string, canvasId?: string) {
  const parts = operation.split('/');
  const input = endpoint.input || parts[2] === 'revise' ? await readBody(context.request) : {};
  return endpoint.handle({ context, runtime: getJevRuntime(context.store, { fetcher: context.fetcher }), principal,
    workspaceId, canvasId, id: parts[1], command: parts[2], input });
}

export async function jevRoutes(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/(workspaces|canvases)\/([^/]+)\/jev(?:\/(agent))?(?:\/(.*))?$/);
  if (!match) return false;
  const operation = match[4] ?? 'state';
  const endpoint = jevApiEndpoint(operation, context.method);
  const principal = await jevApiPrincipal(context.store, context.request, Boolean(match[3]));
  const { workspaceId, canvasId } = await workspaceScope(context, match[1], match[2], principal);
  const result = await dispatch(context, endpoint, operation, principal, workspaceId, canvasId);
  sendJson(context.response, 200, result === undefined ? { ok: true } : result);
  return true;
}
