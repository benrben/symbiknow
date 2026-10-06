import type { JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';

export function automaticJobResult(state: JevWorkspaceState, proposal: JevProposal): Record<string, unknown> {
  return state.jobs.find(job => job.id === proposal.jobId)?.result ?? {};
}
export function automaticRequestOptions(state: JevWorkspaceState, proposal: JevProposal): Record<string, unknown> {
  return state.jobs.find(job => job.id === proposal.jobId)?.request.options ?? {};
}
/** Checked connection reviews and explicit vocabulary commands can supply their own outcome certificate. */
export function hasCheckedAutomaticOutcome(state: JevWorkspaceState, proposal: JevProposal): boolean {
  const result = automaticJobResult(state, proposal);
  if (proposal.action === 'recheck_links') return Array.isArray(result.edges);
  return explicitAutomaticCommand(state, proposal);
}
export function explicitAutomaticCommand(state: JevWorkspaceState, proposal: JevProposal): boolean {
  const options = automaticRequestOptions(state, proposal);
  if (proposal.action !== 'vocab_lifecycle') return false;
  return ['promote', 'rename', 'alias', 'retire', 'restore', 'merge', 'split'].includes(String(options.operation));
}
export function automaticOperationHold(state: JevWorkspaceState, proposal: JevProposal): string | undefined {
  if (proposal.action !== 'vocab_lifecycle') return undefined;
  if (automaticRequestOptions(state, proposal).operation !== 'merge') return undefined;
  return automaticJobResult(state, proposal).synonymySupported === true ? undefined : 'The vocabulary merge lacks supported matching meanings';
}
