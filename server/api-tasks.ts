import type { RouteContext } from './api-context.js';
import { sendJson, readBody } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';
import { ApiError } from './errors.js';

function validTaskPage(limit: number, offset: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0;
}

function taskPageParameters(query: URLSearchParams) {
  const status = query.get('status');
  if (status && !['todo', 'in_progress', 'blocked', 'done'].includes(status)) throw new ApiError(400, 'Invalid task status');
  const assignee = query.get('assignee');
  const limit = Number(query.get('limit') ?? 50);
  const offset = Number(query.get('cursor') ?? 0);
  if (!validTaskPage(limit, offset)) throw new ApiError(400, 'Invalid task pagination');
  return { status, assignee, limit, offset };
}

function taskPage(context: RouteContext, tasks: Awaited<ReturnType<RouteContext['store']['listTasks']>>) {
  const query = context.url.searchParams;
  if (![...query.keys()].some(key => ['status', 'assignee', 'limit', 'cursor'].includes(key))) return tasks;
  const { status, assignee, limit, offset } = taskPageParameters(query);
  const filtered = tasks.filter(task => (!status || task.status === status) && (assignee === null || task.assignee === assignee));
  return { items: filtered.slice(offset, offset + limit), nextCursor: offset + limit < filtered.length ? String(offset + limit) : undefined };
}

function historyPage(context: RouteContext): { limit: number; cursor: number } {
  const limit = Number(context.url.searchParams.get('limit') ?? 25);
  const cursor = Number(context.url.searchParams.get('cursor') ?? 0);
  if (!validTaskPage(limit, cursor)) throw new ApiError(400, 'Invalid task history pagination');
  return { limit, cursor };
}

async function deletionRevision(context: RouteContext): Promise<number | undefined> {
  const input = deletionHasBody(context) ? await readBody(context.request) : {};
  if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || (input.expectedRevision as number) < 0)) {
    throw new ApiError(400, 'Invalid expectedRevision');
  }
  return input.expectedRevision as number | undefined;
}

function deletionHasBody(context: RouteContext): boolean {
  return Boolean(context.request.headers['transfer-encoding']) || Number(context.request.headers['content-length'] ?? 0) > 0;
}

const taskEndpoints: Endpoint[] = [
  { method: 'GET', path: /^\/api\/canvases\/([^/]+)\/tasks$/, handle: async (context, match) => {
    sendJson(context.response, 200, taskPage(context, await context.store.listTasks(match[1])));
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/tasks$/, handle: async (context, match) => {
    sendJson(context.response, 201, await context.store.createTask(match[1], await readBody(context.request), context.actor));
  } },
  { method: 'GET', path: /^\/api\/canvases\/([^/]+)\/tasks\/([^/]+)\/history$/, handle: async (context, match) => {
    const { limit, cursor } = historyPage(context);
    sendJson(context.response, 200, await context.store.listTaskHistory(match[1], match[2], limit, cursor));
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/tasks\/([^/]+)\/undo$/, handle: async (context, match) => {
    const input = await readBody(context.request);
    if (typeof input.eventId !== 'string' || !input.eventId || !Number.isInteger(input.expectedRevision)
      || (input.expectedRevision as number) < 0) throw new ApiError(400, 'Undo requires eventId and expectedRevision');
    sendJson(context.response, 200, { task: await context.store.undoTask(match[1], match[2], input.eventId,
      input.expectedRevision as number, context.actor) });
  } },
  { method: 'PUT', path: /^\/api\/canvases\/([^/]+)\/tasks\/([^/]+)$/, handle: async (context, match) => {
    sendJson(context.response, 200, await context.store.updateTask(match[1], match[2], await readBody(context.request), context.actor));
  } },
  { method: 'DELETE', path: /^\/api\/canvases\/([^/]+)\/tasks\/([^/]+)$/, handle: async (context, match) => {
    await context.store.deleteTask(match[1], match[2], context.actor, await deletionRevision(context));
    sendJson(context.response, 200, { ok: true });
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/tasks\/([^/]+)\/claim$/, handle: async (context, match) => {
    const { force } = await readBody(context.request);
    sendJson(context.response, 200, await context.store.claimTask(match[1], match[2], context.actor, force === true));
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/tasks\/([^/]+)\/comments$/, handle: async (context, match) => {
    const { text } = await readBody(context.request);
    sendJson(context.response, 200, await context.store.commentTask(match[1], match[2], text, context.actor));
  } },
];

export function taskRoutes(context: RouteContext): Promise<boolean> { return runEndpoints(context, taskEndpoints); }

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
