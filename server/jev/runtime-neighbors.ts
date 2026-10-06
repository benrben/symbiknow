import type { JevActionRequest } from '../../shared/jev-types.js';
import type { SymbiPassage } from '../../shared/symbi-contract.js';
import type { JevEvaluationContext, JevInputDocument } from './actions/context.js';

function currentPassage(passage: SymbiPassage, document: JevInputDocument, workspaceId: string): boolean {
  return document.snapshot.workspaceId === workspaceId && document.snapshot.contentHash === passage.contentHash
    && !document.block.archived && !document.block.processingExcluded;
}
function sameSource(left: JevInputDocument, right: JevInputDocument): boolean {
  return left.canvasId === right.canvasId && left.block.id === right.block.id;
}
function passageId(passage: SymbiPassage, source: JevInputDocument,
  visible: Map<string, JevInputDocument>, workspaceId: string): string | undefined {
  if (passage.score !== undefined && passage.score <= 0) return;
  const id = `${passage.canvasId}:${passage.blockId}`;
  const current = visible.get(id);
  if (!current || !currentPassage(passage, current, workspaceId)) return;
  if (sameSource(current, source)) return;
  return id;
}

async function neighborsForSource(context: JevEvaluationContext, source: JevInputDocument,
  visible: Map<string, JevInputDocument>, retrieve: (context: JevEvaluationContext, source: JevInputDocument) => Promise<SymbiPassage[]>): Promise<readonly [string, string[]]> {
  const sourceId = `${source.canvasId}:${source.block.id}`;
  try {
    const passages = await retrieve(context, source);
    const ids = passages.map(passage => passageId(passage, source, visible, context.workspaceId))
      .filter((id): id is string => id !== undefined);
    return [sourceId, [...new Set(ids)].slice(0, 24)];
  } catch { return [sourceId, []]; }
}

export async function attachIndexedNeighbors(context: JevEvaluationContext, request: JevActionRequest,
  retrieve?: (context: JevEvaluationContext, source: JevInputDocument) => Promise<SymbiPassage[]>): Promise<void> {
  if (!retrieve || !['profile', 'link', 'flag_duplicate'].includes(request.action)) return;
  const visible = new Map(context.documents.map(document => [`${document.canvasId}:${document.block.id}`, document]));
  const sources = context.documents.filter(document => document.canvasId === request.canvasId
    && (!request.blockIds?.length || request.blockIds.includes(document.block.id))).slice(0, 16);
  const results = await Promise.all(sources.map(source => neighborsForSource(context, source, visible, retrieve)));
  context.retrievedNeighbors = Object.fromEntries(results);
}
