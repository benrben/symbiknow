import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat } from './chat.js';
import { automationDescriptions, createChatStream, sendChatStream, type DeepAgentFactory, type IntentTokenScope } from './chat-stream.js';
import { analyzeCanvas } from './insights.js';
import { runCanvasAutomation } from './automation.js';
import type { AutomationKind } from '../shared/insights.js';
import type { GroupBy } from '../shared/types.js';
import { decideWithJev, type JevDecider } from './jev.js';
import { ApiError, CanvasStore } from './storage.js';
import { siteResponse } from './website.js';
import { accessToken, clearedSessionCookie, hasApiAccess, publicOrigin, requestActor, sessionCookie, validAccessToken } from './auth.js';
import { handleMcpHttp, mcpSessionCount } from './mcp-http.js';
import { listModels } from './providers.js';
import { testExternal } from './external-mcp.js';
import { feedbackSummary, jevCalibration, recordFeedback } from './feedback.js';
import { jevUsageSummary, registerJevUsageLogging } from './jev-usage.js';
import { applyWorkspaceRun, previewWorkspaceRun, undoWorkspaceRun, type WorkspaceAutomationKind } from './runs.js';
import { findDuplicates } from './duplicates.js';
import { findCrossConnections } from './cross-canvas.js';
import { rankSearchHits } from './search-ranking.js';
import { analyzeTaskInsights } from './task-insights.js';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function serveApp(route: string, response: ServerResponse): Promise<void> {
  const dist = path.resolve('dist');
  const file = appFile(dist, route);
  const body = await appBody(dist, file);
  const extension = path.extname(file) || '.html';
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  };
  const immutableAsset = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(route);
  response.writeHead(200, { 'content-type': types[extension] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    ...(immutableAsset ? { 'cache-control': 'public, max-age=31536000, immutable' }
      : extension === '.html' ? { 'cache-control': 'no-cache' } : {}),
  });
  response.end(body);
}

function appFile(dist: string, route: string): string {
  const requested = path.resolve(dist, `.${decodeURIComponent(route)}`);
  if (requested !== dist && !requested.startsWith(`${dist}${path.sep}`)) throw new ApiError(400, 'Invalid app path');
  return route === '/' ? path.join(dist, 'index.html') : requested;
}

async function appBody(dist: string, file: string): Promise<Buffer> {
  let body: Buffer;
  try { body = await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
    if (path.extname(file)) throw new ApiError(404, 'App asset not found');
    body = await readFile(path.join(dist, 'index.html'));
  }
  return body;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring JSON means another site cannot post here with a plain form or a simple cross-origin request.
  if (!String(request.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'Send the request body as application/json');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 2_000_000) throw new ApiError(413, 'Request body is too large');
    chunks.push(part);
  }
  return jsonObject(Buffer.concat(chunks).toString('utf8'));
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new ApiError(400, 'Expected a JSON object'); }
}

type IntentToken = IntentTokenScope & { expiresAt: number };
type RouteContext = { store: CanvasStore; request: IncomingMessage; response: ServerResponse; method: string; route: string; url: URL; fetcher?: typeof fetch; agentFactory?: DeepAgentFactory; jevDecider?: JevDecider; actor: string; intentTokens: Map<string, IntentToken> };
const latestWorkspacePreview = new Map<string, string>();

async function sessionRoutes(context: RouteContext): Promise<boolean> {
  const { request, response, method, route } = context;
  if (route !== '/api/session') return false;
  if (method === 'GET') { sendJson(response, 200, { authRequired: Boolean(accessToken()), authenticated: hasApiAccess(request) }); return true; }
  if (method === 'POST') {
    const { token } = await readBody(request);
    if (!accessToken()) { sendJson(response, 200, { authRequired: false, authenticated: true }); return true; }
    if (!validAccessToken(token)) throw new ApiError(401, 'That access token is not correct');
    response.setHeader('set-cookie', sessionCookie(request));
    sendJson(response, 200, { authRequired: true, authenticated: true });
    return true;
  }
  if (method === 'DELETE') {
    response.setHeader('set-cookie', clearedSessionCookie());
    sendJson(response, 200, { authRequired: Boolean(accessToken()), authenticated: false });
    return true;
  }
  return false;
}

async function connectionRoutes(context: RouteContext): Promise<boolean> {
  const { store, request, response, method, route, url, fetcher } = context;
  if (method === 'GET' && route === '/api/mcp/info') {
    const origin = publicOrigin(request);
    sendJson(response, 200, { origin, endpoint: `${origin}/mcp`, publicUrlConfigured: Boolean(process.env.PUBLIC_URL),
      accessProtected: Boolean(accessToken()), activeSessions: mcpSessionCount() });
    return true;
  }
  if (method === 'POST' && route === '/api/mcp/tokens') {
    const { name } = await readBody(request);
    sendJson(response, 201, await store.createMcpToken(name));
    return true;
  }
  const token = route.match(/^\/api\/mcp\/tokens\/([^/]+)$/);
  if (token && method === 'DELETE') { sendJson(response, 200, await store.revokeMcpToken(decodeURIComponent(token[1]))); return true; }
  if (method === 'POST' && route === '/api/mcp/servers/test') {
    const body = await readBody(request);
    const settings = await store.secretSettings();
    const known = (settings.mcpServers ?? []).find(item => item.id === body.id);
    const candidate = { id: 'test', name: typeof body.name === 'string' && body.name ? body.name : 'MCP server', enabled: true,
      url: typeof body.url === 'string' ? body.url : known?.url ?? '', bearerSecret: typeof body.bearerSecret === 'string' && body.bearerSecret ? body.bearerSecret : undefined,
      headers: body.headers && typeof body.headers === 'object' ? body.headers as Record<string, string> : known?.headers ?? {} };
    if (!/^https?:\/\//.test(candidate.url)) throw new ApiError(400, 'Enter an http or https MCP server URL');
    sendJson(response, 200, await testExternal(candidate, settings.secrets ?? {}));
    return true;
  }
  if (method === 'GET' && route === '/api/models') {
    sendJson(response, 200, await listModels(await store.secretSettings(), url.searchParams.get('provider'), fetcher));
    return true;
  }
  return false;
}

async function taskRoutes(context: RouteContext): Promise<boolean> {
  const { store, request, response, method, route, actor } = context;
  const match = route.match(/^\/api\/canvases\/([^/]+)\/tasks(?:\/([^/]+)(?:\/(claim|comments))?)?$/);
  if (!match) return false;
  const [, canvasId, taskId, action] = match;
  if (!taskId && method === 'GET') { sendJson(response, 200, await store.listTasks(canvasId)); return true; }
  if (!taskId && method === 'POST') { sendJson(response, 201, await store.createTask(canvasId, await readBody(request), actor)); return true; }
  if (taskId && !action && method === 'PUT') { sendJson(response, 200, await store.updateTask(canvasId, taskId, await readBody(request), actor)); return true; }
  if (taskId && !action && method === 'DELETE') { await store.deleteTask(canvasId, taskId); sendJson(response, 200, { ok: true }); return true; }
  if (action === 'claim' && method === 'POST') {
    const { force } = await readBody(request);
    sendJson(response, 200, await store.claimTask(canvasId, taskId, actor, force === true)); return true;
  }
  if (action === 'comments' && method === 'POST') {
    const { text } = await readBody(request);
    sendJson(response, 200, await store.commentTask(canvasId, taskId, text, actor)); return true;
  }
  return false;
}

async function taskInsightRoutes(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/tasks\/insights$/);
  if (!match || context.method !== 'GET') return false;
  sendJson(context.response, 200, await analyzeTaskInsights(context.store, match[1], context.jevDecider));
  return true;
}

async function lockRoutes(context: RouteContext): Promise<boolean> {
  const { store, request, response, method, route, url, actor } = context;
  const match = route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/lock$/);
  if (!match) return false;
  if (method === 'POST') { sendJson(response, 200, await store.lockBlock(match[1], match[2], actor, await readBody(request))); return true; }
  if (method === 'DELETE') { await store.unlockBlock(match[1], match[2], actor, url.searchParams.has('force')); sendJson(response, 200, { ok: true }); return true; }
  return false;
}

async function workspaceAndSettings(context: RouteContext): Promise<boolean> {
  const { store, response, method, route, request } = context;
  switch (`${method} ${route}`) {
    case 'GET /api/workspaces': sendJson(response, 200, await store.listWorkspaces()); return true;
    case 'POST /api/workspaces': sendJson(response, 201, await store.createWorkspace(await readBody(request))); return true;
    case 'GET /api/settings': sendJson(response, 200, await store.getSettings()); return true;
    case 'GET /api/settings/jev-feedback': sendJson(response, 200, await feedbackSummary(store.root)); return true;
    case 'PUT /api/settings': sendJson(response, 200, await store.updateSettings(await readBody(request))); return true;
    default: return false;
  }
}

async function jevRoutes(context: RouteContext): Promise<boolean> {
  const { store, response, method, route } = context;
  if (method !== 'GET') return false;
  if (route === '/api/jev/usage') { sendJson(response, 200, await jevUsageSummary(store.root)); return true; }
  if (route === '/api/jev/calibration') { sendJson(response, 200, await jevCalibration(store.root)); return true; }
  return false;
}

async function searchAndChat(context: RouteContext): Promise<boolean> {
  const { store, response, method, route, url, request, fetcher } = context;
  if (method === 'GET' && route === '/api/search') {
    const query = url.searchParams.get('q') || '';
    const hits = await store.search(query);
    sendJson(response, 200, url.searchParams.get('rank') === 'jev'
      ? await rankSearchHits(store, query, hits, context.jevDecider) : hits);
    return true;
  }
  if (method === 'POST' && route === '/api/chat') { sendJson(response, 200, await chat(store, await readBody(request), fetcher)); return true; }
  return false;
}

async function streamingChat(context: RouteContext): Promise<boolean> {
  const { store, response, method, route, request, agentFactory, jevDecider, intentTokens } = context;
  if (method === 'POST' && route === '/api/chat/intents') {
    const { canvasId, action, blockIds } = await readBody(request);
    const allowed = new Set([...Object.values(automationDescriptions), 'substantial edit', 'delete document', 'merge documents']);
    if (typeof canvasId !== 'string' || typeof action !== 'string' || !allowed.has(action)
      || !Array.isArray(blockIds) || blockIds.length > 10 || blockIds.some(id => typeof id !== 'string')
      || new Set(blockIds).size !== blockIds.length) throw new ApiError(400, 'Invalid chat intent scope');
    const canvas = await store.getCanvas(canvasId);
    if (blockIds.some(id => !canvas.blocks.some(block => block.id === id))
      || ((action === 'delete document' || action === 'substantial edit') && blockIds.length !== 1)
      || (action === 'merge documents' && blockIds.length < 2)
      || (Object.values(automationDescriptions).includes(action) && blockIds.length !== 0)) throw new ApiError(400, 'Invalid chat intent targets');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 5 * 60_000;
    intentTokens.set(token, { canvasId, action, blockIds: [...blockIds].sort(), expiresAt });
    sendJson(response, 201, { token, expiresAt: new Date(expiresAt).toISOString() });
    return true;
  }
  if (method === 'POST' && route === '/api/chat/stream') {
    await sendChatStream(response, await createChatStream(store, await readBody(request), agentFactory, jevDecider, {
      validateIntentToken: (token, scope) => {
        const saved = intentTokens.get(token);
        if (!saved || saved.expiresAt < Date.now() || saved.canvasId !== scope.canvasId || saved.action !== scope.action
          || JSON.stringify(saved.blockIds) !== JSON.stringify([...scope.blockIds].sort())) return false;
        intentTokens.delete(token);
        return true;
      },
    }));
    return true;
  }
  return false;
}

async function workspaceCanvas(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/workspaces\/([^/]+)\/canvases$/);
  if (!match || context.method !== 'POST') return false;
  sendJson(context.response, 201, await context.store.createCanvas(match[1], await readBody(context.request)));
  return true;
}

async function workspaceAutomation(context: RouteContext): Promise<boolean> {
  const undo = context.route.match(/^\/api\/jev-runs\/([^/]+)\/undo$/);
  if (undo && context.method === 'POST') {
    sendJson(context.response, 200, await undoWorkspaceRun(context.store, undo[1], context.actor));
    return true;
  }
  const match = context.route.match(/^\/api\/workspaces\/([^/]+)\/automations$/);
  if (!match || context.method !== 'POST') return false;
  const body = await readBody(context.request);
  const kind = body.kind;
  if (typeof kind !== 'string' || !['layout', 'connection', 'regroup', 'purpose', 'work_area', 'reviewer',
    'cross_connect', 'dedupe', 'tidy', 'connect_all'].includes(kind)) throw new ApiError(400, 'Unknown workspace automation');
  if (body.dryRun !== false) {
    const preview = await previewWorkspaceRun(context.store, match[1], kind as WorkspaceAutomationKind, context.jevDecider);
    latestWorkspacePreview.set(match[1], preview.runId);
    sendJson(context.response, 200, preview);
    return true;
  }
  const runId = typeof body.runId === 'string' ? body.runId : latestWorkspacePreview.get(match[1]);
  if (!runId || !Array.isArray(body.actionIds) || body.actionIds.some(id => typeof id !== 'string')) {
    throw new ApiError(400, 'Apply selected changes from a workspace preview');
  }
  sendJson(context.response, 200, await applyWorkspaceRun(context.store, runId, body.actionIds as string[], context.actor, match[1]));
  return true;
}

async function canvasDocument(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)$/);
  if (!match) return false;
  if (context.method === 'DELETE') {
    await context.store.deleteCanvas(match[1]);
    sendJson(context.response, 200, { ok: true });
    return true;
  }
  if (context.method !== 'GET') return false;
  const etag = await context.store.getCanvasRevision(match[1]);
  if (context.request.headers['if-none-match'] === etag) {
    context.response.writeHead(304, { etag, 'cache-control': 'no-store' });
    context.response.end();
    return true;
  }
  const canvas = await context.store.getCanvas(match[1]);
  context.response.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', etag });
  context.response.end(JSON.stringify(canvas));
  return true;
}

async function versionRoutes(context: RouteContext): Promise<boolean> {
  const { route, method, request, response, store, actor } = context;
  const match = route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions(?:\/(branches|switch|merge|restore))?$/);
  if (!match) return false;
  const [, canvasId, blockId, action] = match;
  if (!action && method === 'GET') {
    sendJson(response, 200, await store.documentHistory(canvasId, blockId)); return true;
  }
  if (action === 'branches' && method === 'POST') {
    const body = await readBody(request);
    if (typeof body.name !== 'string') throw new ApiError(400, 'Branch name is required');
    sendJson(response, 201, await store.createDocumentBranch(canvasId, blockId, body.name)); return true;
  }
  if (action === 'switch' && method === 'POST') {
    const body = await readBody(request);
    if (typeof body.name !== 'string') throw new ApiError(400, 'Branch name is required');
    sendJson(response, 200, await store.switchDocumentBranch(canvasId, blockId, body.name, actor)); return true;
  }
  if (action === 'merge' && method === 'POST') {
    const body = await readBody(request);
    if (typeof body.name !== 'string') throw new ApiError(400, 'Branch name is required');
    sendJson(response, 200, await store.mergeDocumentBranch(canvasId, blockId, body.name, actor)); return true;
  }
  if (action === 'restore' && method === 'POST') {
    const body = await readBody(request);
    if (typeof body.revision !== 'string') throw new ApiError(400, 'Revision ID is required');
    sendJson(response, 200, await store.restoreDocumentRevision(canvasId, blockId, body.revision, actor)); return true;
  }
  return false;
}

async function canvasInsights(context: RouteContext): Promise<boolean> {
  const feedback = context.route.match(/^\/api\/canvases\/([^/]+)\/insights\/feedback$/);
  if (feedback && context.method === 'POST') {
    await context.store.getCanvas(feedback[1]);
    sendJson(context.response, 201, await recordFeedback(context.store.root, feedback[1], await readBody(context.request)));
    return true;
  }
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/insights$/);
  if (!match || context.method !== 'POST') return false;
  const body = await readBody(context.request);
  if (typeof body.query !== 'string' || body.query.length > 500) throw new ApiError(400, 'query must be a string of at most 500 characters');
  sendJson(context.response, 200, await analyzeCanvas(context.store, match[1], body.query, context.jevDecider));
  return true;
}

async function jevReadActions(context: RouteContext): Promise<boolean> {
  if (context.method !== 'POST') return false;
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/(duplicates|cross-connections|quality)$/);
  if (!match) return false;
  const [, canvasId, action] = match;
  const canvas = await context.store.getCanvas(canvasId);
  const settings = await context.store.getSettings();
  const apiKey = await context.store.getJevApiKey();
  if (!apiKey) throw new ApiError(400, 'Set a TypeSafe Jev API key in Settings before using insights');
  if (action === 'quality') {
    sendJson(context.response, 200, await analyzeCanvas(context.store, canvasId, '', context.jevDecider, { families: ['quality'] }));
    return true;
  }
  const body = await readBody(context.request);
  const workspace = (await context.store.listWorkspaces()).find(item => item.id === canvas.workspaceId);
  if (!workspace) throw new ApiError(404, 'Workspace not found');
  const canvases = await Promise.all(workspace.canvases.map(item => context.store.getCanvas(item.id)));
  const index = context.store.similarityIndex(canvas.workspaceId);
  if (action === 'duplicates') {
    if (body.blockId !== undefined && (typeof body.blockId !== 'string' || !canvas.blocks.some(block => block.id === body.blockId))) {
      throw new ApiError(400, 'blockId must name a document on this canvas');
    }
    const [lastModified, workspaceBlocks] = await Promise.all([
      Promise.all(canvas.blocks.map(async block => [block.id, (await context.store.documentMetadata(block)).lastModified ?? ''] as const))
        .then(entries => Object.fromEntries(entries)),
      body.crossCanvas === true
        ? Promise.all(canvases.flatMap(entry => entry.blocks.map(async block => ({ canvasId: entry.id, block,
          lastModified: (await context.store.documentMetadata(block)).lastModified }))))
        : Promise.resolve(undefined),
    ]);
    sendJson(context.response, 200, await findDuplicates({ canvasId, blocks: canvas.blocks, index, apiKey,
      decider: context.jevDecider ?? decideWithJev, policy: settings.jevPolicy,
      blockId: body.blockId as string | undefined, crossCanvas: body.crossCanvas === true,
      workspaceBlocks, lastModified }));
    return true;
  }
  sendJson(context.response, 200, await findCrossConnections({ canvases, index, apiKey,
    decider: context.jevDecider ?? decideWithJev, policy: settings.jevPolicy, canvasId }));
  return true;
}

async function canvasMerge(context: RouteContext): Promise<boolean> {
  const undo = context.route.match(/^\/api\/merges\/([^/]+)\/undo$/);
  if (undo && context.method === 'POST') {
    sendJson(context.response, 200, await context.store.undoMerge(undo[1], context.actor));
    return true;
  }
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/merge$/);
  if (!match || context.method !== 'POST') return false;
  const result = await context.store.mergeDocuments(match[1], await readBody(context.request), context.actor);
  try {
    const report = await analyzeCanvas(context.store, match[1], '', context.jevDecider ?? decideWithJev, { families: ['links'] });
    sendJson(context.response, 200, { ...result, postMerge: { status: 'complete',
      connections: report.items.filter(item => item.category === 'connection' && item.blockIds.includes(result.keepBlockId)) } });
  } catch (error) {
    sendJson(context.response, 200, { ...result, postMerge: { status: 'failed',
      reason: error instanceof Error ? error.message : 'Could not check new links' } });
  }
  return true;
}

async function canvasBlockMove(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/move$/);
  if (!match || context.method !== 'POST') return false;
  const { targetCanvasId } = await readBody(context.request);
  if (typeof targetCanvasId !== 'string') throw new ApiError(400, 'targetCanvasId is required');
  sendJson(context.response, 200, await context.store.moveBlockToCanvas(match[1], match[2], targetCanvasId, context.actor));
  return true;
}

async function canvasLayout(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/layout$/);
  if (!match || context.method !== 'PUT') return false;
  const body = await readBody(context.request);
  sendJson(context.response, 200, await context.store.updateLayout(match[1], body.positions));
  return true;
}

async function canvasAutomation(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/automations$/);
  if (!match || context.method !== 'POST') return false;
  const { kind, groupBy } = await readBody(context.request);
  if (!['layout', 'connection', 'regroup', 'purpose', 'work_area', 'reviewer', 'cross_connect'].includes(String(kind))) throw new ApiError(400, 'Unknown canvas automation');
  if (groupBy !== undefined && !['work_area', 'purpose', 'lane'].includes(String(groupBy))) throw new ApiError(400, 'groupBy must be work_area, purpose, or lane');
  sendJson(context.response, 200, await runCanvasAutomation(context.store, match[1], kind as AutomationKind, context.jevDecider,
    { groupBy: groupBy as GroupBy | undefined, actor: `Jev · ${context.actor}` }));
  return true;
}

async function canvasBlocks(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/blocks$/);
  if (!match || context.method !== 'POST') return false;
  sendJson(context.response, 201, await context.store.createBlock(match[1], await readBody(context.request), context.actor));
  return true;
}

async function blockDocument(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)$/);
  if (!match) return false;
  if (context.method === 'PUT') {
    sendJson(context.response, 200, await context.store.updateBlock(match[1], match[2], await readBody(context.request), context.actor));
    return true;
  }
  if (context.method === 'DELETE') {
    await context.store.deleteBlock(match[1], match[2], context.actor);
    sendJson(context.response, 200, { ok: true });
    return true;
  }
  return false;
}

async function blockDownload(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/download$/);
  if (!match || context.method !== 'GET') return false;
  const canvas = await context.store.getCanvas(match[1]);
  const block = canvas.blocks.find(item => item.id === match[2]);
  if (!block) throw new ApiError(404, 'Document not found');
  context.response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${path.basename(block.file)}"`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  context.response.end(block.content);
  return true;
}

async function websiteAsset(context: RouteContext): Promise<boolean> {
  const { route, response, method, store, url } = context;
  const match = route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/site(?:\/(.*))?$/);
  if (!match || method !== 'GET') return false;
  if (!route.endsWith('/') && match[3] === undefined) {
    response.writeHead(302, { location: `${route}/`, 'cache-control': 'no-store' });
    response.end();
    return true;
  }
  const site = await siteResponse(store, match[1], match[2], decodeURIComponent(match[3] || ''), url.searchParams.has('static'));
  response.writeHead(site.status, { 'content-type': site.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(site.body);
  return true;
}

async function appRoute(context: RouteContext): Promise<boolean> {
  if (context.route.startsWith('/api/') || context.method !== 'GET') return false;
  await serveApp(context.route, context.response);
  return true;
}

const routeHandlers = [workspaceAndSettings, connectionRoutes, jevRoutes, searchAndChat, streamingChat, workspaceCanvas, workspaceAutomation, canvasDocument, versionRoutes,
  canvasInsights, jevReadActions, canvasMerge, canvasBlockMove, canvasLayout, canvasAutomation, taskInsightRoutes, taskRoutes,
  lockRoutes, canvasBlocks, blockDocument, blockDownload, websiteAsset];

async function dispatch(context: RouteContext): Promise<void> {
  const { request, response, method, route, store } = context;
  const mcp = route.match(/^\/mcp(?:\/t\/([^/]+))?\/?$/);
  if (mcp) { await handleMcpHttp(store, request, response, mcp[1] ? decodeURIComponent(mcp[1]) : undefined); return; }
  if (route.startsWith('/api/')) {
    // A sandboxed HTML document has an opaque ("null") origin. It must never change data.
    if (!['GET', 'HEAD'].includes(method) && request.headers.origin === 'null') throw new ApiError(403, 'Requests from sandboxed documents are not allowed');
    if (await sessionRoutes(context)) return;
    if (!hasApiAccess(request)) throw new ApiError(401, 'Sign in with the workspace access token');
    for (const handler of routeHandlers) {
      if (await handler(context)) return;
    }
  } else if (await appRoute(context)) return;
  sendJson(response, 404, { error: 'Route not found' });
}

function respondError(response: ServerResponse, error: unknown): void {
  const status = error instanceof ApiError ? error.status : 500;
  const message = error instanceof ApiError ? error.message : 'Internal server error';
  if (status === 500) console.error(error);
  sendJson(response, status, { error: message });
}

export async function createApiServer(options: { dataDir: string; fetcher?: typeof fetch; agentFactory?: DeepAgentFactory; jevDecider?: JevDecider }): Promise<Server> {
  const store = new CanvasStore(path.resolve(options.dataDir));
  const intentTokens = new Map<string, IntentToken>();
  await store.init();
  const stopUsageLogging = registerJevUsageLogging(store.root);
  const server = createServer(async (request, response) => {
    try {
      const method = request.method!;
      const url = new URL(request.url!, 'http://localhost');
      await dispatch({ store, request, response, method, route: url.pathname, url, fetcher: options.fetcher, agentFactory: options.agentFactory,
        jevDecider: options.jevDecider, actor: requestActor(request), intentTokens });
    } catch (error) {
      respondError(response, error);
    }
  });
  server.on('close', stopUsageLogging);
  return server;
}

function validPort(port: number): boolean { return Number.isInteger(port) && port >= 0 && port <= 65535; }

export async function start(port: number, dataDir: string, host = '127.0.0.1'): Promise<Server> {
  if (!validPort(port)) throw new Error('PORT must be a valid TCP port');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !accessToken()) {
    console.warn('Warning: HOST exposes the canvas beyond this machine without SYMBIKNOW_ACCESS_TOKEN. Anyone who can reach it can read and change documents.');
  }
  const server = await createApiServer({ dataDir });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
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
