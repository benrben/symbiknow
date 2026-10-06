import { automationPrincipal } from './authorization.js';
import type { JevQueuedCandidate } from './runtime-scheduler.js';

const sourceLocalActions = new Set(['profile', 'label']);

function validSelectedSources(candidate: JevQueuedCandidate, ids: string[]): boolean {
  const { job, workspaceId } = candidate;
  return job.sources.every(source => source.workspaceId === workspaceId && source.canvasId === job.request.canvasId
    && ids.includes(source.blockId)) && ids.every(id => job.sources.some(source => source.blockId === id));
}
function sourceLocal(candidate: JevQueuedCandidate): boolean {
  const { job } = candidate;
  if (job.principal.kind !== automationPrincipal.kind || job.principal.id !== automationPrincipal.id
    || !sourceLocalActions.has(job.request.action)) return false;
  const ids = job.request.blockIds;
  if (!ids?.length || !job.sources?.length) return false;
  return validSelectedSources(candidate, ids);
}
function disjointSources(left: JevQueuedCandidate, right: JevQueuedCandidate): boolean {
  const selected = new Set(left.job.sources.map(source => `${source.canvasId}:${source.blockId}`));
  return right.job.sources.every(source => !selected.has(`${source.canvasId}:${source.blockId}`));
}
/** Only disjoint, explicitly selected automatic source work may overlap within a workspace. */
export function canRunJevCandidate(candidate: JevQueuedCandidate, active: JevQueuedCandidate[]): boolean {
  const sameWorkspace = active.filter(current => current.workspaceId === candidate.workspaceId);
  if (!sameWorkspace.length) return true;
  if (!sourceLocal(candidate)) return false;
  return sameWorkspace.every(current => sourceLocal(current) && disjointSources(candidate, current));
}
