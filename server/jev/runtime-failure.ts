import type { JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { isJevBillingFailure } from '../jev-provider-error.js';
import type { CanvasStore } from '../storage.js';
import { stopJobDraft } from './runtime-controls.js';
import type { DocumentJob } from './runtime-document.js';
import type { StoredJevJob } from './runtime-queue.js';
import type { JevWorkspaceFiles } from './workspace.js';

export function providerUnavailable(error: unknown): boolean {
  return error instanceof ApiError && [401, 402, 403, 429, 502, 503, 504].includes(error.status);
}

export async function finishFailedJob(error: unknown, failed: StoredJevJob | undefined,
  failFollowup: (job: StoredJevJob) => Promise<void>, continueJob: (job: StoredJevJob) => Promise<void>): Promise<void> {
  if (failed?.state !== 'failed') return;
  if ((failed as DocumentJob).documentPlan) return;
  if (providerUnavailable(error)) {
    if (failed.followupKey) await failFollowup(failed);
    return;
  }
  await continueJob(failed);
}

function publicError(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Symbi Reflex could not complete the operation; Retry is available';
}

function retryable(error: unknown, job: StoredJevJob, signal: AbortSignal): boolean {
  return checkpointRetryable(error, job, signal) || transientRetryable(error, job, signal);
}
function checkpointRetryable(error: unknown, job: StoredJevJob, signal: AbortSignal): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  return error.message === 'The workspace checkpoint changed during completion'
    && Boolean((job as DocumentJob).documentPlan) && job.attempts < 3 && !signal.aborted;
}
function transientRetryable(error: unknown, job: StoredJevJob, signal: AbortSignal): boolean {
  return error instanceof ApiError && !isJevBillingFailure(error) && [429, 502, 503, 504].includes(error.status)
    && job.attempts < 2 && !signal.aborted;
}

function deferredDocumentFailure(error: unknown, signal: AbortSignal): boolean {
  if (error instanceof ApiError && isJevBillingFailure(error)) return false;
  if (signal.aborted || !(error instanceof ApiError)) return true;
  return [429, 502, 503, 504].includes(error.status);
}

function abortedFailureReason(signal: AbortSignal): string {
  if (signal.reason === 'execution_timeout') return 'Automatic document execution timed out';
  if (signal.reason === 'shutdown') return 'Automatic document processing was interrupted by shutdown';
  return 'Automatic document processing was cancelled before completion';
}

function markFailed(job: StoredJevJob, error: unknown, signal: AbortSignal): number {
  const retry = retryable(error, job, signal);
  job.state = retry ? 'queued' : 'failed';
  job.error = publicError(error);
  job.updatedAt = new Date().toISOString();
  deferDocumentRetry(job, error, signal, retry);
  return retry ? 250 * job.attempts : 0;
}
function deferDocumentRetry(job: StoredJevJob, error: unknown, signal: AbortSignal, retry: boolean): void {
  const plan = (job as DocumentJob).documentPlan;
  if (plan && !retry && deferredDocumentFailure(error, signal)) {
    plan.retryAt = new Date(Date.now() + 60_000).toISOString();
    if (signal.aborted) job.error = abortedFailureReason(signal);
  }
}

export async function recordJevFailure(files: JevWorkspaceFiles, store: CanvasStore, workspaceId: string,
  jobId: string, error: unknown, signal: AbortSignal): Promise<number> {
  return files.serial(workspaceId, async () => {
    const state: JevWorkspaceState = await files.read(workspaceId);
    const job = state.jobs.find(item => item.id === jobId) as StoredJevJob | undefined;
    if (!job || ['cancelled', 'completed'].includes(job.state)) return 0;
    const delay = markFailed(job, error, signal);
    await files.write(workspaceId, state);
    await stopJobDraft(store, job, 'review_unavailable');
    return delay;
  });
}
