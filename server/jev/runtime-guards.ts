import type { JevActionRequest, JevEvaluation, JevPassage, JevMutation, JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import type { JevEvaluationContext } from './actions/context.js';
import { ApiError } from '../errors.js';
import { mutationCanvases, principalFingerprint, requireCanvas } from './authorization.js';
import { sameJevSource } from './stamps.js';
import { requireCurrentMutation, validateMutation } from './mutations.js';

export function processingPolicyKey(state: JevWorkspaceState): string { return JSON.stringify(state.settings); }
type ProcessingJob = { settingsKey: string; authorizationFingerprint: string };

export function checkFinishingPolicy(state: JevWorkspaceState, current: { state: string }, job: ProcessingJob,
  principal: JevPrincipal, signal: AbortSignal): void {
  const cancelled = signal.aborted || current.state === 'cancelled';
  const policyChanged = state.settings.paused || processingPolicyKey(state) !== job.settingsKey;
  if (cancelled || policyChanged || principalFingerprint(principal) !== job.authorizationFingerprint) throw new ApiError(409, 'The action was cancelled or its policy changed');
}

function documentTarget(mutation: JevMutation): mutation is Extract<JevMutation, { kind: 'document' | 'move' | 'content' }> {
  return mutation.kind === 'document' || mutation.kind === 'move' || mutation.kind === 'content';
}
function checkedTargets(proposal: JevProposal): void {
  const mutation = proposal.mutation;
  if (documentTarget(mutation) && !proposal.sources.some(source => source.canvasId === mutation.canvasId && source.blockId === mutation.blockId)) throw new ApiError(502, 'Mutation target is not a reviewed source');
  if (mutation.kind !== 'vocabulary') return;
  if (mutation.term.members.some(member => !proposal.sources.some(source => source.canvasId === member.canvasId && source.blockId === member.blockId))) throw new ApiError(502, 'Vocabulary members are not reviewed sources');
}
function validRange(evidence: JevPassage, content: string): boolean {
  const bounds = [evidence.start, evidence.end];
  if (!bounds.every(Number.isSafeInteger)) return false;
  if (evidence.start < 0 || evidence.end > content.length || evidence.end <= evidence.start) return false;
  return content.slice(evidence.start, evidence.end) === evidence.quote;
}
function checkedEvidence(evidence: JevPassage, proposal: JevProposal, context: JevEvaluationContext): void {
  if (!proposal.sources.some(source => sameJevSource(source, evidence.source))) throw new ApiError(502, 'Evidence is not included in the reviewed source guards');
  const document = context.documents.find(item => sameJevSource(item.snapshot, evidence.source));
  if (!document || !validRange(evidence, document.block.content)) throw new ApiError(502, 'Decision evidence does not match its source');
}
function checkedProposal(proposal: JevProposal, context: JevEvaluationContext, request: JevActionRequest, principal: JevPrincipal): void {
  if (proposal.action !== request.action) throw new ApiError(502, 'Unexpected decision action');
  requireCurrentMutation(proposal.mutation);
  validateMutation(proposal.mutation);
  for (const id of mutationCanvases(proposal.mutation)) requireCanvas(principal, id);
  for (const source of proposal.sources) {
    if (!context.documents.some(document => sameJevSource(document.snapshot, source))) throw new ApiError(502, 'Unknown decision source');
  }
  checkedTargets(proposal);
  for (const evidence of proposal.evidence) checkedEvidence(evidence, proposal, context);
}
export function validateJevEvaluation(evaluation: JevEvaluation, context: JevEvaluationContext, request: JevActionRequest, principal: JevPrincipal): void {
  if (!evaluation || !Array.isArray(evaluation.proposals) || evaluation.proposals.length > 100) throw new ApiError(502, 'Invalid decision result');
  for (const proposal of evaluation.proposals) checkedProposal(proposal as JevProposal, context, request, principal);
}
