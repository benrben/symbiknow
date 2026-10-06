import type { JevActionRequest, JevPrincipal, JevWorkspaceState } from '../../shared/jev-types.js';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import type { JevEvaluationContext } from './actions/context.js';
import { automationPrincipal, principalFingerprint, requireCanvas } from './authorization.js';
import { evaluationContext } from './context.js';
import type { JevProposalExecutor } from './proposals.js';
import { appendQueuedJob, queuedExistingJob, type StoredJevJob } from './runtime-queue.js';
import type { JevWorkspaceFiles } from './workspace.js';

export interface JevBatchAdmission { jobs: StoredJevJob[]; full: boolean }
const profileRequest = z.object({ action: z.literal('profile'), canvasId: z.string().min(1),
  blockIds: z.array(z.string().min(1)).length(1), idempotencyKey: z.string().min(1),
  query: z.undefined().optional(), options: z.undefined().optional() }).strict();
function checkRequest(request: JevActionRequest, principal: JevPrincipal): void {
  requireCanvas(principal, request.canvasId);
  // Server-generated retry identities may exceed the public API's operation-key length limit.
  if (!profileRequest.safeParse(request).success)
    throw new ApiError(400, 'Bulk admission requires independent automatic source profiles');
}
function availableCapacity(state: JevWorkspaceState): number {
  return Math.max(0, 200 - state.jobs.filter(job => job.state === 'queued' || job.state === 'running').length);
}
function contextRequest(requests: JevActionRequest[]): JevActionRequest {
  const first = requests[0];
  return { ...first, blockIds: [...new Set(requests.filter(request => request.canvasId === first.canvasId)
    .flatMap(request => request.blockIds!))] };
}
function requireSelected(context: JevEvaluationContext, request: JevActionRequest): void {
  if (!context.documents.some(document => document.canvasId === request.canvasId && document.block.id === request.blockIds![0]))
    throw new ApiError(404, 'Requested source is excluded or unavailable');
}
function appendRequests(state: JevWorkspaceState, requests: JevActionRequest[], context: JevEvaluationContext | undefined,
  principal: JevPrincipal): JevBatchAdmission & { changed: boolean } {
  const result: JevBatchAdmission & { changed: boolean } = { jobs: [], full: false, changed: false };
  for (const request of requests) {
    const existing = queuedExistingJob(state, request);
    if (existing) { result.jobs.push(existing); continue; }
    if (!availableCapacity(state)) { result.full = true; break; }
    requireSelected(context!, request);
    result.jobs.push(appendQueuedJob(state, request, context!, principal));
    result.changed = true;
  }
  return result;
}
/** Called under the workspace queue; each source keeps an independent checked, durable job. */
export async function enqueueJevJobs(store: CanvasStore, files: JevWorkspaceFiles, executor: JevProposalExecutor,
  workspaceId: string, supplied: JevActionRequest[], principal: JevPrincipal): Promise<JevBatchAdmission> {
  if (principalFingerprint(principal) !== principalFingerprint(automationPrincipal))
    throw new ApiError(403, 'Bulk admission requires automatic processing authorization');
  const requests = structuredClone(supplied);
  for (const request of requests) checkRequest(request, principal);
  if (!requests.length) return { jobs: [], full: false };
  await executor.recoverInside(workspaceId);
  const state = await files.read(workspaceId);
  const pending = requests.filter(request => !queuedExistingJob(state, request)).slice(0, availableCapacity(state));
  const context = pending.length ? await evaluationContext(store, workspaceId, state, contextRequest(pending), principal,
    new AbortController().signal, { activity: 'validate' }) : undefined;
  const result = appendRequests(state, requests, context, principal);
  if (result.changed) await files.write(workspaceId, state);
  return { jobs: structuredClone(result.jobs), full: result.full };
}
