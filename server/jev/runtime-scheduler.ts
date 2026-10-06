import { automationPrincipal, principalFingerprint } from './authorization.js';
import { currentAction } from './automatic-policy.js';
import type { StoredJevJob } from './runtime-queue.js';

export interface JevQueuedCandidate { workspaceId: string; job: StoredJevJob }
function age(left: JevQueuedCandidate, right: JevQueuedCandidate): number {
  return left.job.createdAt.localeCompare(right.job.createdAt);
}
const automationFingerprint = principalFingerprint(automationPrincipal);
function checkedChainFields(job: StoredJevJob): boolean {
  if (typeof job.followupKey !== 'string' || !job.followupKey.length || !Array.isArray(job.followupActions)) return false;
  return job.request.idempotencyKey === `${job.followupKey}:${job.request.action}`
    && job.followupActions.every(action => currentAction(action));
}
function automaticFollowup(job: StoredJevJob): boolean {
  return checkedChainFields(job) && job.authorizationFingerprint === automationFingerprint
    && principalFingerprint(job.principal) === automationFingerprint;
}
function priority(candidate: JevQueuedCandidate): number {
  const priorities: Partial<Record<StoredJevJob['request']['action'], number>> = { file: 0, label: 1, profile: 3 };
  const ordinary = priorities[candidate.job.request.action] ?? 5;
  return ordinary < 2 || !automaticFollowup(candidate.job) ? ordinary : 2;
}
/** Finish admitted chains before fresh understanding, reserving every seventh slot for ordinary background checks. */
export class JevJobScheduler {
  private organizationBurst = 0;
  peek(candidates: JevQueuedCandidate[]): JevQueuedCandidate | undefined {
    if (!candidates.length) return undefined;
    const manual = candidates.filter(candidate => candidate.job.principal.id !== automationPrincipal.id).sort(age);
    if (manual.length) return manual[0];
    const organization = candidates.filter(candidate => priority(candidate) < 5)
      .sort((left, right) => priority(left) - priority(right) || age(left, right));
    const background = candidates.filter(candidate => priority(candidate) === 5).sort(age);
    if (organization.length && (this.organizationBurst < 6 || !background.length)) {
      return organization[0];
    }
    return background[0];
  }

  select(candidates: JevQueuedCandidate[]): JevQueuedCandidate | undefined {
    const next = this.peek(candidates);
    if (!next || next.job.principal.id !== automationPrincipal.id) return next;
    this.organizationBurst = priority(next) < 5 ? this.organizationBurst + 1 : 0;
    return next;
  }
}
