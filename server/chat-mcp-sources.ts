import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AnswerCanvasResult, AnswerSource } from '../shared/answer-canvas.js';
import type { AskSymbiResult } from '../shared/symbi-contract.js';
import type { CanvasBlock, CanvasDocument, SearchHit } from '../shared/types.js';
import { normalizeEvidence } from '../shared/evidence.js';
import { answerSurface, chooseLayout } from './answer-surface.js';
import { searchTerms } from './search-candidate-text.js';
import { asksForSources } from './chat-input.js';
import type { PreparedRequest } from './chat-stream-types.js';

type SourceCandidate = { canvasId: string; blockId: string; excerpt?: string; score?: number };
async function call<T>(tools: StructuredToolInterface[], name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const selected = tools.find(tool => tool.name === name);
  if (!selected) throw new Error(`The canonical MCP catalog is missing ${name}.`);
  return JSON.parse(String(await selected.invoke(args, { signal }))) as T;
}

async function candidates(tools: StructuredToolInterface[], request: PreparedRequest, signal?: AbortSignal): Promise<SourceCandidate[]> {
  const question = request.context.latest.slice(0, 1000);
  try {
    const answer = await call<AskSymbiResult>(tools, 'ask_symbi', { question, mode: 'semantic', limit: 7 }, signal);
    if (answer.matches.length) return answer.matches.filter(match => match.blockId).map(match => ({ canvasId: match.canvasId,
      blockId: match.blockId!, excerpt: match.passages[0]?.excerpt, score: match.confidence ?? match.passages[0]?.score }));
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error) || !error.message.includes('local search index is unavailable')) throw error;
  }
  // Both indexed and source-text retrieval remain canonical server operations.
  const found = await call<{ items: SearchHit[] }>(tools, 'search_docs', { query: question.slice(0, 200), limit: 7 }, signal);
  const items = found.items.length ? found.items : (await Promise.all(searchTerms(question).slice(0, 4)
    .map(query => call<{ items: SearchHit[] }>(tools, 'search_docs', { query, limit: 3 }, signal)))).flatMap(page => page.items);
  return items.map(hit => ({ canvasId: hit.canvasId, blockId: hit.blockId, excerpt: hit.excerpt }));
}

async function source(tools: StructuredToolInterface[], item: SourceCandidate, request: PreparedRequest,
  canvases: Map<string, Promise<CanvasDocument>>, signal?: AbortSignal): Promise<AnswerSource> {
  const canvas = canvases.get(item.canvasId) ?? call<CanvasDocument>(tools, 'read_canvas', { canvasId: item.canvasId, includeContent: false }, signal);
  canvases.set(item.canvasId, canvas);
  const [document, summary] = await Promise.all([call<CanvasBlock>(tools, 'read_doc', { canvasId: item.canvasId, blockId: item.blockId }, signal), canvas]);
  const excerpt = item.excerpt ?? document.content.slice(0, 300);
  const evidence = normalizeEvidence({ claim: `Candidate context for: ${request.context.latest}`, passage: excerpt,
    sourceText: document.content, canvasId: item.canvasId, documentId: item.blockId, documentTitle: document.title,
    contentHash: document.contentHash, checkedAt: new Date().toISOString() });
  return { canvasId: item.canvasId, canvasName: summary.name, blockId: document.id, title: document.title,
    excerpt, contentHash: document.contentHash, relevance: item.score ?? 1, ...(evidence ? { evidence } : {}) };
}

export async function chatMcpSources(tools: StructuredToolInterface[], request: PreparedRequest, signal?: AbortSignal): Promise<AnswerCanvasResult | null> {
  if (!request.requestedResearchCanvas && !asksForSources(request.context.latest)) return null;
  try {
    const found = await candidates(tools, request, signal);
    const view = request.currentView;
    const anchors = [...new Set([...view.selectedBlockIds, view.readerBlockId, view.focusBlockId].filter((id): id is string => Boolean(id)))];
    const combined = [...anchors.map(blockId => ({ canvasId: request.canvasId, blockId })), ...found];
    const unique = [...new Map(combined.map(item => [`${item.canvasId}:${item.blockId}`, item])).values()].slice(0, 7);
    const canvases = new Map<string, Promise<CanvasDocument>>();
    const sources = await Promise.all(unique.map(item => source(tools, item, request, canvases, signal)));
    const surface = answerSurface(request.context.latest);
    return { query: request.context.latest, canvasId: request.canvasId, selection: 'local', sources,
      surface, ...(surface === 'canvas' ? { layout: chooseLayout(request.context.latest) } : {}) };
  } catch (error) {
    signal?.throwIfAborted();
    console.warn('Local chat source retrieval unavailable; continuing with document tools.', (error as Error).name);
    return null;
  }
}
