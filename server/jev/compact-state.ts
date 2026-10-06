import type { JevJob, JevMutation, JevProposal, JevReceipt, JevValues, JevWorkspaceState } from '../../shared/jev-types.js';
import type { DocumentJob } from './runtime-document.js';

function savedOutcome(job: JevJob): JevValues | undefined {
  const retained = job.result?.progressOutcome;
  return retained && typeof retained === 'object' && !Array.isArray(retained) ? retained as JevValues : undefined;
}
function noChangeReason(job: JevJob, candidates: JevProposal[]): string {
  const reason = typeof job.result?.reason === 'string' ? job.result.reason
    : candidates.find(candidate => candidate.automaticHoldReason)?.automaticHoldReason;
  return reason ?? String(job.result?.status ?? 'No supported change');
}
function compactOutcome(job: JevJob, proposals: Map<string, JevProposal>): JevValues {
  const retained = savedOutcome(job);
  if (retained) return retained;
  if (job.state === 'failed') return { state: 'failed', reason: job.error ?? 'Decision failed' };
  if (job.state !== 'completed') return { state: 'waiting' };
  const candidates = job.proposalIds.map(id => proposals.get(id)).filter((item): item is JevProposal => Boolean(item));
  if (candidates.some(candidate => candidate.state === 'applied')) return { state: 'changed' };
  return { state: 'no_change', reason: noChangeReason(job, candidates) };
}
export function compactJob(job: JevJob, proposals: Map<string, JevProposal>): JevJob {
  const plan = (job as DocumentJob).documentPlan;
  const safePlan = plan ? { ...plan, originalSources: plan.originalSources.slice(0, 1) } : undefined;
  if (safePlan) { delete safePlan.activeJob; delete safePlan.contextProof; }
  return { ...job, result: { status: job.result?.status ?? null, progressOutcome: compactOutcome(job, proposals) },
    sources: [], proposalIds: [], ...(safePlan ? { documentPlan: safePlan } : {}) } as JevJob;
}
function compactProfile(profile: JevValues): JevValues {
  return { role: profile.role, keyPassages: Array.isArray(profile.keyPassages) ? profile.keyPassages.slice(0, 1) : [] };
}
function canvasMutation(mutation: JevMutation): boolean {
  return ['document', 'content', 'move', 'vocabulary'].includes(mutation.kind);
}
function compactMutation(mutation: JevMutation): JevMutation {
  if (mutation.kind === 'document') return { ...mutation, patch: {} };
  if (mutation.kind === 'content') return { ...mutation, content: '' };
  return mutation;
}
function compactReceipt(receipt: JevReceipt): JevReceipt {
  return { ...receipt, before: compactMutation(receipt.before), after: compactMutation(receipt.after) };
}
/** Poll progress without retransmitting the same analysis in jobs, proposals and historical receipts. */
export function compactJevState(state: JevWorkspaceState): JevWorkspaceState {
  const proposals = new Map(state.proposals.map(proposal => [proposal.id, proposal]));
  return { ...state, jobs: state.jobs.filter(job => !(job.state === 'cancelled'
    && job.error === 'Superseded by a newer source revision')).map(job => compactJob(job, proposals)),
    profiles: Object.fromEntries(Object.entries(state.profiles).map(([key, value]) => [key, compactProfile(value)])),
    proposals: [], receipts: state.receipts.filter(receipt => canvasMutation(receipt.after)).map(compactReceipt) };
}
