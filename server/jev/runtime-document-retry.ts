import type { JevActionRequest, JevDocumentContextRetry, JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import { automationPrincipal, currentPrincipal } from './authorization.js';
import { evaluationContext } from './context.js';
import { automaticDocumentEligible, checkDocumentSources, type DocumentJob } from './runtime-document.js';
import { checkFinishingPolicy } from './runtime-guards.js';
import { appendQueuedJob, type StoredJevJob } from './runtime-queue.js';

type ScheduleRetry = { job: DocumentJob; error: unknown; signal: AbortSignal;
  state: Pick<JevWorkspaceState, 'settings'>; now?: Date };
type AdmitRetry = { store: CanvasStore; state: JevWorkspaceState; workspaceId: string;
  job: DocumentJob; now?: Date };

function contextConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
    && error.message === 'The document context changed during automatic processing';
}

function retryDelay(attempt: number): number {
  return attempt <= 2 ? attempt * 250 : 60_000;
}

function nextRetry(job: DocumentJob): JevDocumentContextRetry {
  const previous = job.documentContextRetry;
  return { lineageId: previous?.lineageId ?? job.id, attempts: (previous?.attempts ?? 0) + 1 };
}

function eligibleFailure(input: ScheduleRetry): boolean {
  return contextConflict(input.error) && !input.signal.aborted && automaticDocumentEligible(input.job, input.state);
}

/** Failed proofs and completed prefixes remain historical; recovery always admits a fresh root. */
export function scheduleDocumentContextRetry(input: ScheduleRetry): number | undefined {
  const { job } = input;
  if (!job.documentPlan || !eligibleFailure(input)) return undefined;
  const retry = nextRetry(job);
  const delay = retryDelay(retry.attempts);
  const retryAt = new Date((input.now ?? new Date()).getTime() + delay).toISOString();
  job.documentContextRetry = { ...retry, retryAt };
  job.documentPlan.retryAt = retryAt;
  job.state = 'failed';
  return delay;
}

function pendingRetry(job: DocumentJob): boolean {
  if (job.state !== 'failed' || !job.documentPlan) return false;
  return Boolean(job.documentContextRetry?.retryAt);
}

function retryReady(input: AdmitRetry): boolean {
  if (!pendingRetry(input.job)) return false;
  const retry = input.job.documentContextRetry!;
  // Immediate replacements are admitted atomically; the caller applies their short drain backoff.
  return retry.attempts <= 2 || Date.parse(retry.retryAt!) <= (input.now ?? new Date()).getTime();
}

function stalePendingCandidates(state: JevWorkspaceState, job: DocumentJob): void {
  const ids = new Set([...job.proposalIds, ...(job.documentPlan?.activeJob?.proposalIds ?? [])]);
  for (const proposal of state.proposals) {
    if (!ids.has(proposal.id) || proposal.state !== 'pending') continue;
    proposal.state = 'stale';
    proposal.automaticHoldReason = 'The document context changed; a fresh automatic review was queued';
  }
}

function retryRequest(job: DocumentJob): JevActionRequest {
  const retry = job.documentContextRetry!;
  const base = (job.request.idempotencyKey ?? `document:${retry.lineageId}`).split(':retry:context:')[0];
  return { action: 'profile', canvasId: job.request.canvasId, blockIds: [...job.request.blockIds!],
    idempotencyKey: `${base}:retry:context:${retry.lineageId}:${retry.attempts}` };
}

async function queueFreshDocumentRetry(input: AdmitRetry): Promise<StoredJevJob> {
  const { store, state, workspaceId, job } = input;
  const signal = new AbortController().signal;
  checkFinishingPolicy(state, job, job, await currentPrincipal(store, job.principal), signal);
  await checkDocumentSources(store, workspaceId, job);
  const request = retryRequest(job);
  const context = await evaluationContext(store, workspaceId, state, request, automationPrincipal, signal, { activity: 'validate' });
  const replacement = appendQueuedJob(state, request, context, automationPrincipal);
  replacement.documentContextRetry = { lineageId: job.documentContextRetry!.lineageId, attempts: job.documentContextRetry!.attempts };
  job.documentContextRetry!.replacementJobId = replacement.id;
  delete job.documentContextRetry!.retryAt;
  delete job.documentPlan!.retryAt;
  stalePendingCandidates(state, job);
  return replacement;
}

function invalidRetrySource(error: unknown): boolean {
  return error instanceof ApiError && [403, 404, 409].includes(error.status);
}

/** Caller holds the workspace lock and persists the failed root together with any fresh admission. */
export async function admitDocumentContextRetry(input: AdmitRetry): Promise<StoredJevJob | undefined> {
  const { state, job } = input;
  const existing = job.documentContextRetry?.replacementJobId;
  if (existing) return state.jobs.find(candidate => candidate.id === existing) as StoredJevJob | undefined;
  if (!retryReady(input)) return undefined;
  if (!automaticDocumentEligible(job, state)) return undefined;
  try { return await queueFreshDocumentRetry(input); }
  catch (error) {
    if (!invalidRetrySource(error)) throw error;
    delete job.documentContextRetry!.retryAt;
    delete job.documentPlan!.retryAt;
    return undefined;
  }
}
