import { InvestigationStore } from './investigations.js';
import type { RouteContext } from './api-context.js';
import { readBody, sendJson } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';

function investigationKey(context: RouteContext): string | undefined {
  const key = context.request.headers['x-investigation-key'];
  return typeof key === 'string' ? key : undefined;
}

const investigationEndpoints: Endpoint[] = [
  { method: 'POST', path: '/api/investigations', handle: async context => {
    sendJson(context.response, 201, await new InvestigationStore(context.store).create(await readBody(context.request)));
  } },
  { method: 'POST', path: '/api/investigations/list', handle: async context => {
    sendJson(context.response, 200, await new InvestigationStore(context.store).list(await readBody(context.request)));
  } },
  { method: 'GET', path: /^\/api\/investigations\/([^/]+)$/, handle: async (context, match) => {
    sendJson(context.response, 200, await new InvestigationStore(context.store).get(match[1], investigationKey(context)));
  } },
  { method: 'PATCH', path: /^\/api\/investigations\/([^/]+)$/, handle: async (context, match) => {
    sendJson(context.response, 200, await new InvestigationStore(context.store).update(match[1],
      await readBody(context.request), investigationKey(context)));
  } },
  { method: 'DELETE', path: /^\/api\/investigations\/([^/]+)$/, handle: async (context, match) => {
    sendJson(context.response, 200, await new InvestigationStore(context.store).delete(match[1], investigationKey(context)));
  } },
];

export function investigationRoutes(context: RouteContext): Promise<boolean> { return runEndpoints(context, investigationEndpoints); }
