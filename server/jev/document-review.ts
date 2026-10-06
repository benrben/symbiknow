import type { CanvasBlock } from '../../shared/types.js';
import type { JevJob, JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { groupPath, validGroupKey } from '../../shared/groups.js';
import { documentActions, type DocumentJob } from './runtime-document.js';
import { documentProgresses } from './runtime-progress.js';
import { vocabularyGroupKey } from './actions/groups.js';

function finiteScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function documentValues(job: JevJob | undefined, blockId: string): Record<string, unknown> | undefined {
  return objectValue(objectValue(job?.result?.documents)?.[blockId]);
}
function scores(job: JevJob | undefined, blockId: string, proposals: JevProposal[]): Array<{ name: string; value: number }> {
  const values: Array<{ name: string; value: number }> = [];
  const record = documentValues(job, blockId);
  for (const [name, value] of [['role', record?.roleConfidence], ['key passage', record?.keyPassageSelectionConfidence]] as const) {
    const score = finiteScore(value); if (score !== undefined) values.push({ name, value: score });
  }
  for (const proposal of proposals.slice(0, 8)) {
    (proposal.decisionConfidences ?? []).slice(0, 8).forEach((value, index) => {
      const score = finiteScore(value);
      if (score !== undefined) values.push({ name: proposals.length === 1 ? `decision ${index + 1}`
        : `${proposal.title.slice(0, 64)} · decision ${index + 1}`, value: score });
    });
  }
  return values.slice(0, 24);
}
function currentSource(source: JevProposal['sources'][number], canvasId: string, blockId: string, hash: string): boolean {
  return source.canvasId === canvasId && source.blockId === blockId && source.contentHash === hash;
}
function currentGroupEvidence(proposal: JevProposal, canvasId: string, blockId: string, hash: string): boolean {
  return proposal.sources.some(source => currentSource(source, canvasId, blockId, hash))
    && proposal.evidence.some(passage => currentSource(passage.source, canvasId, blockId, hash) && passage.quote.length > 0);
}
function groupProposal(proposal: JevProposal, canvasId: string, blockId: string, contentHash: string): proposal is JevProposal &
  { mutation: { kind: 'document'; canvasId: string; blockId: string; patch: { group: string } } } {
  return proposal.mutation.kind === 'document' && proposal.mutation.canvasId === canvasId && proposal.mutation.blockId === blockId
    && Object.keys(proposal.mutation.patch).length === 1 && validGroupKey(proposal.mutation.patch.group)
    && currentGroupEvidence(proposal, canvasId, blockId, contentHash);
}
function relatedProposalIds(state: JevWorkspaceState, membership: JevProposal & { mutation: { patch: { group: string } } }): string[] {
  const path = new Set(groupPath(membership.mutation.patch.group));
  const definitions = state.proposals.filter(proposal => proposal.jobId === membership.jobId && proposal.mutation.kind === 'vocabulary'
    && proposal.mutation.term.kind === 'group' && proposal.mutation.term.state === 'active'
    && path.has(vocabularyGroupKey(proposal.mutation.term)) && ['pending', 'applied'].includes(proposal.state));
  return [...definitions.map(proposal => proposal.id), membership.id].slice(0, 9);
}
type DocumentProgress = ReturnType<typeof documentProgresses>[number];
function plannedActionJob(jobMap: Map<string, JevJob>, progress: DocumentProgress | undefined,
  action: typeof documentActions[number]): JevJob | undefined {
  if (!progress) return undefined;
  const root = jobMap.get(progress.jobId) as DocumentJob | undefined;
  return jobMap.get(action === 'profile' ? progress.jobId : `${progress.jobId}:${action}`)
    ?? (root?.documentPlan?.activeJob?.request.action === action ? root.documentPlan.activeJob : undefined);
}
function selectedActionJob(state: JevWorkspaceState, jobMap: Map<string, JevJob>, progress: DocumentProgress | undefined,
  action: typeof documentActions[number], canvasId: string, block: CanvasBlock): JevJob | undefined {
  const planned = plannedActionJob(jobMap, progress, action);
  if (planned) return planned;
  return state.jobs.filter(job => job.request.action === action && job.request.canvasId === canvasId
    && job.sources.some(source => source.blockId === block.id && source.contentHash === block.contentHash))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}
function actionRole(job: JevJob | undefined, blockId: string): string | undefined {
  const role = documentValues(job, blockId)?.role;
  return typeof role === 'string' ? role : undefined;
}
function groupApprovalAllowed(proposal: JevProposal, principal: JevPrincipal): boolean {
  return proposal.state === 'pending' && !proposal.automaticHoldReason && principal.kind === 'user'
    && principal.access === 'write' && Boolean(principal.canApprove);
}
function currentDecisionProposals(proposals: JevProposal[], canvasId: string, block: CanvasBlock): JevProposal[] {
  return proposals.filter(proposal => proposal.sources.some(source => source.canvasId === canvasId
    && source.blockId === block.id && source.contentHash === block.contentHash));
}
function actionState(progress: DocumentProgress['actions'][number] | undefined, selected: JevJob | undefined): string {
  if (progress) return progress.state;
  if (selected?.state === 'failed') return 'failed';
  return selected?.state === 'completed' ? 'no_change' : 'waiting';
}
function reviewAction(state: JevWorkspaceState, jobMap: Map<string, JevJob>, proposalsByJob: Map<string, JevProposal[]>,
  progress: DocumentProgress | undefined, action: typeof documentActions[number], canvasId: string, block: CanvasBlock) {
  const selected = selectedActionJob(state, jobMap, progress, action, canvasId, block);
  const actionProgress = progress?.actions.find(item => item.action === action);
  const role = actionRole(selected, block.id);
  return { action, state: actionState(actionProgress, selected),
    ...(actionProgress?.reason ? { reason: actionProgress.reason } : {}),
    ...(selected ? { decisionId: selected.id } : {}),
    ...(role !== undefined ? { role } : {}), scores: scores(selected, block.id,
      currentDecisionProposals(selected ? proposalsByJob.get(selected.id) ?? [] : [], canvasId, block)) };
}
function reviewGrouping(state: JevWorkspaceState, principal: JevPrincipal, canvasId: string, block: CanvasBlock) {
  const groups = state.proposals.filter(proposal => groupProposal(proposal, canvasId, block.id, block.contentHash!))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const selected = groups.find(proposal => proposal.state === 'pending') ?? groups[0];
  if (!selected) return undefined;
  return { groupKey: selected.mutation.patch.group, proposalId: selected.id,
    proposalIds: relatedProposalIds(state, selected), confidence: selected.confidence,
    scores: (selected.decisionConfidences ?? []).filter(score => finiteScore(score) !== undefined).slice(0, 8),
    evidence: selected.evidence.filter(passage => passage.source.canvasId === canvasId && passage.source.blockId === block.id
      && passage.source.contentHash === block.contentHash)
      .slice(0, 4).map(passage => ({ quote: passage.quote.slice(0, 512), start: passage.start, end: passage.end })),
    status: groupStatus(selected),
    ...(selected.automaticHoldReason ? { reason: selected.automaticHoldReason } : {}),
    canApprove: groupApprovalAllowed(selected, principal) };
}
function groupStatus(proposal: JevProposal): string {
  return proposal.state === 'pending' && proposal.automaticHoldReason ? 'held' : proposal.state;
}

function latestProgress(state: JevWorkspaceState, canvasId: string, block: CanvasBlock): DocumentProgress | undefined {
  return documentProgresses(state).filter(item => item.canvasId === canvasId && item.blockId === block.id
    && item.contentHash === block.contentHash).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}
function proposalsByJob(state: JevWorkspaceState): Map<string, JevProposal[]> {
  const grouped = new Map<string, JevProposal[]>();
  for (const proposal of state.proposals) {
    const list = grouped.get(proposal.jobId) ?? []; list.push(proposal); grouped.set(proposal.jobId, list);
  }
  return grouped;
}

/** Bounded, source-scoped review data for one document; no provider work occurs here. */
export function documentReview(state: JevWorkspaceState, principal: JevPrincipal,
  canvasId: string, block: CanvasBlock) {
  const progress = latestProgress(state, canvasId, block);
  const jobMap = new Map(state.jobs.map(job => [job.id, job]));
  const grouped = proposalsByJob(state);
  const actions = documentActions.map(action => reviewAction(state, jobMap, grouped, progress, action, canvasId, block));
  const grouping = reviewGrouping(state, principal, canvasId, block);
  return { canvasId, blockId: block.id, contentHash: block.contentHash, currentGroup: block.group ?? null,
    ...(progress ? { jobId: progress.jobId } : {}), durable: progress?.durable ?? false, actions,
    ...(grouping ? { grouping } : {}) };
}
