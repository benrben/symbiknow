import type { RouteContext } from './api-context.js';
import { readBody, sendJson } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';
import { ApiError } from './errors.js';

function todoIdentifier(encoded: string): string {
  let id: string;
  try { id = decodeURIComponent(encoded); }
  catch { throw new ApiError(400, 'Invalid todo identifier'); }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ApiError(400, 'Invalid todo identifier');
  return id;
}

function requireRevision(input: Record<string, unknown>): void {
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) {
    throw new ApiError(400, 'expectedRevision must be a non-negative integer');
  }
}

const todoEndpoints: Endpoint[] = [
  { method: 'GET', path: /^\/api\/canvases\/([^/]+)\/todos$/, handle: async (context, match) => {
    const tasks = await context.store.listTasks(todoIdentifier(match[1]));
    sendJson(context.response, 200, tasks);
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/todos$/, handle: async (context, match) => {
    const task = await context.store.createTask(todoIdentifier(match[1]), await readBody(context.request), context.actor);
    sendJson(context.response, 201, task);
  } },
  { method: 'PUT', path: /^\/api\/canvases\/([^/]+)\/todos\/([^/]+)$/, handle: async (context, match) => {
    const input = await readBody(context.request);
    requireRevision(input);
    const task = await context.store.updateTask(todoIdentifier(match[1]), todoIdentifier(match[2]), input, context.actor);
    sendJson(context.response, 200, task);
  } },
];

export function todoRoutes(context: RouteContext): Promise<boolean> { return runEndpoints(context, todoEndpoints); }
