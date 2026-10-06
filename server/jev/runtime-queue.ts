import { createHash,randomUUID } from 'node:crypto';
import type { JevActionRequest,JevJob,JevPrincipal,JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import type { JevEvaluationContext } from './actions/context.js';
import { currentAction } from './automatic-policy.js';
import { automationPrincipal,principalFingerprint } from './authorization.js';
import { evaluationContext } from './context.js';
import { JevProposalExecutor } from './proposals.js';
import { processingPolicyKey } from './runtime-guards.js';
import { JevWorkspaceFiles } from './workspace.js';
import { applyJevFollowupAdmission, checkJevFollowupAdmission, type JevFollowupAdmission } from './runtime-followup-admission.js';
import type { JevSourceSnapshot } from '../../shared/jev-types.js';

export type StoredJevJob = JevJob & { principal: JevPrincipal; authorizationFingerprint: string; settingsKey: string;
  attempts: number; requestFingerprint?: string; contextCanvasIds?: string[]; contextSources?: JevJob['sources'];
  followupActions?: JevActionRequest['action'][]; followupKey?: string; followupSources?: JevSourceSnapshot[] };
export const readonlyActions: string[] = [];
function fingerprint(request: JevActionRequest): string { return createHash('sha256').update(JSON.stringify(request)).digest('hex'); }
function enabled(state: JevWorkspaceState, request: JevActionRequest): void {
  if (state.settings.paused || state.settings.modes[request.action] === 'off') throw new ApiError(409, 'Symbi Reflex action is paused or disabled');
}
function existingJob(state: JevWorkspaceState, request: JevActionRequest): StoredJevJob | undefined {
  if (!request.idempotencyKey) return undefined;
  const existing = state.jobs.find(job => job.request.idempotencyKey === request.idempotencyKey) as StoredJevJob | undefined;
  if (!existing) return undefined;
  if (existing.requestFingerprint !== fingerprint(request) && JSON.stringify(existing.request) !== JSON.stringify(request)) throw new ApiError(409, 'Operation key was already used with different arguments');
  return structuredClone(existing);
}
function selectedDocuments(context: JevEvaluationContext, request: JevActionRequest) {
  return context.documents.filter(document => document.canvasId === request.canvasId && (!request.blockIds?.length || request.blockIds.includes(document.block.id)));
}

function pending(job: JevJob): boolean { return job.state === 'queued' || job.state === 'running'; }
function sameQueuedRequest(job: JevJob, request: JevActionRequest): boolean {
  return job.state === 'queued' && job.request.action === request.action && job.request.canvasId === request.canvasId
    && JSON.stringify(job.request.blockIds) === JSON.stringify(request.blockIds);
}
function prepareQueue(state: JevWorkspaceState, request: JevActionRequest, principal: JevPrincipal): void {
  if (state.jobs.filter(pending).length >= 200) throw new ApiError(429, 'Symbi Reflex queue is full');
  if (principal.id !== automationPrincipal.id) return;
  for (const job of state.jobs as StoredJevJob[]) if (job.principal.id === automationPrincipal.id && sameQueuedRequest(job, request)) {
    job.state = 'cancelled'; job.error = 'Superseded by a newer source revision'; job.updatedAt = new Date().toISOString();
  }
}
function newJob(request: JevActionRequest, snapshot: JevActionRequest, context: JevEvaluationContext, state: JevWorkspaceState, principal: JevPrincipal): StoredJevJob {
  const selected = selectedDocuments(context, request);
  const sources = readonlyActions.includes(request.action) ? context.documents.map(document => document.snapshot) : selected.map(document => document.snapshot);
  const now = new Date().toISOString();
  return { id: randomUUID(), questionVersion: JEV_QUESTION_VERSION, request: snapshot, requestFingerprint: fingerprint(request),
    principal, authorizationFingerprint: principalFingerprint(principal), contextCanvasIds: context.canvases.map(canvas => canvas.id),
    contextSources: context.documents.map(document => document.snapshot), settingsKey: processingPolicyKey(state),
    attempts: 0, state: 'queued', createdAt: now, updatedAt: now, sources, proposalIds: [] };
}
function retainJobs(state: JevWorkspaceState): void {
  const retained = state.jobs.filter(pending);
  const activeKeys = new Set((retained as StoredJevJob[]).flatMap(job => job.followupKey ? [job.followupKey] : []));
  const activeHistory = (state.jobs as StoredJevJob[]).filter(job => !pending(job) && job.followupKey && activeKeys.has(job.followupKey));
  const activeIds = new Set(activeHistory.map(job => job.id));
  const history = state.jobs.filter(job => !pending(job) && !activeIds.has(job.id))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.createdAt.localeCompare(right.createdAt)).slice(-200);
  state.jobs = [...retained, ...activeHistory, ...history];
}
export function queuedExistingJob(state: JevWorkspaceState, request: JevActionRequest): StoredJevJob | undefined {
  enabled(state, request);
  return existingJob(state, request);
}
export function appendQueuedJob(state: JevWorkspaceState, request: JevActionRequest, context: JevEvaluationContext,
  principal: JevPrincipal, admission?: JevFollowupAdmission): StoredJevJob {
  const snapshot = structuredClone(request);
  prepareQueue(state, request, principal);
  const job = newJob(request, snapshot, context, state, principal);
  applyJevFollowupAdmission(state, job, admission);
  state.jobs.push(job);
  retainJobs(state);
  return job;
}
/** Called while holding the workspace queue; durable jobs contain only checked scope and staged draft references. */
export async function enqueueJevJob(store: CanvasStore, files: JevWorkspaceFiles, executor: JevProposalExecutor,
  workspaceId: string, request: JevActionRequest, principal: JevPrincipal, admission?: JevFollowupAdmission): Promise<StoredJevJob> {
  if (!currentAction(request.action)) throw new ApiError(400, 'Unknown Symbi Reflex action');
  checkJevFollowupAdmission(request, principal, admission);
  await executor.recoverInside(workspaceId);
  const state = await files.read(workspaceId);
  const existing = queuedExistingJob(state, request);
  if (existing) return repairAdmission(files, workspaceId, state, existing, admission);
  const context = await evaluationContext(store, workspaceId, state, request, principal, new AbortController().signal, { activity: 'validate' });
  const job = appendQueuedJob(state, request, context, principal, admission);
  await files.write(workspaceId, state);
  return structuredClone(job);
}

async function repairAdmission(files: JevWorkspaceFiles, workspaceId: string, state: JevWorkspaceState,
  job: StoredJevJob, admission?: JevFollowupAdmission): Promise<StoredJevJob> {
  checkJevFollowupAdmission(job.request, job.principal, admission);
  if (applyJevFollowupAdmission(state, job, admission)) {
    state.jobs = state.jobs.map(item => item.id === job.id ? job : item);
    await files.write(workspaceId, state);
  }
  return job;
}
