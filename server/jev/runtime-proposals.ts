import { randomUUID } from 'node:crypto';
import type { JevEvaluation, JevJob, JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import type { JevEvaluationContext } from './actions/context.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import { proposalKey } from './proposals.js';
import { sameJevSource } from './stamps.js';
import { actionConfidenceThreshold } from './automatic-policy.js';

type Candidate = JevEvaluation['proposals'][number];
function sameSources(left: JevSourceSnapshot[], right: JevSourceSnapshot[]): boolean {
  return left.length === right.length && left.every((source, index) => sameJevSource(source, right[index]));
}
function match(candidate: Candidate, proposal: JevProposal, state: JevProposal['state']): boolean {
  return proposal.state === state && proposalKey(proposal) === proposalKey(candidate) && sameSources(proposal.sources, candidate.sources);
}
function scopedCandidate(candidate: Candidate, context: JevEvaluationContext, job: JevJob): void {
  if (candidate.mutation.kind !== 'derived') return;
  candidate.mutation.values.scopedCanvasIds = context.canvases.map(canvas => canvas.id);
  candidate.mutation.values.scopedSources = JSON.parse(JSON.stringify(context.documents.map(document => document.snapshot)));
  candidate.mutation.values.questionVersion = JEV_QUESTION_VERSION;
  if (candidate.action === 'profile') {
    candidate.mutation.values.profileConfidenceThreshold = actionConfidenceThreshold(context.settings, 'profile');
    candidate.mutation.values.profileEvaluationId = job.id;
  }
}
function rememberProposal(job: JevJob, id: string): void {
  if (!job.proposalIds.includes(id)) job.proposalIds.push(id);
}
function appliedCandidate(state: JevWorkspaceState, job: JevJob, candidate: Candidate): JevProposal | undefined {
  return state.proposals.find(item => item.jobId === job.id && match(candidate, item, 'applied'));
}
function supersedeCandidates(state: JevWorkspaceState, candidate: Candidate): void {
  const key = proposalKey(candidate);
  for (const proposal of state.proposals.filter(item => item.state === 'pending' && proposalKey(item) === key)) {
    if (!sameSources(proposal.sources, candidate.sources)) proposal.state = 'stale';
  }
}
function sameHeadlineTarget(left: Candidate, right: JevProposal): boolean {
  if (left.action !== 'set_headline' || right.action !== 'set_headline') return false;
  if (left.mutation.kind !== 'document' || right.mutation.kind !== 'document') return false;
  return left.mutation.canvasId === right.mutation.canvasId && left.mutation.blockId === right.mutation.blockId;
}
function decisionTime(state: JevWorkspaceState, proposal: JevProposal): string {
  return state.jobs.find(job => job.id === proposal.jobId)?.createdAt ?? proposal.createdAt;
}
function newerHeadline(state: JevWorkspaceState, job: Pick<JevJob, 'createdAt'>, candidate: Candidate): boolean {
  return state.proposals.some(proposal => sameHeadlineTarget(candidate, proposal)
    && decisionTime(state, proposal) > job.createdAt && sameSources(proposal.sources, candidate.sources));
}
function invalidLegacyHeadline(proposal: JevProposal): boolean {
  if (proposal.mutation.kind !== 'document') return false;
  const headline = proposal.mutation.patch.headline;
  return typeof headline === 'string' && headline.length > 80;
}
/** Repair older review ledgers using saved decisions, without repeating inference. */
export function reconcileHeadlineSuggestions(state: JevWorkspaceState): boolean {
  let changed = false;
  const pending = state.proposals.filter(proposal => proposal.state === 'pending'
    && proposal.action === 'set_headline' && !proposal.reviewerEdited);
  for (const proposal of pending) {
    if (invalidLegacyHeadline(proposal) || newerHeadline(state, { createdAt: decisionTime(state, proposal) }, proposal)) {
      proposal.state = 'stale'; changed = true;
    }
  }
  return changed;
}
function replaceableHeadline(state: JevWorkspaceState, job: JevJob, candidate: Candidate, proposal: JevProposal): boolean {
  if (proposal.state !== 'pending' || proposal.reviewerEdited || proposal.jobId === job.id) return false;
  return sameHeadlineTarget(candidate, proposal) && decisionTime(state, proposal) <= job.createdAt;
}
function supersedeHeadlines(state: JevWorkspaceState, job: JevJob, candidate: Candidate): void {
  for (const proposal of state.proposals) {
    if (replaceableHeadline(state, job, candidate, proposal) && !match(candidate, proposal, 'pending')) proposal.state = 'stale';
  }
}
function recordCandidate(state: JevWorkspaceState, job: JevJob, candidate: Candidate, context: JevEvaluationContext): void {
  scopedCandidate(candidate, context, job);
  if (newerHeadline(state, job, candidate)) return;
  supersedeHeadlines(state, job, candidate);
  if (state.suppressions.includes(proposalKey(candidate))) return;
  if (state.proposals.some(item => match(candidate, item, 'dismissed'))) return;
  const applied = appliedCandidate(state, job, candidate);
  if (applied) { rememberProposal(job, applied.id); return; }
  supersedeCandidates(state, candidate);
  upsertCandidate(state, job, candidate);
}
function pendingCandidate(state: JevWorkspaceState, candidate: Candidate): JevProposal | undefined {
  const matches = state.proposals.filter(item => match(candidate, item, 'pending'));
  for (const duplicate of matches.slice(1)) duplicate.state = 'stale';
  return matches[0];
}
function upsertCandidate(state: JevWorkspaceState, job: JevJob, candidate: Candidate): void {
  const existing = pendingCandidate(state, candidate);
  const proposal = existing ?? { ...candidate, id: randomUUID(), jobId: job.id, state: 'pending' as const, createdAt: new Date().toISOString() };
  if (existing) Object.assign(existing, candidate, { jobId: job.id, automaticHoldReason: undefined });
  if (!existing) state.proposals.push(proposal);
  rememberProposal(job, proposal.id);
}

export function recordJevCandidates(state: JevWorkspaceState, job: JevJob, evaluation: JevEvaluation, context: JevEvaluationContext): void {
  if (state.settings.modes[job.request.action] === 'shadow') return;
  for (const candidate of evaluation.proposals) recordCandidate(state, job, candidate, context);
}
