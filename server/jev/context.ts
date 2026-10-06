import type { JevActionRequest,JevPrincipal,JevReceipt,JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasDocument } from '../../shared/types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import { automaticPeople } from './actions/automatic.js';
import type { JevEvaluationContext,JevInputDocument } from './actions/context.js';
import { canvasAllowed,requireCanvas } from './authorization.js';
import { sourceSnapshot } from './stamps.js';
import { currentDocumentIndexes } from './document-index.js';
import { unreadWorkspaceSourceVector } from './workspace-lazy-source-vectors.js';

export interface JevEvaluationContextOptions { activity?: 'include' | 'validate' }

function scopedDocuments(workspaceId: string, canvases: CanvasDocument[], principal: JevPrincipal): JevInputDocument[] {
  return canvases.flatMap(canvas => canvas.blocks.filter(block => !block.processingExcluded).map(block => ({
    canvasId: canvas.id, block: { ...block, crossLinks: block.crossLinks?.filter(link => canvasAllowed(principal, link.canvasId)) },
    snapshot: sourceSnapshot(workspaceId, canvas.id, block) })));
}
function checkRequestedDocuments(request: JevActionRequest, documents: JevInputDocument[]): void {
  if (request.blockIds?.some(id => !documents.some(document => document.canvasId === request.canvasId && document.block.id === id))) {
    throw new ApiError(404, 'Requested source is excluded or unavailable');
  }
}
function activity(state: JevWorkspaceState, principal: JevPrincipal): JevEvaluationContext['activity'] {
  return state.receipts.filter(receipt => receipt.sourcesAfter.every(source => canvasAllowed(principal, source.canvasId)))
    .map(receipt => ({ id: receipt.id, action: receipt.action, createdAt: receipt.createdAt,
      summary: activitySummary(receipt),
      sources: receipt.sourcesAfter }));
}
function activitySummary(receipt: JevReceipt): string {
  return `Applied ${receipt.action}${receipt.after.kind === 'document' ? `: ${Object.keys(receipt.after.patch).join(', ')}` : ''}`;
}
function pooledSourceAllowed(text: string, principal: JevPrincipal, visibility: Map<string, boolean>): boolean {
  const prior = visibility.get(text);
  if (prior !== undefined) return prior;
  const allowed = canvasAllowed(principal, JSON.parse(text).canvasId);
  visibility.set(text, allowed);
  return allowed;
}
function activitySourcesAllowed(receipt: JevReceipt, principal: JevPrincipal, visibility: Map<string, boolean>): boolean {
  // The codec already checked these immutable snapshots. Ordinary and replaced slots retain the existing failure behavior.
  const unread = unreadWorkspaceSourceVector(receipt, 'sourcesAfter');
  if (!unread) return receipt.sourcesAfter.every(source => canvasAllowed(principal, source.canvasId));
  return principal.allowedCanvasIds === undefined
    || unread.indices.every(index => pooledSourceAllowed(unread.sourceTexts[index], principal, visibility));
}
function validateActivity(state: JevWorkspaceState, principal: JevPrincipal): void {
  const visibility = new Map<string, boolean>();
  for (const receipt of state.receipts) {
    if (activitySourcesAllowed(receipt, principal, visibility)) activitySummary(receipt);
  }
}
function responsibilityDocuments(documents: JevInputDocument[], request: JevActionRequest): JevInputDocument[] {
  const selected = documents.filter(document => document.canvasId === request.canvasId
    && (!request.blockIds?.length || request.blockIds.includes(document.block.id)));
  const ids = new Set(selected.map(document => document.block.id));
  return [...selected, ...documents.filter(document => !ids.has(document.block.id))];
}
export async function evaluationContext(store: CanvasStore, workspaceId: string, state: JevWorkspaceState,
  request: JevActionRequest, principal: JevPrincipal, signal: AbortSignal,
  options: JevEvaluationContextOptions = {}): Promise<JevEvaluationContext> {
  const workspace = (await store.listWorkspaces()).find(item => item.id === workspaceId);
  if (!workspace) throw new ApiError(404, 'Workspace not found');
  requireCanvas(principal, request.canvasId);
  if (!workspace.canvases.some(canvas => canvas.id === request.canvasId)) throw new ApiError(404, 'Canvas scope not found');
  const allowed = workspace.canvases.filter(canvas => canvasAllowed(principal, canvas.id));
  for (const canvas of allowed) await store.ensureJevStamps(canvas.id);
  const documents = scopedDocuments(workspaceId, await Promise.all(allowed.map(canvas => store.getCanvas(canvas.id, true, false))), principal);
  checkRequestedDocuments(request, documents);
  const tasks = (await Promise.all(allowed.map(async canvas => (await store.listTasks(canvas.id)).map(task => ({ canvasId: canvas.id, task }))))).flat();
  if (options.activity === 'validate') validateActivity(state, principal);
  return { workspaceId, documents, canvases: allowed, tasks, indexes: currentDocumentIndexes(state, documents),
    vocabulary: state.vocabulary.filter(term => term.members.every(member => canvasAllowed(principal, member.canvasId))),
    settings: { ...state.settings, people: automaticPeople(responsibilityDocuments(documents, request), state.settings.people) },
    signal, now: new Date(), activity: options.activity === 'validate' ? undefined : activity(state, principal) };
}
