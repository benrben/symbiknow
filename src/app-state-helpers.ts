import type { AnswerCanvasTurn, ResearchLayout } from '../shared/answer-canvas';
import type { CanvasBlock, CanvasDocument, ChatSettings } from '../shared/types';
import { authRequiredEvent, browserActor } from './api';
import { emptyResearchEdits, type ResearchCanvasEdits } from './research-edits';
import { recoveredResearchEdits, isSavedResearchTurn } from './research-session-values';

export const defaultSettings: ChatSettings = { provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: '', hasApiKey: false };

export const researchStorageKey = 'symbiknow:research-session';

const canvasFields = ['id', 'name', 'workspaceId'] as const;
const blockFields = ['id', 'title', 'file', 'kind', 'x', 'y', 'width', 'height', 'contentHash',
  'purpose', 'reviewer', 'group', 'workArea', 'archived', 'stale'] as const;
const structuredBlockFields = ['links', 'linkTypes', 'crossLinks', 'tags', 'quality', 'lock'] as const;

function sameCanvasBlock(block: CanvasBlock, next: CanvasBlock): boolean {
  return blockFields.every(field => block[field] === next[field])
    && Boolean(block.contentHash || block.content === next.content)
    && structuredBlockFields.every(field => JSON.stringify(block[field]) === JSON.stringify(next[field]));
}

export function sameCanvas(left: CanvasDocument | null, right: CanvasDocument): boolean {
  if (!left) return false;
  return canvasFields.every(field => left[field] === right[field])
    && left.blocks.length === right.blocks.length
    && left.blocks.every((block, index) => sameCanvasBlock(block, right.blocks[index]));
}

export function replaceBlock(document: CanvasDocument | null, canvasId: string, blockId: string, updated: CanvasBlock) {
  if (!document || document.id !== canvasId) return document;
  return { ...document, blocks: document.blocks.map(block => block.id === blockId ? updated : block) };
}

export function restoredResearch(): { turns: AnswerCanvasTurn[]; edits: ResearchCanvasEdits; layout: ResearchLayout } {
  const empty = { turns: [] as AnswerCanvasTurn[], edits: emptyResearchEdits(), layout: 'mindmap' as ResearchLayout };
  try {
    const value = readStoredResearch();
    if (!value || !Array.isArray(value.turns)) return empty;
    const edits = recoveredResearchEdits(value.edits);
    return { turns: value.turns.filter(isSavedResearchTurn).map(stoppedStoredTurn), edits,
      layout: storedResearchLayout(value.layout) };
  } catch { return empty; }
}

function readStoredResearch() {
  return JSON.parse(window.localStorage.getItem(researchStorageKey) ?? 'null') as Partial<{
    turns: AnswerCanvasTurn[]; edits: ResearchCanvasEdits; layout: ResearchLayout;
  }> | null;
}

function stoppedStoredTurn(turn: AnswerCanvasTurn): AnswerCanvasTurn {
  return { ...turn, status: turn.status === 'working' ? 'stopped' : turn.status };
}

function storedResearchLayout(layout: ResearchLayout | undefined): ResearchLayout {
  return ['roadmap', 'kanban', 'architecture', 'mindmap'].includes(layout ?? '') ? layout! : 'mindmap';
}

export function errorText(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

async function canvasResponseError(response: Response): Promise<Error> {
  if (response.status === 401) window.dispatchEvent(new Event(authRequiredEvent));
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (payload?.error) return new Error(payload.error);
  if ([502, 503, 504].includes(response.status)) return new Error(`Canvas server is unavailable or restarting (${response.status}). Retry in a moment.`);
  return new Error(`Request failed (${response.status})`);
}

export async function readCanvas(id: string, etag?: string): Promise<{ document?: CanvasDocument; etag?: string }> {
  let response: Response;
  try {
    response = await fetch('/api/canvases/' + encodeURIComponent(id), {
      cache: 'no-store',
      headers: { 'x-symbiknow-actor': browserActor, ...(etag ? { 'If-None-Match': etag } : {}) },
    });
  } catch {
    throw new Error('Canvas server is unavailable. Check that it is running, then retry.');
  }
  if (response.status === 304) return { etag };
  if (!response.ok) throw await canvasResponseError(response);
  return { document: await response.json() as CanvasDocument, etag: response.headers.get('ETag') ?? undefined };
}

