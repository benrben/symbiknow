import type { JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import { automationPrincipal, currentPrincipal } from './authorization.js';
import type { JevProposalExecutor } from './proposals.js';
import { checkFinishingPolicy } from './runtime-guards.js';
import type { StoredJevJob } from './runtime-queue.js';
import type { JevWorkspaceFiles } from './workspace.js';

export interface WorkspaceCompletion {
  workspaceId: string; store: CanvasStore; files: JevWorkspaceFiles; executor: JevProposalExecutor;
  state: JevWorkspaceState; current: StoredJevJob; job: StoredJevJob; signal: AbortSignal;
  principal: JevPrincipal; reason: (proposal: JevProposal) => string | undefined;
  /** A flushed document prefix leaves its root running until the whole operation is durable. */
  pendingDocumentRoot?: boolean;
  /** The first entry may supply the document's shared context guard for the canonical commit boundary. */
  validateContext?: () => Promise<void>;
}

function heldCanonical(proposal: JevProposal): boolean {
  return !['derived', 'vocabulary'].includes(proposal.mutation.kind) && proposal.state === 'dismissed'
    && typeof proposal.automaticHoldReason === 'string' && proposal.automaticHoldReason.trim().length > 0;
}
function workspaceOnly(proposals: JevProposal[]): boolean {
  return proposals.every(proposal => ['derived', 'vocabulary'].includes(proposal.mutation.kind) || heldCanonical(proposal));
}
function restoreObject(target: object, before: object): void {
  for (const key of Object.keys(target)) if (!Object.hasOwn(before, key)) Reflect.deleteProperty(target, key);
  Object.assign(target, before);
}
/** Workspace mutations replace profile values/vocabulary; history is append-only at this boundary. */
function rollbackWorkspace(input: WorkspaceCompletion, proposals: JevProposal[]): () => void {
  const { state, current } = input;
  const profiles = { ...state.profiles }; const vocabulary = state.vocabulary;
  const receipts = state.receipts.length; const prepared = state.prepared;
  const job = { ...current }; const snapshots = proposals.map(proposal => ({ proposal, before: { ...proposal } }));
  return () => {
    state.profiles = profiles; state.vocabulary = vocabulary; state.receipts.length = receipts; state.prepared = prepared;
    restoreObject(current, job);
    for (const { proposal, before } of snapshots) restoreObject(proposal, before);
  };
}
function heldProposal(input: WorkspaceCompletion, proposal: JevProposal, reason: string): void {
  proposal.automaticHoldReason = reason;
  if (input.job.principal.id === automationPrincipal.id) proposal.state = 'dismissed';
}
function rejectedProposal(input: WorkspaceCompletion, proposal: JevProposal, error: unknown): void {
  if (!(error instanceof ApiError) || ![400, 409].includes(error.status)) throw error;
  heldProposal(input, proposal, error.message);
  if (error.status === 409) proposal.state = 'stale';
  const failures = input.current.result?.automaticFailures;
  input.current.result = { ...input.current.result, automaticFailures: [...(Array.isArray(failures) ? failures : []),
    { proposalId: proposal.id, reason: error.message }] };
}
async function applyProposal(input: WorkspaceCompletion, proposal: JevProposal): Promise<void> {
  const reason = input.reason(proposal); const automatic = reason === undefined;
  if (proposal.mutation.kind !== 'derived' && reason !== undefined) { heldProposal(input, proposal, reason); return; }
  const rollback = rollbackWorkspace(input, [proposal]);
  try {
    await input.executor.applyWorkspaceInside(input.workspaceId, input.state, proposal.id,
      automatic ? input.principal : automationPrincipal, true);
  } catch (error) { rollback(); rejectedProposal(input, proposal, error); }
}

/** The caller owns and may discard this snapshot; staging never publishes a durable completion. */
export async function stageWorkspaceJob(input: WorkspaceCompletion): Promise<boolean> {
  const proposals = input.current.proposalIds.map(id => {
    const proposal = input.state.proposals.find(item => item.id === id);
    if (!proposal) throw new ApiError(404, 'Proposal not found');
    return proposal;
  });
  if (!workspaceOnly(proposals)) return false;
  const rollback = rollbackWorkspace(input, proposals);
  try {
    for (const proposal of proposals) {
      checkFinishingPolicy(input.state, input.current, input.job, await currentPrincipal(input.store, input.job.principal), input.signal);
      if (!heldCanonical(proposal)) await applyProposal(input, proposal);
    }
    checkFinishingPolicy(input.state, input.current, input.job, await currentPrincipal(input.store, input.job.principal), input.signal);
    input.current.state = 'completed'; input.current.updatedAt = new Date().toISOString();
    return true;
  } catch (error) { rollback(); throw error; }
}

/** Called under the workspace queue. A failed commit invalidates the caller's entire staged snapshot. */
export async function commitWorkspaceJobs(inputs: WorkspaceCompletion[]): Promise<void> {
  const first = inputs[0];
  if (!first || inputs.some(input => input.state !== first.state || input.store !== first.store || input.files !== first.files
    || input.workspaceId !== first.workspaceId || !input.state.jobs.includes(input.current)
    || !(input.current.state === 'completed' || (input.pendingDocumentRoot && input.current.state === 'running')))) {
    throw new ApiError(400, 'Workspace completion requires one owned staged snapshot');
  }
  await first.store.jevExecutor.serialized(async () => {
    await first.validateContext?.();
    for (const input of inputs) {
      checkFinishingPolicy(input.state, input.current, input.job, await currentPrincipal(input.store, input.job.principal), input.signal);
    }
    const sources = new Map(inputs.flatMap(input => input.job.sources.map(source => [JSON.stringify(source), source] as const)));
    await first.store.jevExecutor.checkSources([...sources.values()]);
    const principals = await Promise.all(inputs.map(input => currentPrincipal(input.store, input.job.principal)));
    await first.files.assertUnchanged(first.workspaceId, first.state);
    inputs.forEach((input, index) => checkFinishingPolicy(input.state, input.current, input.job, principals[index], input.signal));
    await first.files.write(first.workspaceId, first.state);
  });
}

/** Workspace-only effects have no external artifacts: their receipts and completion form one durable replacement. */
export async function finishWorkspaceJob(input: WorkspaceCompletion): Promise<boolean> {
  if (!input.current.proposalIds.length || !await stageWorkspaceJob(input)) return false;
  await commitWorkspaceJobs([input]);
  return true;
}
