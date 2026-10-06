import type { CanvasBlock, CanvasDocument } from '../../shared/types.js';
import type { JevJob, JevOwnership, JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import { validId } from '../storage-shapes.js';
import { ApiError } from '../errors.js';
import { updatedBlock } from '../storage-validation.js';
import { canvasAllowed, requireApprove } from './authorization.js';
import { changedJevStamp } from './stamps.js';
import { setJevDraftState, type JevDraft } from './drafts.js';
import type { StoredJevJob } from './runtime-queue.js';

const ownershipFields = ['linkTypes', 'workArea'];
const ownerFields = ['group', 'tags', 'headline', 'freshness', 'links', 'crossLinks', 'purpose', 'reviewer', 'quality', 'stale', 'archived', 'processingExcluded'];
export function pendingJob(job: JevJob): boolean { return ['queued', 'running'].includes(job.state); }
export function cancelJevJob(job: JevJob, running: Map<string, AbortController>): void {
  job.state = 'cancelled'; job.updatedAt = new Date().toISOString(); running.get(job.id)?.abort('cancelled');
}
export function checkJobCancellation(job: StoredJevJob | undefined, principal: JevPrincipal): asserts job is StoredJevJob {
  if (!job || !canvasAllowed(principal, job.request.canvasId)) throw new ApiError(404, 'Job not found');
  if (principal.kind === 'token' && job.principal.id !== principal.id) throw new ApiError(403, 'Only the initiating agent can cancel this job');
}
export async function stopJobDraft(store: CanvasStore, job: JevJob, state: 'cancelled' | 'review_unavailable'): Promise<void> {
  if (job.request.action !== 'review_agent_edit' || !job.request.blockIds?.length) return;
  if (typeof job.request.options?.draftId !== 'string') return;
  await setJevDraftState(store.root, job.request.canvasId, job.request.blockIds[0], job.request.options.draftId,
    state, Number(job.request.options.draftGeneration));
}
export function checkDraftCancellation(draft: JevDraft | null, id: string, principal: JevPrincipal): asserts draft is JevDraft {
  if (!draft || draft.id !== id) throw new ApiError(404, 'Draft not found');
  if (draft.state === 'applied') throw new ApiError(409, 'An applied draft must use checked Undo');
  if (principal.kind === 'user') requireApprove(principal);
  else if (draft.actor !== principal.id) throw new ApiError(403, 'Only the initiating agent can cancel this draft');
}
function belongsToDraft(proposal: JevProposal, id: string): boolean {
  return proposal.state === 'pending' && proposal.mutation.kind === 'content' && proposal.mutation.draftId === id;
}
export function cancelDraftWork(state: JevWorkspaceState, id: string, running: Map<string, AbortController>): void {
  for (const proposal of state.proposals.filter(item => belongsToDraft(item, id))) proposal.state = 'dismissed';
  for (const job of state.jobs.filter(item => item.request.options?.draftId === id && pendingJob(item))) cancelJevJob(job, running);
}
function validOwnershipField(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if ([...ownerFields, ...ownershipFields].includes(value)) return true;
  const parts = value.split(':');
  return parts.length === 3 && parts[0] === 'link' && parts.slice(1).every(validId);
}
export function validateMetadataOverride(patch: Record<string, unknown>): void {
  if (!patch || Object.keys(patch).some(field => ![...ownerFields, 'pins', 'managed'].includes(field))) throw new ApiError(400, 'Invalid metadata override');
  const lists = [patch.pins, patch.managed].filter(value => value !== undefined);
  if (lists.some(value => !Array.isArray(value) || value.some(field => !validOwnershipField(field)))) throw new ApiError(400, 'Invalid managed metadata fields');
  validateMetadataOwnership(patch);
}
function validateMetadataOwnership(patch: Record<string, unknown>): void {
  if (Array.isArray(patch.pins) && Array.isArray(patch.managed) && patch.pins.some(field => (patch.managed as unknown[]).includes(field))) throw new ApiError(400, 'Pinned fields cannot also be managed');
}
function reviewedMetadata(previous: CanvasBlock, fields: Record<string, unknown>, blocks: CanvasBlock[]): CanvasBlock {
  const validated = { ...fields };
  if (fields.tags === null) validated.tags = [];
  if (fields.crossLinks === null) validated.crossLinks = [];
  if (fields.quality === null) delete validated.quality;
  const reviewed = updatedBlock(previous, validated, blocks);
  if (fields.quality === null) delete reviewed.quality;
  return reviewed;
}
export function metadataOwnership(canvas: CanvasDocument, blockId: string, patch: Record<string, unknown>): JevOwnership {
  const { pins, managed, ...fields } = patch;
  const previous = canvas.blocks.find(block => block.id === blockId);
  if (!previous) throw new ApiError(404, 'Document not found');
  const ownership = changedJevStamp(previous, reviewedMetadata(previous, fields, canvas.blocks)).jevOwnership!;
  if (pins) { ownership.pins = [...new Set(pins as string[])]; ownership.managed = ownership.managed.filter(field => !ownership.pins.includes(field)); }
  if (managed) { ownership.managed = [...new Set(managed as string[])]; ownership.pins = ownership.pins.filter(field => !ownership.managed.includes(field)); }
  return ownership;
}
