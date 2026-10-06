import { chat } from './chat.js';
import { createChatStream, sendChatStream } from './chat-stream.js';
import type { RouteContext } from './api-context.js';
import { sendJson, readBody } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';
import { chatProposalEndpoints } from './api-chat-proposals.js';
import { ApiError } from './errors.js';
import { jevApiPrincipal } from './jev-api-principal.js';
import { normalizeEvidence } from '../shared/evidence.js';
import type { SymbiPassage } from '../shared/symbi-contract.js';
import type { CanvasBlock, SearchHit } from '../shared/types.js';
import { searchCandidates } from './search-candidates.js';

type CanvasSummary = Awaited<ReturnType<RouteContext['store']['getCanvasSummary']>>;

async function indexedPassageSource(context: RouteContext, passage: SymbiPassage,
  canvases: Map<string, CanvasSummary>) {
  try {
    const canvas = canvases.get(passage.canvasId) ?? await context.store.getCanvasSummary(passage.canvasId);
    canvases.set(passage.canvasId, canvas);
    return { canvas, block: await context.store.getCanvasBlock(passage.canvasId, passage.blockId) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

async function indexedPassageHit(context: RouteContext, query: string, passage: SymbiPassage,
  canvases: Map<string, CanvasSummary>): Promise<SearchHit | undefined> {
  const source = await indexedPassageSource(context, passage, canvases);
  if (!source) return undefined;
  const { canvas, block } = source;
  if (block.contentHash !== passage.contentHash || block.content.slice(passage.startOffset, passage.endOffset) !== passage.excerpt) return undefined;
  // The index points to a current body passage; keep an exact or fuzzy title match visible as a title result.
  const titleCandidate = searchCandidates([{ ...canvas, blocks: [block] }], query, { limit: 1 })[0];
  if (titleCandidate?.matchIn === 'title') return titleCandidate;
  return indexedBodyHit(canvas, block, query, passage);
}

function indexedBodyHit(canvas: CanvasSummary, block: CanvasBlock, query: string, passage: SymbiPassage): SearchHit | undefined {
  const evidence = normalizeEvidence({ claim: query, passage: passage.excerpt, sourceText: block.content,
    canvasId: passage.canvasId, documentId: block.id, documentTitle: block.title, contentHash: block.contentHash,
    start: passage.startOffset, end: passage.endOffset, checkedAt: new Date().toISOString() });
  if (!evidence) return undefined;
  return { canvasId: canvas.id, canvasName: canvas.name, blockId: block.id, title: block.title,
    excerpt: passage.excerpt, group: block.group, tags: block.tags ?? [], kind: block.kind, matchIn: 'body',
    retrieval: { kind: 'semantic', matchedTerms: [] }, evidence };
}

async function indexedHits(context: RouteContext, query: string, passages: SymbiPassage[]): Promise<SearchHit[]> {
  const canvases = new Map<string, CanvasSummary>();
  const hits: SearchHit[] = [];
  for (const passage of passages) {
    const hit = await indexedPassageHit(context, query, passage, canvases);
    if (hit) hits.push(hit);
  }
  return [...new Map(hits.map(hit => [`${hit.canvasId}\0${hit.blockId}`, hit])).values()];
}

async function indexedSearch(context: RouteContext, query: string, canvasId: string | null): Promise<{
  hits: SearchHit[]; allowedCanvasIds?: string[] }> {
  if (!query.trim()) return { hits: [] };
  const principal = await jevApiPrincipal(context.store, context.request, true);
  if (!context.symbiIndex) return { hits: [], allowedCanvasIds: principal.allowedCanvasIds };
  const expectedDocumentIds = await context.symbiIndex.expectedDocumentIds(principal.allowedCanvasIds, canvasId ?? undefined);
  const found = await context.symbiIndex.search({ query, mode: 'hybrid', canvasId: canvasId ?? undefined,
    allowedCanvasIds: principal.allowedCanvasIds, allowedDocumentIds: expectedDocumentIds,
    expectedDocumentIds, limit: 100 });
  return { hits: await indexedHits(context, query, found.passages), allowedCanvasIds: principal.allowedCanvasIds };
}

async function lexicalSearch(context: RouteContext, query: string, canvasId: string | null,
  allowedCanvasIds?: string[]): Promise<SearchHit[]> {
  if (!allowedCanvasIds) return (await context.store.search(query)).filter(hit => !canvasId || hit.canvasId === canvasId);
  const allowed = new Set(allowedCanvasIds);
  const workspaces = await context.store.listWorkspaces();
  const canvasIds = workspaces.flatMap(workspace => workspace.canvases.map(canvas => canvas.id))
    .filter(id => allowed.has(id) && (!canvasId || canvasId === id));
  const canvases = await Promise.all(canvasIds.map(id => context.store.getCanvas(id)));
  return searchCandidates(canvases, query);
}

export { investigationRoutes } from './api-chat-investigations.js';

async function searchResults(context: RouteContext, query: string, canvasId: string | null): Promise<SearchHit[]> {
  if (canvasId) await context.store.getCanvasSummary(canvasId);
  const indexed = await indexedSearch(context, query, canvasId);
  const legacy = indexed.hits.length >= 40 ? [] : await lexicalSearch(context, query, canvasId, indexed.allowedCanvasIds);
  const seen = new Set(indexed.hits.map(hit => `${hit.canvasId}\0${hit.blockId}`));
  return [...indexed.hits, ...legacy.filter(hit => !seen.has(`${hit.canvasId}\0${hit.blockId}`))].slice(0, 100);
}

function validSearchPage(limit: number, offset: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0;
}

function searchPageParameters(context: RouteContext): { limit: number; offset: number } | undefined {
  const limitValue = context.url.searchParams.get('limit');
  const cursorValue = context.url.searchParams.get('cursor');
  if (limitValue === null && cursorValue === null) return undefined;
  return { limit: Number(limitValue ?? 50), offset: Number(cursorValue ?? 0) };
}

function sendSearchPage(context: RouteContext, hits: SearchHit[]): void {
  const page = searchPageParameters(context);
  if (!page) { sendJson(context.response, 200, hits); return; }
  const { limit, offset } = page;
  if (!validSearchPage(limit, offset)) throw new ApiError(400, 'Invalid search pagination');
  sendJson(context.response, 200, { items: hits.slice(offset, offset + limit),
    nextCursor: offset + limit < hits.length ? String(offset + limit) : undefined });
}

const searchEndpoints: Endpoint[] = [
  { method: 'GET', path: '/api/search', handle: async context => {
    const query = context.url.searchParams.get('q') || '';
    const canvasId = context.url.searchParams.get('canvasId');
    sendSearchPage(context, await searchResults(context, query, canvasId));
  } },
  { method: 'POST', path: '/api/chat', handle: async context => {
    sendJson(context.response, 200, await chat(context.store, await readBody(context.request), {
      signal: context.signal, agentFactory: context.agentFactory,
    }));
  } },
];

export function searchAndChat(context: RouteContext): Promise<boolean> { return runEndpoints(context, searchEndpoints); }

const chatEndpoints: Endpoint[] = [
  ...chatProposalEndpoints,
  { method: 'POST', path: '/api/chat/stream', handle: async context => {
    const session = await createChatStream(context.store, await readBody(context.request),
      context.agentFactory, { signal: context.signal });
    await sendChatStream(context.response, session, context.signal);
  } },
];

export function streamingChat(context: RouteContext): Promise<boolean> { return runEndpoints(context, chatEndpoints); }
