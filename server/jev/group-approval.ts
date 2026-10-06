import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { JevPrincipal, JevProposal, JevReceipt, JevVocabularyTerm, JevWorkspaceState } from '../../shared/jev-types.js';
import { validGroupKey } from '../../shared/groups.js';
import type { CanvasStore } from '../storage.js';
import { ApiError } from '../errors.js';
import { atomicJson } from '../storage-files.js';
import { currentPrincipal, publicJevReceipt, requireApprove, requireTool, scopedState } from './authorization.js';
import { vocabularyGroupKey } from './actions/groups.js';
import type { JevRuntime } from './runtime.js';
import { JevProposalExecutor } from './proposals.js';
import { JevWorkspaceFiles } from './workspace.js';

export interface JevGroupApprovalInput { groupKey: string; proposalIds: string[] }
export interface JevGroupApprovalResult { groupKey: string; receipts: JevReceipt[]; approvedProposalIds: string[] }
const queues = new Map<string, Promise<unknown>>();
const inputSchema = z.strictObject({ groupKey: z.string().refine(validGroupKey), proposalIds: z.array(z.string().min(1).max(200)).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length) });
const progressSchema = z.strictObject({ groupKey: inputSchema.shape.groupKey, proposalIds: inputSchema.shape.proposalIds,
  approvedProposalIds: z.array(z.string().min(1).max(200)).max(100).refine(ids => new Set(ids).size === ids.length),
  state: z.enum(['running', 'completed', 'failed']), error: z.string().optional() });
type Progress = z.infer<typeof progressSchema>;

function validateInput(input: JevGroupApprovalInput): void {
  if (!inputSchema.safeParse(input).success) throw new ApiError(400, 'Select a native group and between 1 and 100 distinct group proposals');
}

function groupProposal(proposal: JevProposal, groupKey: string): boolean {
  const mutation = proposal.mutation;
  if (mutation.kind === 'document') return Object.keys(mutation.patch).length === 1 && mutation.patch.group === groupKey;
  if (mutation.kind !== 'vocabulary') return false;
  return vocabularyProposal(mutation, groupKey);
}

function vocabularyProposal(mutation: Extract<JevProposal['mutation'], { kind: 'vocabulary' }>, groupKey: string): boolean {
  if (mutation.term.kind !== 'group' || mutation.term.state !== 'active' || mutation.operation === 'remove') return false;
  const key = vocabularyGroupKey(mutation.term);
  return key === groupKey || groupKey.startsWith(`${key}/`);
}

function groupOrder(proposal: JevProposal): number {
  return proposal.mutation.kind === 'vocabulary' ? vocabularyGroupKey(proposal.mutation.term).split('/').length : 100;
}

function requireDistinctDocuments(proposals: JevProposal[]): void {
  const targets = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.mutation.kind !== 'document') continue;
    const key = `${proposal.mutation.canvasId}:${proposal.mutation.blockId}`;
    if (targets.has(key)) throw new ApiError(409, 'This group contains competing changes to the same document. Review them individually.');
    targets.add(key);
  }
}

async function readProgress(file: string): Promise<unknown> {
  let content: string;
  try { content = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try { return JSON.parse(content); }
  catch { throw new ApiError(503, 'Saved group approval requires recovery'); }
}

async function loadProgress(file: string, input: JevGroupApprovalInput, proposals: JevProposal[]): Promise<Progress> {
  const value = await readProgress(file);
  if (value === undefined) return { ...input, approvedProposalIds: [], state: 'running' };
  const parsed = progressSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(503, 'Saved group approval requires recovery');
  requireProgressIdentity(parsed.data, input);
  requireProgressReceipts(parsed.data, proposals);
  return parsed.data;
}

function requireProgressIdentity(progress: Progress, input: JevGroupApprovalInput): void {
  if (progress.groupKey !== input.groupKey || JSON.stringify(progress.proposalIds) !== JSON.stringify(input.proposalIds)) {
    throw new ApiError(503, 'Saved group approval requires recovery');
  }
}

function requireProgressReceipts(progress: Progress, proposals: JevProposal[]): void {
  const applied = new Set(proposals.filter(proposal => proposal.state === 'applied').map(proposal => proposal.id));
  if (progress.approvedProposalIds.some(id => !applied.has(id))) throw new ApiError(503, 'Saved group approval requires recovery');
  if (progress.state === 'completed' && progress.approvedProposalIds.length !== proposals.length) throw new ApiError(503, 'Saved group approval requires recovery');
}

function selectedProposals(state: JevWorkspaceState, input: JevGroupApprovalInput): JevProposal[] {
  return input.proposalIds.map(id => {
    const proposal = state.proposals.find(item => item.id === id);
    if (!proposal) throw new ApiError(404, 'Group proposal not found in this scope');
    if (!groupProposal(proposal, input.groupKey)) throw new ApiError(400, 'Approve all only includes this group’s definition and document memberships');
    return proposal;
  }).sort((left, right) => groupOrder(left) - groupOrder(right));
}

function requireApplied(state: JevWorkspaceState, proposal: JevProposal): void {
  const receipt = state.receipts.find(item => item.proposalId === proposal.id && item.state === 'applied');
  if (!receipt) {
    throw new ApiError(409, 'An earlier approval was undone. Review a fresh suggestion.');
  }
  if (receipt.id !== proposal.receiptId || !isDeepStrictEqual(receipt.after, proposal.mutation)) throw new ApiError(503, 'Saved group approval requires recovery');
}

function requireUnapplied(state: JevWorkspaceState, proposal: JevProposal): void {
  if (state.receipts.some(receipt => receipt.proposalId === proposal.id)) throw new ApiError(503, 'Saved group approval requires recovery');
}

function projectedVocabulary(vocabulary: JevVocabularyTerm[], proposal: JevProposal): JevVocabularyTerm[] {
  if (proposal.mutation.kind !== 'vocabulary') return vocabulary;
  const term = proposal.mutation.term;
  return [...vocabulary.filter(item => item.id !== term.id), term];
}

async function preflight(store: CanvasStore, workspaceId: string,
  input: JevGroupApprovalInput, principal: JevPrincipal): Promise<JevProposal[]> {
  const files = new JevWorkspaceFiles(store.root);
  const state = scopedState(await files.read(workspaceId), principal);
  if (state.settings.paused) throw new ApiError(409, 'Symbi Reflex is paused');
  const proposals = selectedProposals(state, input);
  requireDistinctDocuments(proposals);
  const executor = new JevProposalExecutor(store, files);
  let vocabulary = state.vocabulary;
  for (const proposal of proposals) {
    if (proposal.state === 'applied') {
      requireApplied(state, proposal);
    } else {
      requireUnapplied(state, proposal);
      await executor.precheckInside(workspaceId, proposal.id, principal, { vocabulary });
    }
    vocabulary = projectedVocabulary(vocabulary, proposal);
  }
  return proposals;
}

async function execute(store: CanvasStore, workspaceId: string,
  input: JevGroupApprovalInput, supplied: JevPrincipal): Promise<JevGroupApprovalResult> {
  const principal = await currentPrincipal(store, supplied); requireApprove(principal); requireTool(principal, ['jev_resolve']);
  const proposals = await preflight(store, workspaceId, input, principal);
  const id = createHash('sha256').update(JSON.stringify([workspaceId, input.groupKey, input.proposalIds])).digest('hex');
  const file = path.join(store.root, 'jev', 'workspaces', workspaceId, 'group-approvals', `${id}.json`);
  const progress = await loadProgress(file, input, proposals); progress.state = 'running'; delete progress.error;
  await atomicJson(file, progress, 0o600);
  const receipts: JevReceipt[] = [];
  const executor = new JevProposalExecutor(store, new JevWorkspaceFiles(store.root));
  try {
    for (const proposal of proposals) {
      const receipt = publicJevReceipt(await executor.applyInside(workspaceId, proposal.id, supplied)); receipts.push(receipt);
      progress.approvedProposalIds = [...new Set([...progress.approvedProposalIds, proposal.id])];
      await atomicJson(file, progress, 0o600);
    }
    progress.state = 'completed'; await atomicJson(file, progress, 0o600);
    return { groupKey: input.groupKey, receipts, approvedProposalIds: [...progress.approvedProposalIds] };
  } catch (error) {
    progress.state = 'failed'; progress.error = error instanceof ApiError ? error.message : 'Group approval requires recovery';
    await atomicJson(file, progress, 0o600);
    throw new ApiError(error instanceof ApiError ? error.status : 503,
      `${progress.approvedProposalIds.length} of ${input.proposalIds.length} group changes are saved. ${progress.error}`);
  }
}

/** One explicit group review; each canonical write retains its normal revision and authorization checks. */
export async function approveJevGroup(store: CanvasStore, runtime: JevRuntime, workspaceId: string,
  input: JevGroupApprovalInput, principal: JevPrincipal): Promise<JevGroupApprovalResult> {
  validateInput(input);
  await runtime.read(workspaceId, principal);
  const normalized = { groupKey: input.groupKey, proposalIds: [...input.proposalIds].sort() };
  const key = `${path.resolve(store.root)}:${workspaceId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const files = new JevWorkspaceFiles(store.root);
  const next = previous.then(() => files.serial(workspaceId, () => store.jevExecutor.serialized(async () => {
    await new JevProposalExecutor(store, files).recoverInside(workspaceId);
    return execute(store, workspaceId, normalized, principal);
  })));
  queues.set(key, next.then(() => undefined, () => undefined));
  return next;
}
