import type { RouteContext } from './api-context.js';
import { isInternal } from './auth.js';
import { ApiError } from './errors.js';
import { getJevRuntime } from './jev/runtime.js';

/** Transport markers only restrict access; they never grant reviewer authority. */
export async function requireReviewedAgentWrite(context: RouteContext): Promise<void> {
  const marked = context.request.headers['x-symbiknow-agent-transport'] === 'mcp';
  if (!marked && !isInternal(context.request)) return;
  const target = sourceMutation(context.method, context.route);
  if (!target) return;
  if (await getJevRuntime(context.store).hasActiveDraft(decodeURIComponent(target[1]), decodeURIComponent(target[2]))) {
    throw new ApiError(403, 'A reviewed draft is active. Resume, rebase, or cancel it before writing this source.');
  }
}

function sourceMutation(method: string, route: string): RegExpMatchArray | null {
  if (['PUT', 'DELETE'].includes(method)) return route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)$/);
  if (method === 'POST') return route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions\/(?:switch|merge|restore)$/);
  return null;
}
