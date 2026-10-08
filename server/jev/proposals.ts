import { createHash, randomUUID } from 'node:crypto';
import type { JevMutation, JevOwnership, JevPrincipal, JevProposal, JevReceipt, JevSourceSnapshot, JevVocabularyTerm, JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import type { JevArtifact, JevCanonicalPreparation } from '../storage-jev-executor.js';
import { ApiError } from '../errors.js';
import { currentPrincipal, mutationCanvases, requireApprove, requireCanvas, requireTool } from './authorization.js';
import { JevWorkspaceFiles } from './workspace.js';
import { sourceSnapshot } from './stamps.js';
import { trustedManagedOrigin } from './approval-origin.js';
import { validateMutation } from './mutations.js';
import { checkVocabularyMutation } from './vocabulary.js';
import { authorizeReceipt, checkReceiptState, checkReceiptInverse, inverseOwnership, inverseSources, versionInverse } from './proposal-inverse.js';
import { stateMutation, checkVocabularyMembers, checkVocabularyReferences } from './proposal-state.js';

export type StoredJevReceipt = JevReceipt & { ownershipBefore?: JevOwnership; ownershipAfter?: JevOwnership; preparedArtifacts?: JevArtifact[] };
export type PreparedJevMutation = JevWorkspaceState['prepared'][number] & { actor?: string; automatic?: boolean; artifacts?: JevArtifact[]; ownershipBefore?: JevOwnership; undoReceiptId?: string };

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)]));
}
function semanticMutation(mutation: JevMutation): JevMutation {
  if (mutation.kind !== 'task_create') return mutation;
  const task = { ...mutation.task };
  for (const field of ['id', 'createdAt', 'updatedAt', 'revision', 'jevMutationId'] as const) delete task[field];
  if (task.findingRef) task.findingRef = { ...task.findingRef, references: [] };
  return { ...mutation, task };
}
export function proposalKey(proposal: Pick<JevProposal, 'action' | 'mutation'>): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue([proposal.action, semanticMutation(proposal.mutation)]))).digest('hex');
}

export function suppressProposal(state: JevWorkspaceState, proposal: JevProposal): void {
  const key = proposalKey(proposal);
  if (!state.suppressions.includes(key)) state.suppressions.push(key);
}

function findProposal(state: JevWorkspaceState, id: string): JevProposal {
  const proposal = state.proposals.find(item => item.id === id);
  if (!proposal) throw new ApiError(404, 'Proposal not found');
  return proposal;
}
function checkProposal(state: JevWorkspaceState, proposal: JevProposal, principal: JevPrincipal, undo = false): void {
  if (proposal.state !== 'pending') throw new ApiError(409, 'Proposal is no longer pending');
  if (state.settings.paused) throw new ApiError(409, 'Symbi Reflex is paused');
  validateMutation(proposal.mutation, undo);
  for (const id of [...mutationCanvases(proposal.mutation), ...proposal.sources.map(source => source.canvasId)]) requireCanvas(principal, id);
}
function checkApprover(principal: JevPrincipal, automatic: boolean): void {
  if (automatic) return;
  requireApprove(principal); requireTool(principal, ['jev_resolve', 'jev_undo', 'set_metadata']);
}
function checkSelfApproval(state: JevWorkspaceState, proposal: JevProposal, principal: JevPrincipal): void {
  const job = state.jobs.find(item => item.id === proposal.jobId) as { principal?: JevPrincipal } | undefined;
  if (principal.kind === 'token' && job?.principal?.id === principal.id && !principal.canApprove) throw new ApiError(403, 'Approval permission is required');
}
function checkPlannedVocabulary(state: JevWorkspaceState, proposal: JevProposal, vocabulary?: JevVocabularyTerm[]): void {
  if (proposal.mutation.kind === 'vocabulary') checkVocabularyMutation(vocabulary ?? state.vocabulary, proposal.mutation);
}
function workspaceMutation(mutation: JevMutation): boolean { return mutation.kind === 'derived' || mutation.kind === 'vocabulary'; }
function inverseArtifacts(state: JevWorkspaceState, receiptId: string | undefined): JevArtifact[] | undefined {
  return (state.receipts.find(receipt => receipt.id === receiptId) as StoredJevReceipt | undefined)?.preparedArtifacts;
}
function checkPreparedRecovery(state: JevWorkspaceState, record: PreparedJevMutation): asserts record is PreparedJevMutation & { artifacts: JevArtifact[] } {
  if (!record.artifacts) throw new ApiError(503, 'Symbi Reflex recovery metadata is incomplete');
  if (record.undoReceiptId && !state.receipts.some(receipt => receipt.id === record.undoReceiptId)) throw new ApiError(503, 'Symbi Reflex Undo recovery requires its original receipt');
}
function recordReceipt(state: JevWorkspaceState, proposal: JevProposal, receipt: JevReceipt, undoReceiptId?: string): JevReceipt {
  const savedProposal = state.proposals.find(item => item.id === proposal.id) ?? proposal;
  savedProposal.state = 'applied';
  savedProposal.receiptId = receipt.id;
  state.receipts.push(receipt);
  state.prepared = state.prepared.filter(item => item.id !== receipt.id);
  if (undoReceiptId) {
    const parent = state.receipts.find(item => item.id === undoReceiptId)!;
    parent.state = 'undone';
  }
  return receipt;
}

export class JevProposalExecutor {
  constructor(private readonly store: CanvasStore, private readonly files: JevWorkspaceFiles) {}

  /** The caller owns the workspace queue and persists this state with its checked job completion. */
  async applyWorkspaceInside(workspaceId: string, state: JevWorkspaceState, proposalId: string, supplied: JevPrincipal,
    automatic = false, recordAutomatic = automatic): Promise<JevReceipt> {
    const principal = await currentPrincipal(this.store, supplied);
    checkApprover(principal, automatic);
    const proposal = findProposal(state, proposalId);
    if (!proposal.mutation || !workspaceMutation(proposal.mutation)) throw new ApiError(400, 'This transaction requires a workspace-only mutation');
    const prior = state.receipts.find(item => item.proposalId === proposalId);
    if (prior) return prior;
    checkProposal(state, proposal, principal);
    checkSelfApproval(state, proposal, principal);
    await this.store.jevExecutor.checkSources(proposal.sources);
    const id = randomUUID();
    return this.store.jevExecutor.serialized(async () => recordReceipt(state, proposal,
      await this.workspaceReceipt(workspaceId, state, proposal, principal, id, recordAutomatic)));
  }

  private async workspaceReceipt(workspaceId: string, state: JevWorkspaceState, proposal: JevProposal,
    principal: JevPrincipal, id: string, automatic: boolean): Promise<JevReceipt> {
    await this.store.jevExecutor.checkSources(proposal.sources);
    await checkVocabularyReferences(this.store, proposal.mutation);
    await checkVocabularyMembers(this.store, workspaceId, proposal.mutation);
    const before = stateMutation(state, proposal);
    return { id, proposalId: proposal.id, action: proposal.action, createdAt: new Date().toISOString(), actor: principal.id,
      before, after: proposal.mutation, sourcesAfter: proposal.sources, state: 'applied', automatic };
  }

  async precheckInside(workspaceId: string, proposalId: string, supplied: JevPrincipal,
    options: { vocabulary?: JevVocabularyTerm[] } = {}): Promise<JevProposal> {
    const principal = await currentPrincipal(this.store, supplied);
    checkApprover(principal, false);
    const state = await this.files.read(workspaceId);
    const proposal = findProposal(state, proposalId);
    if (state.receipts.some(receipt => receipt.proposalId === proposalId && receipt.state === 'applied')) return proposal;
    checkProposal(state, proposal, principal);
    checkPlannedVocabulary(state, proposal, options.vocabulary);
    await checkVocabularyReferences(this.store, proposal.mutation);
    await checkVocabularyMembers(this.store, workspaceId, proposal.mutation);
    await this.store.jevExecutor.checkSources(proposal.sources);
    return structuredClone(proposal);
  }

  async applyInside(workspaceId: string, proposalId: string, supplied: JevPrincipal, automatic = false,
    restoreOwnership?: JevOwnership, undoReceiptId?: string, recordAutomatic = automatic,
    validateContext?: () => Promise<void>): Promise<JevReceipt> {
    const principal = await currentPrincipal(this.store, supplied);
    checkApprover(principal, automatic);
    const state = await this.files.read(workspaceId);
    const proposal = findProposal(state, proposalId);
    const prior = state.receipts.find(item => item.proposalId === proposalId);
    if (prior) return prior;
    checkProposal(state, proposal, principal, Boolean(undoReceiptId));
    checkSelfApproval(state, proposal, principal);
    await this.store.jevExecutor.checkSources(proposal.sources);
    const id = randomUUID();
    if (workspaceMutation(proposal.mutation)) {
      return this.store.jevExecutor.serialized(async () => {
        const receipt = await this.workspaceReceipt(workspaceId, state, proposal, principal, id, recordAutomatic);
        return this.commit(workspaceId, state, proposal, receipt, undoReceiptId);
      });
    }
    const result = await this.store.jevExecutor.execute(proposal.mutation, proposal.sources, id, principal.id, automatic || trustedManagedOrigin(proposal),
      async (plan: JevCanonicalPreparation) => {
        await validateContext?.();
        state.prepared.push({ id, proposal, before: plan.before, after: plan.after, actor: principal.id,
          automatic: recordAutomatic, artifacts: plan.artifacts, ownershipBefore: plan.ownershipBefore, undoReceiptId } as PreparedJevMutation);
        await this.files.write(workspaceId, state);
      }, restoreOwnership, Boolean(undoReceiptId), inverseArtifacts(state, undoReceiptId));
    const receipt: StoredJevReceipt = { id, proposalId, action: proposal.action, createdAt: new Date().toISOString(), actor: principal.id,
      before: result.before, after: result.after, sourcesAfter: result.sourcesAfter, state: 'applied', automatic: recordAutomatic,
      ownershipBefore: result.ownershipBefore, preparedArtifacts: result.artifacts };
    return this.commit(workspaceId, state, proposal, receipt, undoReceiptId);
  }

  private async commit(workspaceId: string, state: JevWorkspaceState, proposal: JevProposal, receipt: JevReceipt,
    undoReceiptId?: string): Promise<JevReceipt> {
    recordReceipt(state, proposal, receipt, undoReceiptId);
    await this.files.write(workspaceId, state);
    return receipt;
  }

  async undoInside(workspaceId: string, receiptId: string, principal: JevPrincipal): Promise<JevReceipt> {
    principal = await currentPrincipal(this.store, principal);
    requireApprove(principal); requireTool(principal, ['jev_resolve', 'jev_undo']);
    const state = await this.files.read(workspaceId);
    const receipt = state.receipts.find(item => item.id === receiptId) as StoredJevReceipt | undefined;
    if (!receipt) throw new ApiError(404, 'Receipt not found');
    authorizeReceipt(receipt, principal);
    checkReceiptState(state, receipt);
    if (receipt.state === 'undone') return receipt;
    await checkReceiptInverse(this.store, receipt);
    let restoredOwnership = receipt.ownershipBefore;
    if (receipt.after.kind === 'document') {
      const mutation = receipt.after;
      const block = (await this.store.getCanvas(mutation.canvasId, true)).blocks.find(item => item.id === mutation.blockId)!;
      restoredOwnership = inverseOwnership(block.jevOwnership, receipt.ownershipBefore, mutation);
    }
    const sources = await inverseSources(this.store, workspaceId, receipt);
    const proposal: JevProposal = { id: randomUUID(), jobId: `undo:${receipt.id}`, action: receipt.action,
      title: 'Undo organization', explanation: 'Checked inverse preserves intervening changes', evidence: [],
      sources, mutation: structuredClone(receipt.before), state: 'pending', createdAt: new Date().toISOString() };
    versionInverse(state, proposal.mutation);
    state.proposals.push(proposal);
    await this.files.write(workspaceId, state);
    return this.applyInside(workspaceId, proposal.id, principal, false, restoredOwnership, receiptId);
  }

  private async recoveredSources(workspaceId: string, record: PreparedJevMutation): Promise<JevSourceSnapshot[]> {
    const sources: JevSourceSnapshot[] = [];
    for (const source of record.proposal.sources) {
      const canvasId = record.after.kind === 'move' && record.after.blockId === source.blockId ? record.after.targetCanvasId : source.canvasId;
      const block = (await this.store.getCanvas(canvasId, true)).blocks.find(item => item.id === source.blockId);
      if (block) sources.push(sourceSnapshot(workspaceId, canvasId, block));
    }
    return sources;
  }

  async recoverInside(workspaceId: string): Promise<void> {
    const state = await this.files.read(workspaceId);
    for (const record of [...state.prepared] as PreparedJevMutation[]) {
      checkPreparedRecovery(state, record);
      await this.store.jevExecutor.recover(record.artifacts);
      const sourcesAfter = await this.recoveredSources(workspaceId, record);
      await this.commit(workspaceId, state, record.proposal, { id: record.id, proposalId: record.proposal.id,
        action: record.proposal.action, actor: record.actor ?? 'workspace-automation', createdAt: new Date().toISOString(),
        before: record.before, after: record.after, sourcesAfter, state: 'applied', automatic: record.automatic,
        preparedArtifacts: record.artifacts, ownershipBefore: record.ownershipBefore } as StoredJevReceipt, record.undoReceiptId);
      await this.store.jevExecutor.recovered(record.after, record.actor ?? 'Symbi Reflex');
    }
  }
}
