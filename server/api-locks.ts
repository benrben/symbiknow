import type { RouteContext } from './api-context.js';
import { sendJson, readBody } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';

const lockEndpoints: Endpoint[] = [
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/lock$/, handle: async (context, match) => {
    const lock = await context.store.lockBlock(match[1], match[2], context.actor, await readBody(context.request));
    const block = await context.store.getCanvasBlock(match[1], match[2]);
    sendJson(context.response, 200, { ...lock, contentHash: block.contentHash });
  } },
  { method: 'DELETE', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/lock$/, handle: async (context, match) => {
    await context.store.unlockBlock(match[1], match[2], context.actor, context.url.searchParams.has('force'));
    sendJson(context.response, 200, { ok: true });
  } },
];

export function lockRoutes(context: RouteContext): Promise<boolean> { return runEndpoints(context, lockEndpoints); }
