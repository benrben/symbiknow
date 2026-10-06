import type { JevMutation,JevPrincipal,JevWorkspaceState } from '../shared/jev-types.js';
import type { CanvasBlock } from '../shared/types.js';
import type { RouteContext } from './api-context.js';
import { ApiError } from './errors.js';
import { actionRequest,documentGroupApprovalSchema,documentRecheckSchema,draftCancellationSchema,groupApprovalSchema,metadataSchema,parentUndoSchema,parsedInput } from './jev-api-input.js';
import { checkJevConnection } from './jev-connection.js';
import { projectJevState } from './jev-read-projections.js';
import { decisionInspection, documentProgress, documentProgresses } from './jev/runtime-progress.js';
import { documentReview } from './jev/document-review.js';
import { SYMBI_CONTRACT_VERSION, type SymbiActionName } from '../shared/symbi-contract.js';
import type { JevRuntime } from './jev/runtime.js';

export interface JevApiCall {
  context: RouteContext; workspaceId: string; principal: JevPrincipal; canvasId?: string;
  runtime: JevRuntime; id: string; command: string; input: Record<string, unknown>;
}
export interface JevApiEndpoint {
  path: RegExp; method: string; input?: boolean; handle: (call: JevApiCall) => Promise<unknown>;
}
const readViews = ['jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox', 'jev_job'];
const progressHashCache = new WeakMap<RouteContext['store'], Map<string, { signature: string; hash: string }>>();
function cachedProgressHash(store: RouteContext['store'], key: string, signature: string): string | undefined {
  return progressHashCache.get(store)?.get(key)?.signature === signature ? progressHashCache.get(store)?.get(key)?.hash : undefined;
}
function rememberProgressHash(store: RouteContext['store'], key: string, signature: string, hash: string): void {
  let cache = progressHashCache.get(store);
  if (!cache) { cache = new Map(); progressHashCache.set(store, cache); }
  cache.delete(key);
  cache.set(key, { signature, hash });
  if (cache.size > 2048) cache.delete(cache.keys().next().value!);
}

function requireApproval(principal: JevPrincipal): void {
  if (!principal.canApprove) throw new ApiError(403, 'An authorized workspace reviewer must approve this change');
}
function requiredCanvas(canvasId: string | undefined, message: string): string {
  if (!canvasId) throw new ApiError(400, message);
  return canvasId;
}
function requireReadView(view: string, principal: JevPrincipal): void {
  if (!readViews.includes(view) || (principal.tools && !principal.tools.includes(view))) throw new ApiError(403, 'This token does not permit that read tool');
}
function agentState(call: JevApiCall, state: JevWorkspaceState): unknown {
  const { context, principal } = call;
  const view = context.url.searchParams.get('view') ?? 'jev_activity';
  requireReadView(view, principal);
  const id = context.url.searchParams.get('blockId') ?? context.url.searchParams.get('jobId') ?? undefined;
  const pagination = compatibilityPagination(context);
  return projectJevState(view, state, id, context.url.searchParams.get('query') ?? '',
    { ...pagination, canvasId: call.canvasId });
}
function compatibilityPagination(context: RouteContext) {
  const limit = Number(context.url.searchParams.get('limit') ?? 25);
  const cursor = Number(context.url.searchParams.get('cursor') ?? 0);
  if (!validCompatibilityLimit(limit) || !validCompatibilityCursor(cursor)) {
    throw new ApiError(400, 'Invalid compatibility pagination');
  }
  return { limit, cursor, paginated: context.url.searchParams.has('limit') || context.url.searchParams.has('cursor') };
}
function validCompatibilityLimit(limit: number): boolean { return Number.isInteger(limit) && limit >= 1 && limit <= 100; }
function validCompatibilityCursor(cursor: number): boolean { return Number.isInteger(cursor) && cursor >= 0; }
async function readState(call: JevApiCall): Promise<unknown> {
  const { context, runtime, workspaceId, principal } = call;
  const summary = principal.kind === 'user' && context.url.searchParams.get('summary') === '1';
  const state = await runtime.read(workspaceId, principal, summary);
  if (principal.kind !== 'user') return agentState(call, state);
  const settings = await context.store.secretSettings();
  return { ...state, summary, commandPlans: [],
    hasApiKey: Boolean(settings.secrets?.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY),
    canApprove: Boolean(principal.canApprove), canConfigure: Boolean(principal.canConfigure) };
}
async function progress(call: JevApiCall): Promise<unknown> {
  const { context, runtime, workspaceId, principal } = call;
  const canvasId = context.url.searchParams.get('canvasId') ?? call.canvasId;
  const canvasIds = await progressCanvasIds(call, canvasId);
  const current = await currentProgressVersions(context, canvasIds);
  const state = await runtime.read(workspaceId, principal, true);
  const latest = latestProgressBySource(documentProgresses(state), new Set(canvasIds));
  return { version: SYMBI_CONTRACT_VERSION, documents: await currentProgressDocuments(context, latest, current) };
}
async function progressCanvasIds(call: JevApiCall, canvasId: string | undefined): Promise<string[]> {
  const { context, workspaceId, principal } = call;
  requireProgressCanvasScope(canvasId, principal);
  const workspace = (await context.store.listWorkspaces()).find(item => item.id === workspaceId);
  if (!workspace) throw new ApiError(404, 'Workspace not found');
  const canvases = workspace.canvases.filter(canvas => visibleProgressCanvas(canvas.id, canvasId, principal.allowedCanvasIds));
  if (canvasId && !canvases.length) throw new ApiError(404, 'Canvas not found');
  return canvases.map(canvas => canvas.id);
}
function requireProgressCanvasScope(canvasId: string | undefined, principal: JevPrincipal): void {
  if (canvasId && principal.allowedCanvasIds && !principal.allowedCanvasIds.includes(canvasId)) throw new ApiError(404, 'Canvas not found');
}
function visibleProgressCanvas(id: string, requested: string | undefined, allowed: string[] | undefined): boolean {
  return (!requested || id === requested) && (!allowed || allowed.includes(id));
}
async function currentProgressVersions(context: RouteContext, canvasIds: string[]): Promise<Map<string, string>> {
  const current = new Map<string, string>();
  for (const canvasId of canvasIds) {
    const summary = await context.store.getCanvasSummary(canvasId);
    for (const block of summary.blocks) if (block.contentVersion) current.set(`${canvasId}:${block.id}`, block.contentVersion);
  }
  return current;
}
type ProgressDocument = ReturnType<typeof documentProgresses>[number];
function latestProgressBySource(items: ProgressDocument[], permitted: Set<string>): Map<string, ProgressDocument> {
  const latest = new Map<string, ProgressDocument>();
  for (const item of items) {
    if (!permitted.has(item.canvasId)) continue;
    const key = `${item.canvasId}:${item.blockId}`;
    if (!latest.has(key) || latest.get(key)!.updatedAt < item.updatedAt) latest.set(key, item);
  }
  return latest;
}
async function currentProgressDocuments(context: RouteContext, latest: Map<string, ProgressDocument>, current: Map<string, string>): Promise<ProgressDocument[]> {
  const documents: ProgressDocument[] = [];
  for (const item of latest.values()) {
    const key = `${item.canvasId}:${item.blockId}`;
    const signature = current.get(key);
    if (!signature) continue;
    if (await progressSourceCurrent(context, item, key, signature)) documents.push(item);
  }
  return documents;
}
async function progressSourceCurrent(context: RouteContext, item: ProgressDocument, key: string, signature: string): Promise<boolean> {
  try {
    let hash = cachedProgressHash(context.store, key, signature);
    if (!hash) {
      hash = (await context.store.getCanvasBlock(item.canvasId, item.blockId)).contentHash!;
      rememberProgressHash(context.store, key, signature, hash);
    }
    return hash === item.contentHash;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return false;
  }
}
async function inspect(call: JevApiCall): Promise<unknown> {
  const { context, runtime, workspaceId, principal } = call;
  const { jobId, action } = inspectionQuery(context);
  const state = await runtime.read(workspaceId, principal, false);
  const current = scopedInspectionSource(state, jobId, principal);
  const block = await context.store.getCanvasBlock(current.canvasId, current.blockId);
  if (block.contentHash !== current.contentHash) throw new ApiError(409, 'The source changed since this decision');
  const detail = decisionInspection(state, jobId, action);
  if (!detail) throw new ApiError(404, 'Decision not found');
  return detail;
}
function inspectionQuery(context: RouteContext): { jobId: string; action: SymbiActionName } {
  const jobId = context.url.searchParams.get('jobId');
  const action = context.url.searchParams.get('action');
  const allowed: SymbiActionName[] = ['profile', 'label', 'link', 'flag_duplicate', 'file', 'suggest_home_canvas'];
  if (!jobId || jobId.length > 128 || !allowed.includes(action as SymbiActionName)) throw new ApiError(400, 'Inspection requires jobId and action');
  return { jobId, action: action as SymbiActionName };
}
function scopedInspectionSource(state: JevWorkspaceState, jobId: string, principal: JevPrincipal) {
  const current = documentProgress(state, jobId);
  if (!current || (principal.allowedCanvasIds && !principal.allowedCanvasIds.includes(current.canvasId))) {
    throw new ApiError(404, 'Job not found');
  }
  return current;
}
async function reviewDocumentSource(call: JevApiCall, canvasId: string, expectedHash?: string) {
  if (call.principal.allowedCanvasIds && !call.principal.allowedCanvasIds.includes(canvasId)) throw new ApiError(404, 'Canvas not found');
  const canvas = await call.context.store.getCanvasSummary(canvasId);
  if (canvas.workspaceId !== call.workspaceId) throw new ApiError(404, 'Canvas not found');
  const block = await call.context.store.getCanvasBlock(canvasId, call.id);
  if (expectedHash && block.contentHash !== expectedHash) throw new ApiError(409, 'The document changed since this review');
  return block;
}
async function documentReviewGet(call: JevApiCall): Promise<unknown> {
  const canvasId = requiredCanvas(call.canvasId ?? call.context.url.searchParams.get('canvasId') ?? undefined, 'A canvas is required for document review');
  const block = await reviewDocumentSource(call, canvasId);
  const state = await call.runtime.read(call.workspaceId, call.principal, false);
  return documentReview(state, call.principal, canvasId, block);
}
async function documentApproveGroup(call: JevApiCall): Promise<unknown> {
  requireApproval(call.principal);
  const input = parsedInput(documentGroupApprovalSchema, call.input, 'Choose a current document and group proposal');
  if (call.canvasId && call.canvasId !== input.canvasId) throw new ApiError(400, 'Canvas does not match the review');
  const block = await reviewDocumentSource(call, input.canvasId, input.contentHash);
  const state = await call.runtime.read(call.workspaceId, call.principal, false);
  const review = documentReview(state, call.principal, input.canvasId, block);
  if (review.grouping?.proposalId !== input.proposalId || !review.grouping.canApprove) {
    throw new ApiError(409, 'This document has no current group proposal to approve');
  }
  const { approveJevGroup } = await import('./jev/group-approval.js');
  return approveJevGroup(call.context.store, call.runtime, call.workspaceId,
    { groupKey: review.grouping.groupKey, proposalIds: review.grouping.proposalIds }, call.principal);
}
async function documentRecheck(call: JevApiCall): Promise<unknown> {
  const input = parsedInput(documentRecheckSchema, call.input, 'Choose a current document to recheck');
  if (call.canvasId && call.canvasId !== input.canvasId) throw new ApiError(400, 'Canvas does not match the review');
  return call.runtime.recheckDocument(call.workspaceId, input.canvasId, call.id, input.contentHash, call.principal);
}
async function connection(call: JevApiCall): Promise<unknown> { return checkJevConnection(call.context, call.principal); }
async function configure(call: JevApiCall): Promise<unknown> { return call.runtime.configure(call.workspaceId, call.input, call.principal); }
async function reset(call: JevApiCall): Promise<unknown> { return call.runtime.reset(call.workspaceId, call.principal); }
async function approveGroup(call: JevApiCall): Promise<unknown> {
  requireApproval(call.principal);
  const input = parsedInput(groupApprovalSchema, call.input, 'Choose a valid group and its checked placement proposals');
  const { approveJevGroup } = await import('./jev/group-approval.js');
  return approveJevGroup(call.context.store, call.runtime, call.workspaceId, input, call.principal);
}
async function undoParent(call: JevApiCall): Promise<unknown> {
  requireApproval(call.principal);
  const input = parsedInput(parentUndoSchema, call.input, 'Invalid parent undo request');
  const canvasId = requiredCanvas(call.canvasId, 'Invalid parent undo request');
  return call.runtime.undoParent(call.workspaceId, canvasId, input as unknown as { kind: 'created'; after: CanvasBlock } | { kind: 'edited'; before: CanvasBlock; after: CanvasBlock }, call.principal);
}
async function draft(call: JevApiCall): Promise<unknown> {
  const canvasId = requiredCanvas(call.canvasId, 'A canvas is required for draft review');
  if (call.context.method === 'GET') return (await call.runtime.readDraft(call.workspaceId, canvasId, call.id, call.principal)) ?? null;
  requireApproval(call.principal);
  const input = parsedInput(draftCancellationSchema, call.input, 'Invalid draft cancellation');
  return call.runtime.cancelDraft(call.workspaceId, canvasId, call.id, input.draftId, call.principal);
}
async function metadata(call: JevApiCall): Promise<unknown> {
  requireApproval(call.principal);
  const input = parsedInput(metadataSchema, call.input, 'Invalid metadata override');
  const { blockId, canvasId: suppliedCanvasId, ...patch } = input;
  const canvasId = requiredCanvas(call.canvasId ?? suppliedCanvasId, 'Invalid metadata override');
  return call.runtime.setMetadata(call.workspaceId, canvasId, blockId, patch, call.principal);
}
async function action(call: JevApiCall): Promise<unknown> { return call.runtime.run(call.workspaceId, actionRequest(call.input, call.canvasId), call.principal); }
async function job(call: JevApiCall): Promise<unknown> {
  return call.runtime.cancel(call.workspaceId, call.id, call.principal);
}
async function undo(call: JevApiCall): Promise<unknown> {
  requireApproval(call.principal); return call.runtime.undo(call.workspaceId, call.id, call.principal);
}
async function proposal(call: JevApiCall): Promise<unknown> {
  if (call.command === 'apply') requireApproval(call.principal);
  if (call.command === 'revise') return call.runtime.revise(call.workspaceId, call.id, call.input.mutation as JevMutation, call.principal);
  return call.runtime[call.command as 'apply' | 'dismiss' | 'suppress'](call.workspaceId, call.id, call.principal);
}

export const jevApiEndpoints: JevApiEndpoint[] = [
  { path: /^state$/, method: 'GET', handle: readState },
  { path: /^progress$/, method: 'GET', handle: progress },
  { path: /^inspect$/, method: 'GET', handle: inspect },
  { path: /^documents\/[^/]+\/review$/, method: 'GET', handle: documentReviewGet },
  { path: /^documents\/[^/]+\/approve-group$/, method: 'POST', input: true, handle: documentApproveGroup },
  { path: /^documents\/[^/]+\/recheck$/, method: 'POST', input: true, handle: documentRecheck },
  { path: /^connection$/, method: 'POST', handle: connection },
  { path: /^settings$/, method: 'PUT', input: true, handle: configure },
  { path: /^reset$/, method: 'POST', handle: reset },
  { path: /^metadata$/, method: 'PUT', input: true, handle: metadata },
  { path: /^actions$/, method: 'POST', input: true, handle: action },
  { path: /^undo-parent$/, method: 'POST', input: true, handle: undoParent },
  { path: /^groups\/approve$/, method: 'POST', input: true, handle: approveGroup },
  { path: /^drafts\/[^/]+$/, method: 'GET', handle: draft },
  { path: /^drafts\/[^/]+\/cancel$/, method: 'POST', input: true, handle: draft },
  { path: /^jobs\/[^/]+\/cancel$/, method: 'POST', handle: job },
  { path: /^receipts\/[^/]+\/undo$/, method: 'POST', handle: undo },
  { path: /^proposals\/[^/]+\/(?:apply|dismiss|suppress|revise)$/, method: 'POST', handle: proposal },
];

export function jevApiEndpoint(operation: string, method: string): JevApiEndpoint {
  const endpoint = jevApiEndpoints.find(item => item.path.test(operation));
  if (!endpoint) throw new ApiError(404, 'Jev operation not found');
  if (method !== endpoint.method) throw new ApiError(405, 'Unsupported Jev request method');
  return endpoint;
}
