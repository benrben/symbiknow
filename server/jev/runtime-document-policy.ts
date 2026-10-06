import { automationPrincipal, principalFingerprint } from './authorization.js';
import type { StoredJevJob } from './runtime-queue.js';

export function documentOperation(job: StoredJevJob, enabled: boolean): boolean {
  if (!enabled || job.request.action !== 'profile') return false;
  if (job.request.blockIds?.length !== 1 || job.request.query !== undefined || job.request.options !== undefined) return false;
  return principalFingerprint(job.principal) === principalFingerprint(automationPrincipal);
}
