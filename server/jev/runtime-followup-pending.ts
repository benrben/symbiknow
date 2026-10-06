import type { JevJob, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';

type FollowupJob = JevJob & { followupActions?: string[]; followupSources?: JevSourceSnapshot[] };
const sourceIdentity: Array<keyof JevSourceSnapshot> = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'];

function selectsSource(job: FollowupJob, source: JevSourceSnapshot): boolean {
  if (job.request.canvasId !== source.canvasId) return false;
  const ids = job.request.blockIds;
  return !ids?.length || ids.includes(source.blockId);
}
function pendingFollowup(job: FollowupJob): boolean {
  return Array.isArray(job.followupActions) && ['queued', 'running'].includes(job.state);
}
/** Context-only snapshots, old source incarnations, and completed chains cannot suppress fresh organization. */
export function hasPendingSourceFollowup(state: JevWorkspaceState, source: JevSourceSnapshot): boolean {
  return (state.jobs as FollowupJob[]).some(job => pendingFollowup(job) && selectsSource(job, source)
    && (job.followupSources ?? job.sources).some(original => sourceIdentity.every(field => original[field] === source[field])));
}
export function hasPendingCanvasFollowup(state: JevWorkspaceState, canvasId: string): boolean {
  return (state.jobs as FollowupJob[]).some(job => pendingFollowup(job) && job.request.canvasId === canvasId);
}
