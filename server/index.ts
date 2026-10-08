import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteContext } from './api-context.js';
import { sendJson, serveApp } from './api-http.js';
import { searchAndChat, streamingChat, investigationRoutes } from './api-chat.js';
import { sessionRoutes } from './api-access.js';
import { connectionRoutes } from './api-connections.js';
import { jevRoutes } from './api-jev.js';
import { hasJevApiAccess } from './jev-api-principal.js';
import { getJevRuntime } from './jev/runtime.js';
import { requireReviewedAgentWrite } from './jev-agent-write-guard.js';
import { lockRoutes } from './api-locks.js';
import { todoRoutes } from './api-todos.js';
import { fileCheckoutRoutes } from './api-file-checkouts.js';
import { fileProposalRoutes } from './api-file-proposals.js';
import { workspaceAndSettings, workspaceCanvas } from './api-workspaces.js';
import { canvasDocument, canvasLink, canvasImports, versionRoutes, canvasBlockMove, canvasLayout, canvasBlocks, blockDocument, blockDownload, websiteAsset } from './api-documents.js';
import type { DeepAgentFactory } from './chat-stream.js';
import { ApiError, CanvasStore } from './storage.js';
import { accessToken, hasApiAccess, requestActor } from './auth.js';
import { handleMcpHttp } from './mcp-http.js';
import { ApiLifecycle } from './api-lifecycle.js';
import { SymbiIndexLifecycle } from './symbi-index-lifecycle.js';
import { symbiRoutes } from './api-symbi.js';
import { mcpCallerRoute } from './api-mcp-caller.js';
import { mcpBrowserRoute } from './api-mcp-browser.js';
import { authorizeMcpApi, withinMcpApiAuthority } from './mcp-api-authorization.js';
import { SymbiJudgmentCache } from './symbi-judgment-cache.js';

async function appRoute(context: RouteContext): Promise<boolean> {
  if (context.route.startsWith('/api/') || context.method !== 'GET') return false;
  await serveApp(context.route, context.response);
  return true;
}

const routeHandlers = [mcpCallerRoute, mcpBrowserRoute, jevRoutes, symbiRoutes, workspaceAndSettings, connectionRoutes, searchAndChat, streamingChat, investigationRoutes, workspaceCanvas, canvasDocument, versionRoutes,
  canvasBlockMove, canvasLayout,
  lockRoutes, todoRoutes, fileCheckoutRoutes, fileProposalRoutes, canvasBlocks, canvasImports, canvasLink, blockDocument, blockDownload, websiteAsset];


async function mcpRoute(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/mcp(?:\/t\/([^/]+))?\/?$/);
  if (!match) return false;
  await handleMcpHttp(context.store, context.request, context.response, match[1] ? decodeURIComponent(match[1]) : undefined);
  return true;
}

function requireSafeOrigin(context: RouteContext): void {
  // A sandboxed HTML document has an opaque ("null") origin. It must never change data.
  if (!['GET', 'HEAD'].includes(context.method) && context.request.headers.origin === 'null') {
    throw new ApiError(403, 'Requests from sandboxed documents are not allowed');
  }
}

async function protectedApiRoutes(context: RouteContext): Promise<boolean> {
  for (const handler of routeHandlers) {
    if (await handler(context)) return true;
  }
  return false;
}

async function apiRoute(context: RouteContext): Promise<boolean> {
  requireSafeOrigin(context);
  if (await sessionRoutes(context)) return true;
  const agentAuthorized = await authorizeMcpApi(context);
  const jevNamespace = /^\/api\/(?:workspaces|canvases)\/[^/]+\/jev(?:\/|$)/.test(context.route);
  const authorized = agentAuthorized || (jevNamespace ? await hasJevApiAccess(context.store, context.request) : hasApiAccess(context.request));
  if (!authorized) throw new ApiError(401, 'Sign in with the workspace access token');
  await requireReviewedAgentWrite(context);
  return withinMcpApiAuthority(context, () => protectedApiRoutes(context));
}

async function dispatch(context: RouteContext): Promise<void> {
  if (await mcpRoute(context)) return;
  const handled = context.route.startsWith('/api/') ? await apiRoute(context) : await appRoute(context);
  if (handled) return;
  sendJson(context.response, 404, { error: 'Route not found' });
}

function respondError(response: ServerResponse, error: unknown): void {
  const status = error instanceof ApiError ? error.status : 500;
  const message = error instanceof ApiError ? error.message : 'Internal server error';
  if (status === 500) console.error(error);
  sendJson(response, status, { error: message, ...(error instanceof ApiError ? error.details : {}) });
}

export async function createApiServer(options: { dataDir: string; fetcher?: typeof fetch; agentFactory?: DeepAgentFactory }): Promise<Server> {
  const store = new CanvasStore(path.resolve(options.dataDir));
  await store.init();
  const symbiIndex = await SymbiIndexLifecycle.open(store, process.env.SYMBI_MODEL_ROOT ?? path.join(store.root, 'models'));
  const symbiJudgments = await SymbiJudgmentCache.open(store.root);
  const reflex = getJevRuntime(store, { fetcher: options.fetcher,
    retrieveNeighbors: (context, source) => symbiIndex.neighbors(context, source) });
  const lifecycle = new ApiLifecycle(() => reflex.close(), async () => {
    await reflex.shutdown();
    await store.jevExecutor.serialized(async () => undefined);
    await symbiIndex.close();
  });
  const server = createServer((request, response) => lifecycle.track((async () => {
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', disconnect);
    try {
      const method = request.method!;
      const url = new URL(request.url!, 'http://localhost');
      await dispatch({ store, symbiIndex, symbiJudgments, request, response, method, route: url.pathname, url, fetcher: options.fetcher, agentFactory: options.agentFactory,
        actor: requestActor(request), signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) respondError(response, error);
    } finally {
      response.off('close', disconnect);
    }
  })()));
  lifecycle.install(server);
  return server;
}

function validPort(port: number): boolean { return Number.isInteger(port) && port >= 0 && port <= 65535; }

export async function start(port: number, dataDir: string, host = '127.0.0.1'): Promise<Server> {
  if (!validPort(port)) throw new Error('PORT must be a valid TCP port');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !accessToken()) {
    console.warn('Warning: HOST exposes the canvas beyond this machine without SYMBIKNOW_ACCESS_TOKEN. Anyone who can reach it can read and change documents.');
  }
  const server = await createApiServer({ dataDir });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  const address = server.address() as AddressInfo;
  console.log(`SymbiKnow API listening on http://${host.includes(':') ? `[${host}]` : host}:${address.port} (remote MCP at /mcp)`);
  return server;
}

export function reportStartupFailure(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 8787);
  const dataDir = process.env.DATA_DIR || 'data';
  start(port, dataDir, process.env.HOST || '127.0.0.1').catch(reportStartupFailure);
}
