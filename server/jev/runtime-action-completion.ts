import type { JevEvaluation, JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import type { JevEvaluationContext } from './actions/context.js';
import { automationPrincipal, currentPrincipal } from './authorization.js';
import { automaticHoldReason } from './eligibility.js';
import type { JevProposalExecutor } from './proposals.js';
import { checkFinishingPolicy, validateJevEvaluation } from './runtime-guards.js';
import { recordJevCandidates } from './runtime-proposals.js';
import type { StoredJevJob } from './runtime-queue.js';
import { finishWorkspaceJob } from './runtime-workspace-completion.js';
import type { JevWorkspaceFiles } from './workspace.js';

export function automaticReason(state: JevWorkspaceState, proposal: JevProposal, context: JevEvaluationContext, mayApprove: boolean): string | undefined {
  if (!mayApprove) return 'An agent cannot approve its own proposal';
  if (!context.apiKey?.trim()) return 'A configured processing provider is required';
  return automaticHoldReason(state, proposal, context);
}
function mayAutomaticallyApprove(job: StoredJevJob, principal: JevPrincipal): boolean {
  return job.principal.id === automationPrincipal.id || (principal.kind === 'user' && principal.canApprove === true);
}

interface AutomaticCompletion {
  workspaceId: string; id: string; job: StoredJevJob; principal: JevPrincipal; context: JevEvaluationContext;
  files: JevWorkspaceFiles; executor: JevProposalExecutor;
}
export async function commitJevAutomatic(input: AutomaticCompletion): Promise<void> {
  const { workspaceId, id, job, principal, context, files, executor } = input;
  const state = await files.read(workspaceId);
  const proposal = state.proposals.find(item => item.id === id)!;
  const derived = proposal.mutation.kind === 'derived';
  const mayApprove = mayAutomaticallyApprove(job, principal);
  const auto = !automaticReason(state, proposal, context, mayApprove);
  if (derived || auto) { await executor.applyInside(workspaceId, id, auto ? principal : automationPrincipal, true); return; }
  proposal.automaticHoldReason = automaticReason(state, proposal, context, mayApprove);
  if (job.principal.id === automationPrincipal.id) proposal.state = 'dismissed';
  await files.write(workspaceId, state);
}

async function automaticFailure(files: JevWorkspaceFiles, workspaceId: string, proposalId: string, jobId: string, error: unknown): Promise<void> {
  if (!(error instanceof ApiError) || ![400, 409].includes(error.status)) throw error;
  const state = await files.read(workspaceId);
  const proposal = state.proposals.find(item => item.id === proposalId)!;
  const job = state.jobs.find(item => item.id === jobId) as StoredJevJob;
  proposal.automaticHoldReason = error.message;
  if (job.principal.id === automationPrincipal.id) proposal.state = 'dismissed';
  if (error.status === 409) proposal.state = 'stale';
  const failures = job.result?.automaticFailures;
  job.result = { ...job.result, automaticFailures: [...(Array.isArray(failures) ? failures : []), { proposalId, reason: error.message }] };
  await files.write(workspaceId, state);
}

interface ActionCompletion {
  workspaceId: string; job: StoredJevJob; evaluated: JevEvaluation; context: JevEvaluationContext; signal: AbortSignal;
  store: CanvasStore; files: JevWorkspaceFiles; executor: JevProposalExecutor;
  commitAutomatic: (id: string, principal: JevPrincipal) => Promise<void>;
}

/** Retained per-action completion keeps its checked proposals, journaled effects, and result writes in order. */
export async function finishJevAction(input: ActionCompletion): Promise<void> {
  const { workspaceId, job, evaluated, context, signal, store, files, executor } = input;
  await files.serial(workspaceId, async () => {
    const state = await files.read(workspaceId);
    const current = state.jobs.find(item => item.id === job.id)!;
    const principal = await currentPrincipal(store, job.principal);
    checkFinishingPolicy(state, current, job, principal, signal);
    await store.jevExecutor.checkSources(job.sources);
    validateJevEvaluation(evaluated, context, job.request, principal);
    current.result = evaluated.result;
    recordJevCandidates(state, current, evaluated, context);
    if (await finishWorkspaceJob({ workspaceId, store, files, executor, state, current: current as StoredJevJob,
      job, principal, signal, reason: proposal => automaticReason(state, proposal, context, mayAutomaticallyApprove(job, principal)) })) return;
    if (!current.proposalIds.length) {
      checkFinishingPolicy(state, current, job, await currentPrincipal(store, job.principal), signal);
      current.state = 'completed'; current.updatedAt = new Date().toISOString();
      await files.write(workspaceId, state);
      return;
    }
    await files.write(workspaceId, state);
    for (const id of [...current.proposalIds]) {
      try { await input.commitAutomatic(id, principal); }
      catch (error) { await automaticFailure(files, workspaceId, id, job.id, error); }
    }
    const settled = await files.read(workspaceId);
    const finished = settled.jobs.find(item => item.id === job.id)!;
    checkFinishingPolicy(settled, finished, job, await currentPrincipal(store, job.principal), signal);
    finished.state = 'completed'; finished.updatedAt = new Date().toISOString();
    await files.write(workspaceId, settled);
  });
}
