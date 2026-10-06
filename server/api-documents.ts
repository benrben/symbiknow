import path from 'node:path';
import { ApiError } from './errors.js';
import { siteResponse } from './website.js';
import type { RouteContext } from './api-context.js';
import { sendJson, readBody } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';
import { readDeletionPreconditions } from './api-document-preconditions.js';
import { canvasLabelRevision, canvasReadScope, projectCanvasLabels } from './jev-canvas-projection.js';

type Page = { limit: number; offset: number };

function pageNumber(value: string | null, fallback: number, minimum: number, maximum: number, message: string): number {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new ApiError(400, message);
  return number;
}

function queryPage(context: RouteContext, defaultLimit: number, message: string): Page | undefined {
  const limitValue = context.url.searchParams.get('limit');
  const cursorValue = context.url.searchParams.get('cursor');
  if (limitValue === null && cursorValue === null) return;
  return { limit: pageNumber(limitValue, defaultLimit, 1, 100, message),
    offset: pageNumber(cursorValue, 0, 0, Number.MAX_SAFE_INTEGER, message) };
}

function pageCanvas(canvas: Awaited<ReturnType<RouteContext['store']['getCanvas']>>, page?: Page) {
  if (!page) return canvas;
  return { ...canvas, blocks: canvas.blocks.slice(page.offset, page.offset + page.limit),
    nextCursor: page.offset + page.limit < canvas.blocks.length ? String(page.offset + page.limit) : undefined,
    totalBlocks: canvas.blocks.length };
}

function notModified(context: RouteContext, etag: string, page?: Page): boolean {
  if (page || context.request.headers['if-none-match'] !== etag) return false;
  context.response.writeHead(304, { etag, 'cache-control': 'no-store' });
  context.response.end();
  return true;
}

function sendCanvasSummary(context: RouteContext,
  summary: Awaited<ReturnType<typeof projectCanvasLabels>>, page?: Page): boolean {
  if (context.url.searchParams.get('summary') === '1') {
    sendJson(context.response, 200, summary);
    return true;
  }
  if (context.url.searchParams.get('includeContent') === 'false') {
    sendJson(context.response, 200, pageCanvas({ ...summary, groupLabels: summary.groupLabels }, page));
    return true;
  }
  return false;
}

export async function canvasDocument(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)$/);
  if (!match) return false;
  if (context.method === 'DELETE') {
    await context.store.deleteCanvas(match[1]);
    sendJson(context.response, 200, { ok: true });
    return true;
  }
  if (context.method !== 'GET') return false;
  const page = queryPage(context, 50, 'Invalid canvas pagination');
  const allowedCanvasIds = await canvasReadScope(context, match[1]);
  const summary = await projectCanvasLabels(context, await context.store.getCanvasSummary(match[1]), allowedCanvasIds);
  if (sendCanvasSummary(context, summary, page)) return true;
  const etag = canvasLabelRevision(await context.store.getCanvasRevision(match[1]), summary.groupLabels);
  if (notModified(context, etag, page)) return true;
  const canvas = pageCanvas({ ...await context.store.getCanvas(match[1], false, false), groupLabels: summary.groupLabels }, page);
  context.response.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', etag });
  context.response.end(JSON.stringify(canvas));
  return true;
}

export async function canvasBlockMove(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/move$/);
  if (!match || context.method !== 'POST') return false;
  const { targetCanvasId } = await readBody(context.request);
  if (typeof targetCanvasId !== 'string') throw new ApiError(400, 'targetCanvasId is required');
  sendJson(context.response, 200, await context.store.moveBlockToCanvas(match[1], match[2], targetCanvasId, context.actor));
  return true;
}

export async function canvasLayout(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/layout$/);
  if (!match || context.method !== 'PUT') return false;
  const body = await readBody(context.request);
  sendJson(context.response, 200, await context.store.updateLayout(match[1], body.positions));
  return true;
}

export async function canvasBlocks(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/blocks$/);
  if (!match || context.method !== 'POST') return false;
  sendJson(context.response, 201, await context.store.createBlock(match[1], await readBody(context.request), context.actor));
  return true;
}

function importDocuments(input: Record<string, unknown>): unknown[] {
  if (!Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > 20) {
    throw new ApiError(400, 'documents must contain 1 to 20 imports');
  }
  return input.documents;
}

function importObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function importDocument(context: RouteContext, canvasId: string, value: unknown, index: number) {
  const document = importObject(value);
  if (!document) return { index, ok: false, error: 'Invalid document import' };
  if (typeof document.idempotencyKey !== 'string' || !document.idempotencyKey) {
    return { index, ok: false, error: 'idempotencyKey is required' };
  }
  try {
    const saved = await context.store.createBlock(canvasId, document, context.actor);
    const history = await context.store.documentHistory(canvasId, saved.id);
    return { index, ok: true, blockId: saved.id, contentHash: saved.contentHash,
      revision: history.commits[0]?.id, processing: 'pending' };
  } catch (error) {
    return importFailure(index, error);
  }
}

function importFailure(index: number, error: unknown) {
  return { index, ok: false, error: error instanceof ApiError ? error.message : 'Document import failed',
    status: error instanceof ApiError ? error.status : 500 };
}

/** Bounded, retry-safe imports return compact per-document receipts. */
export async function canvasImports(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/imports$/);
  if (!match || context.method !== 'POST') return false;
  const documents = importDocuments(await readBody(context.request));
  const results = [];
  for (const [index, value] of documents.entries()) results.push(await importDocument(context, match[1], value, index));
  sendJson(context.response, 200, { results });
  return true;
}

export async function blockDocument(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)$/);
  if (!match) return false;
  if (context.method === 'GET') {
    await readBlockDocument(context, match[1], match[2]);
    return true;
  }
  if (context.method === 'PUT') {
    await writeBlockDocument(context, match[1], match[2]);
    return true;
  }
  if (context.method === 'DELETE') {
    await context.store.deleteBlock(match[1], match[2], context.actor, await readDeletionPreconditions(context.request));
    sendJson(context.response, 200, { ok: true });
    return true;
  }
  return false;
}

async function readBlockDocument(context: RouteContext, canvasId: string, blockId: string): Promise<void> {
  const branch = context.url.searchParams.get('branch');
  sendJson(context.response, 200, branch
    ? await context.store.readDocumentBranch(canvasId, blockId, branch)
    : await context.store.getCanvasBlock(canvasId, blockId));
}

async function writeBlockDocument(context: RouteContext, canvasId: string, blockId: string): Promise<void> {
  const branch = context.url.searchParams.get('branch');
  const input = await readBody(context.request);
  sendJson(context.response, 200, branch
    ? await context.store.editDocumentBranch(canvasId, blockId, branch, input, context.actor)
    : await context.store.updateBlock(canvasId, blockId, input, context.actor));
}

/** The source links are read and changed within one serialized document mutation. */
export async function canvasLink(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/links$/);
  if (!match || context.method !== 'POST') return false;
  const input = await readBody(context.request);
  if (typeof input.fromBlockId !== 'string' || typeof input.toBlockId !== 'string'
    || !['link', 'unlink'].includes(String(input.action))) throw new ApiError(400, 'Invalid link change');
  await context.store.updateInsightLink(match[1], { type: input.action as 'link' | 'unlink',
    fromBlockId: input.fromBlockId, toBlockId: input.toBlockId }, context.actor);
  const source = await context.store.getCanvasBlock(match[1], input.fromBlockId);
  sendJson(context.response, 200, { fromBlockId: source.id, toBlockId: input.toBlockId,
    links: source.links, metadataRevision: source.metadataRevision });
  return true;
}

export async function blockDownload(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/download$/);
  if (!match || context.method !== 'GET') return false;
  const block = await context.store.getCanvasBlock(match[1], match[2]);
  context.response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${path.basename(block.file)}"`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  context.response.end(block.content);
  return true;
}

export async function websiteAsset(context: RouteContext): Promise<boolean> {
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

function previewKind(value: string | null): 'switch' | 'merge' | 'restore' {
  if (value !== 'switch' && value !== 'merge' && value !== 'restore') throw new ApiError(400, 'Preview kind is required');
  return value;
}

function previewTarget(context: RouteContext, kind: 'switch' | 'merge' | 'restore'): string {
  const target = context.url.searchParams.get(kind === 'restore' ? 'revision' : 'name');
  if (!target) throw new ApiError(400, kind === 'restore' ? 'Revision ID is required' : 'Branch name is required');
  return target;
}

function requiredString(body: Record<string, unknown>, field: string, message: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw new ApiError(400, message);
  return value;
}

const versionEndpoints: Endpoint[] = [
  { method: 'GET', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions$/, handle: async (context, match) => {
    const page = queryPage(context, 25, 'Invalid version pagination');
    if (!page) {
      sendJson(context.response, 200, await context.store.documentHistory(match[1], match[2])); return;
    }
    const history = await context.store.documentHistory(match[1], match[2], { limit: page.limit + 1, cursor: page.offset });
    sendJson(context.response, 200, { ...history, commits: history.commits.slice(0, page.limit),
      nextCursor: history.commits.length > page.limit ? String(page.offset + page.limit) : undefined });
  } },
  { method: 'GET', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions\/preview$/, handle: async (context, match) => {
    const kind = previewKind(context.url.searchParams.get('kind'));
    sendJson(context.response, 200, await context.store.previewDocumentVersion(match[1], match[2], kind, previewTarget(context, kind)));
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions\/branches$/, handle: async (context, match) => {
    const name = requiredString(await readBody(context.request), 'name', 'Branch name is required');
    sendJson(context.response, 201, await context.store.createDocumentBranch(match[1], match[2], name));
  } },
  { method: 'DELETE', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions\/branches\/([^/]+)$/, handle: async (context, match) => {
    sendJson(context.response, 200, await context.store.deleteDocumentBranch(match[1], match[2], decodeURIComponent(match[3]), context.actor));
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions\/switch$/, handle: async (context, match) => {
    const name = requiredString(await readBody(context.request), 'name', 'Branch name is required');
    sendJson(context.response, 200, await context.store.switchDocumentBranch(match[1], match[2], name, context.actor));
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions\/merge$/, handle: async (context, match) => {
    const name = requiredString(await readBody(context.request), 'name', 'Branch name is required');
    sendJson(context.response, 200, await context.store.mergeDocumentBranch(match[1], match[2], name, context.actor));
  } },
  { method: 'POST', path: /^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/versions\/restore$/, handle: async (context, match) => {
    const revision = requiredString(await readBody(context.request), 'revision', 'Revision ID is required');
    sendJson(context.response, 200, await context.store.restoreDocumentRevision(match[1], match[2], revision, context.actor));
  } },
];

export function versionRoutes(context: RouteContext): Promise<boolean> { return runEndpoints(context, versionEndpoints); }
