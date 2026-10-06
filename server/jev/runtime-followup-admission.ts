import type { JevAction, JevActionRequest, JevJob, JevPrincipal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { currentAction } from './automatic-policy.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';

/** Private admission metadata is bound to the checked automatic request, never supplied by the public API. */
export interface JevFollowupAdmission { key: string; remaining: JevAction[] }
export type JevChainedJob = JevJob & { followupActions?: JevAction[]; followupKey?: string; followupSources?: JevSourceSnapshot[] };

function validAdmission(admission: JevFollowupAdmission): boolean {
  return typeof admission.key === 'string' && admission.key.length > 0 && Array.isArray(admission.remaining)
    && admission.remaining.every(action => currentAction(action));
}

export function checkJevFollowupAdmission(request: JevActionRequest, principal: JevPrincipal, admission?: JevFollowupAdmission): void {
  if (!admission) return;
  if (principalFingerprint(principal) !== principalFingerprint(automationPrincipal)) throw new ApiError(403, 'Automatic followup authorization is required');
  if (!validAdmission(admission) || request.idempotencyKey !== `${admission.key}:${request.action}`) throw new ApiError(400, 'Invalid automatic followup admission');
}

export function matchesJevFollowupAdmission(job: JevChainedJob, admission: JevFollowupAdmission): boolean {
  return job.followupKey === admission.key && JSON.stringify(job.followupActions) === JSON.stringify(admission.remaining)
    && Array.isArray(job.followupSources);
}

/** Reuse the original checked chain inputs while each new step records its own fresh canonical sources. */
export function applyJevFollowupAdmission(state: JevWorkspaceState, job: JevChainedJob, admission?: JevFollowupAdmission): boolean {
  if (!admission || matchesJevFollowupAdmission(job, admission)) return false;
  const originals = (state.jobs as JevChainedJob[]).find(item => item.followupKey === admission.key)?.followupSources ?? job.sources;
  job.followupKey = admission.key; job.followupActions = admission.remaining.slice();
  job.followupSources = structuredClone(originals);
  return true;
}
