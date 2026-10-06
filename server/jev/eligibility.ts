import type { JevCurrentAction, JevMutation, JevOwnership, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import type { JevEvaluationContext } from './actions/context.js';
import { normalizedGroup } from '../../shared/groups.js';
import { automaticTaskHold } from './auto-task-policy.js';
import { hasCheckedAutomaticOutcome, explicitAutomaticCommand, automaticJobResult, automaticOperationHold } from './auto-outcomes.js';

type DocumentMutation = Extract<JevMutation, { kind: 'document' }>;
type VocabularyMutation = Extract<JevMutation, { kind: 'vocabulary' }>;

function actionHold(state: JevWorkspaceState, proposal: JevProposal): string | undefined {
  if (state.settings.calibratedActions && !state.settings.calibratedActions.includes(proposal.action)) return 'This action is outside the configured Auto allowlist';
  return undefined;
}
function policyHold(state: JevWorkspaceState, proposal: JevProposal): string | undefined {
  if (state.settings.paused) return 'Symbi Reflex is paused';
  if (!state.settings.externalProcessing) return 'External processing consent is required';
  if (state.settings.modes[proposal.action] !== 'auto') return 'This action is configured for review';
  return actionHold(state, proposal);
}
function evidenceHold(state: JevWorkspaceState, proposal: JevProposal): string | undefined {
  if (explicitAutomaticCommand(state, proposal)) return undefined;
  return proposal.evidence.length ? undefined : 'Exact supporting evidence is required';
}
function confidenceHold(state: JevWorkspaceState, proposal: JevProposal, supplied: number[]): string | undefined {
  const confidence = certificates(state, proposal, supplied);
  if (!confidence.length && hasCheckedAutomaticOutcome(state, proposal)) return undefined;
  if (!confidence.length || confidence.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return 'Valid supplied decision confidence is required';
  const threshold = confidenceThreshold(state, proposal);
  if (confidence.some(value => value < threshold)) return `Decision confidence is below the ${Math.round(threshold * 100)}% automatic threshold`;
  return undefined;
}
function confidenceThreshold(state: JevWorkspaceState, proposal: JevProposal): number {
  return state.settings.confidenceThresholds?.[proposal.action as JevCurrentAction] ?? 0.7;
}
function certificates(state: JevWorkspaceState, proposal: JevProposal, supplied: number[]): number[] {
  const values = [...supplied];
  if (proposal.confidence !== undefined) values.push(proposal.confidence);
  if (values.length || proposal.action !== 'vocab_lifecycle') return values;
  const outcome = automaticJobResult(state, proposal).confidence;
  return typeof outcome === 'number' ? [outcome] : values;
}
function pinnedField(ownership: JevOwnership, field: string): boolean {
  return ownership.pins.includes(field) || (field === 'links' && ownership.pins.includes('linkTypes'));
}
function fieldsHold(ownership: JevOwnership, mutation: DocumentMutation): string | undefined {
  const fields = Object.keys(mutation.patch).map(field => field === 'linkTypes' ? 'links' : field);
  if (fields.some(field => pinnedField(ownership, field) || !ownership.managed.includes(field))) return 'A field is pinned or managed manually';
  if (mutation.patch.tags?.some(label => ownership.removedLabels.includes(label))) return 'A removed label correction prevents this change';
  if (mutation.patch.links?.some(link => ownership.removedLinks.includes(link))
    || mutation.patch.crossLinks?.some(link => ownership.removedLinks.includes(`${link.canvasId}:${link.blockId}`))) return 'A removed connection correction prevents this change';
  return undefined;
}
function pendingDefinition(state: JevWorkspaceState, proposal: JevProposal, group: string): boolean {
  return state.proposals.some(candidate => candidate.jobId === proposal.jobId && candidate.state === 'pending'
    && candidate.mutation.kind === 'vocabulary' && normalizedGroup(candidate.mutation.term.groupKey) === normalizedGroup(group));
}
function activeGroup(state: JevWorkspaceState, group: string): boolean {
  return state.vocabulary.some(term => term.kind === 'group' && term.state === 'active' && normalizedGroup(term.groupKey) === normalizedGroup(group));
}
function bootstrapFiling(proposal: JevProposal): boolean {
  return proposal.action === 'file' && proposal.confidence === undefined && Boolean(proposal.decisionConfidences?.length);
}
function groupHold(state: JevWorkspaceState, proposal: JevProposal, mutation: DocumentMutation, context: JevEvaluationContext): string | undefined {
  if (!mutation.patch.group) return undefined;
  if (pendingDefinition(state, proposal, mutation.patch.group)) return 'The supported group definition must be applied before filing';
  if (requiresDefinedGroup(proposal) && !recognizedGroup(state, mutation.patch.group, context)) return 'The supported group definition must be active before filing';
  return undefined;
}
function requiresDefinedGroup(proposal: JevProposal): boolean { return proposal.action === 'vocab_lifecycle' || bootstrapFiling(proposal); }
function recognizedGroup(state: JevWorkspaceState, group: string, context: JevEvaluationContext): boolean {
  return activeGroup(state, group) || context.documents.some(document => normalizedGroup(document.block.group) === normalizedGroup(group));
}
function documentHold(state: JevWorkspaceState, proposal: JevProposal, mutation: DocumentMutation, context: JevEvaluationContext): string | undefined {
  if (Object.hasOwn(mutation.patch, 'processingExcluded')) return 'Processing exclusions require explicit review';
  const document = context.documents.find(item => item.canvasId === mutation.canvasId && item.block.id === mutation.blockId);
  if (!document?.block.jevOwnership) return 'The document needs organization ownership reconciliation';
  return fieldsHold(document.block.jevOwnership, mutation) ?? groupHold(state, proposal, mutation, context);
}
function automaticDefinition(proposal: JevProposal, mutation: VocabularyMutation): boolean {
  return proposal.action === 'file' && ['define', 'promote'].includes(mutation.operation) && mutation.term.kind === 'group'
    && mutation.term.state === 'active' && Boolean(mutation.term.groupKey);
}
function parentHold(state: JevWorkspaceState, mutation: VocabularyMutation): string | undefined {
  if (!mutation.term.parentId) return undefined;
  const active = state.vocabulary.some(term => term.id === mutation.term.parentId && term.kind === 'group' && term.state === 'active');
  return active ? undefined : 'The supported parent group must be active first';
}
function memberHold(proposal: JevProposal, member: VocabularyMutation['term']['members'][number], context: JevEvaluationContext): string | undefined {
  const document = context.documents.find(item => item.canvasId === member.canvasId && item.block.id === member.blockId);
  if (!document || !document.block.jevOwnership?.managed.includes('group') || document.block.jevOwnership.pins.includes('group')) return 'A member’s group is pinned or managed manually';
  if (!proposal.evidence.some(evidence => evidence.source.canvasId === member.canvasId && evidence.source.blockId === member.blockId)) return 'Each group member requires exact supporting evidence';
  return undefined;
}
function vocabularyHold(state: JevWorkspaceState, proposal: JevProposal, mutation: VocabularyMutation, context: JevEvaluationContext): string | undefined {
  if (proposal.action === 'vocab_lifecycle') return vocabularyLifecycleHold(state, proposal, mutation, context);
  if (!automaticDefinition(proposal, mutation)) return 'A new group requires a supported definition';
  if (!mutation.term.members.length) return 'A new group requires reviewed source members';
  const parent = parentHold(state, mutation);
  if (parent) return parent;
  return groupMembersHold(proposal, mutation, context);
}
function groupMembersHold(proposal: JevProposal, mutation: VocabularyMutation, context: JevEvaluationContext): string | undefined {
  for (const member of mutation.term.members) {
    const held = memberHold(proposal, member, context);
    if (held) return held;
  }
  return undefined;
}
function vocabularyLifecycleHold(state: JevWorkspaceState, proposal: JevProposal, mutation: VocabularyMutation, context: JevEvaluationContext): string | undefined {
  if (mutation.operation === 'remove') return 'Removing a vocabulary term requires checked reference removal';
  const result = automaticJobResult(state, proposal);
  if (mutation.operation === 'merge' && result.synonymySupported !== true) return 'The vocabulary merge lacks supported matching meanings';
  const parent = parentHold(state, mutation);
  if (parent) return parent;
  return lifecycleMembersHold(mutation, context);
}
function lifecycleMembersHold(mutation: VocabularyMutation, context: JevEvaluationContext): string | undefined {
  for (const member of mutation.term.members) {
    if (lifecycleMemberCorrection(mutation, member, context)) return 'A vocabulary member has a manual classification correction';
  }
  return undefined;
}
function lifecycleMemberCorrection(mutation: VocabularyMutation, member: VocabularyMutation['term']['members'][number], context: JevEvaluationContext): boolean {
  const document = context.documents.find(item => item.canvasId === member.canvasId && item.block.id === member.blockId);
  if (!document) return true;
  if (mutation.term.kind === 'entity') return false;
  const field = mutation.term.kind === 'label' ? 'tags' : 'group';
  return Boolean(document.block.jevOwnership?.pins.includes(field));
}
function moveHold(proposal: JevProposal, context: JevEvaluationContext): string | undefined {
  if (proposal.mutation.kind !== 'move' || proposal.action !== 'suggest_home_canvas') return 'A move requires a supported home-canvas decision';
  const target = proposal.mutation.targetCanvasId;
  if (target === proposal.mutation.canvasId) return 'A move requires a different supported destination';
  return context.canvases.some(canvas => canvas.id === target) ? undefined : 'The destination must be inside the authorized canvas scope';
}
function mutationHold(state: JevWorkspaceState, proposal: JevProposal, context: JevEvaluationContext): string | undefined {
  if (proposal.mutation.kind === 'derived') return 'Derived results are saved through the analysis path';
  if (proposal.mutation.kind === 'vocabulary') return vocabularyHold(state, proposal, proposal.mutation, context);
  if (proposal.mutation.kind === 'document') return documentHold(state, proposal, proposal.mutation, context);
  if (proposal.mutation.kind === 'content') return 'Automatic source editing has no supported action';
  if (proposal.mutation.kind === 'move') return moveHold(proposal, context);
  return automaticTaskHold(state, proposal, context);
}
/** Every supplied independent certificate is checked, without manufacturing a joint probability. */
export function automaticHoldReason(state: JevWorkspaceState, proposal: JevProposal, context: JevEvaluationContext,
  confidence: number[] = proposal.decisionConfidences ?? []): string | undefined {
  return policyHold(state, proposal) ?? automaticOperationHold(state, proposal) ?? evidenceHold(state, proposal)
    ?? confidenceHold(state, proposal, confidence) ?? mutationHold(state, proposal, context);
}
export function eligibleAutomatic(state: JevWorkspaceState, proposal: JevProposal, context: JevEvaluationContext,
  confidence?: number[]): boolean { return automaticHoldReason(state, proposal, context, confidence) === undefined; }
