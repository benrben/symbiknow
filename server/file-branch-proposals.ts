import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { CanvasBlock } from '../shared/types.js';
import type { FileUploadReceipt, WorkingCopyManifest } from '../shared/working-copy.js';
import type { UploadOperation } from './file-checkout-journal.js';
import { documentFilename, isHtmlDocument } from '../shared/file-transfer.js';
import { stateHash } from './chat-proposal-values.js';
import { lifetime, readState } from './chat-proposal-journal.js';
import { operationCommitted, readJournal } from './file-checkout-journal.js';
import { applyChatProposal, getChatProposal, undoChatProposal } from './chat-proposals.js';
import { ApiError } from './errors.js';
import { atomicJson } from './storage-files.js';
import { CanvasStore, contentHash } from './storage.js';
import { JevWorkspaceFiles } from './jev/workspace.js';
import { recordWebsiteReceipt, websiteRevision } from './website-package-history.js';
import { exportWebsite, packageHash, replaceWebsite, type WebsitePackage } from './website-working-copy.js';

type BranchSource = CanvasBlock & { revision: string; branch: string };
type BranchProposal = { version: 1; id: string; canvasId: string; checkout: WorkingCopyManifest;
  before: BranchSource; afterContent: string; afterTitle?: string; afterKind?: CanvasBlock['kind']; beforePackage?: WebsitePackage; afterPackage?: WebsitePackage;
  status: 'pending' | 'applied' | 'reverted'; expiresAt: string; receipt?: FileUploadReceipt; undoneRevision?: string };
function proposalPath(store: CanvasStore, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(400, 'Invalid file proposal ID');
  return path.join(store.root, 'file-branch-proposals', id + '.json');
}
async function branchProposal(store: CanvasStore, id: string) {
  const file = proposalPath(store, id);
  const proposal = await readJournal<BranchProposal>(file);
  if (proposal && !(Date.parse(proposal.expiresAt) > Date.now())) {
    await rm(file, { force: true });
    throw new ApiError(410, 'This file proposal expired; download and propose a fresh file');
  }
  return proposal;
}
function requirePrivateProposalMetadata(operation: UploadOperation, checkout: WorkingCopyManifest): void {
  if ((operation.input.title !== undefined && operation.input.title !== checkout.title) || (operation.input.kind !== undefined && operation.input.kind !== checkout.kind)) throw new ApiError(400, 'Private branch proposals preserve title and loader');
}
function proposalMetadata(operation: UploadOperation) {
  const input = operation.input;
  return { ...(input.title === undefined ? {} : { afterTitle: input.title }),
    ...(input.kind === undefined ? {} : { afterKind: input.kind === 'html' ? 'markdown' as const : input.kind }) };
}
function proposalReceiptDocument(before: BranchSource, operation: UploadOperation, content: string): CanvasBlock {
  const metadata = proposalMetadata(operation);
  return { ...before, content, kind: metadata.afterKind ?? before.kind, title: metadata.afterTitle ?? before.title };
}
function draftReceipt(before: BranchSource, operation: UploadOperation, checkout: WorkingCopyManifest, afterContent: string): FileUploadReceipt {
  const draft = proposalReceiptDocument(before, operation, afterContent);
  return { status: 'proposed', saved: false, baseRevision: checkout.baseRevision, operationId: operation.operationId, proposalId: operation.operationId, mode: 'propose', canvasId: checkout.canvasId, blockId: before.id,
    branch: checkout.branch, contentHash: contentHash(afterContent), revision: before.revision, kind: isHtmlDocument(draft.content) ? 'html' : draft.kind,
    filename: documentFilename(draft), title: draft.title, savedAt: new Date().toISOString() };
}
export async function proposeBranchFile(store: CanvasStore, operation: UploadOperation, checkout: WorkingCopyManifest,
  afterContent: string, afterPackage?: WebsitePackage): Promise<FileUploadReceipt> {
  const history = await store.documentHistory(checkout.canvasId, checkout.documentId);
  if (history.current !== checkout.branch) requirePrivateProposalMetadata(operation, checkout);
  const before = await store.readDocumentBranch(checkout.canvasId, checkout.documentId, checkout.branch);
  if (before.revision !== checkout.baseRevision) throw new ApiError(409, 'The proposal branch changed since download');
  const id = operation.operationId;
  const existing = await branchProposal(store, id);
  if (!existing) {
    const beforePackage = afterPackage ? await websiteRevision(store, before.id, before.revision, before.content) : undefined;
    await atomicJson(proposalPath(store, id), { version: 1, id, canvasId: checkout.canvasId, checkout, before, afterContent,
      ...proposalMetadata(operation),
      ...(afterPackage ? { beforePackage, afterPackage } : {}), status: 'pending', expiresAt: new Date(Date.now() + lifetime).toISOString() }, 0o600);
  }
  return draftReceipt(before, operation, checkout, afterContent);
}
function proposedDocument(proposal: BranchProposal): CanvasBlock {
  return { ...proposal.before, content: proposal.afterContent, contentHash: contentHash(proposal.afterContent),
    title: proposal.afterTitle ?? proposal.before.title, kind: proposal.afterKind ?? proposal.before.kind };
}
function publicProposal(proposal: BranchProposal) {
  const after = proposedDocument(proposal);
  const common = { id: proposal.id, canvasId: proposal.canvasId, branch: proposal.checkout.branch, status: proposal.status };
  if (proposal.status === 'applied') return { ...common, receipt: proposal.receipt, applied: [proposal.before.id], skipped: [],
    createdBlockIds: {}, documents: [{ id: proposal.before.id, before: proposal.before, after }] };
  if (proposal.status === 'reverted') return { ...common, reverted: [proposal.before.id], skipped: [] };
  return { ...common, expiresAt: proposal.expiresAt, changes: [{ id: proposal.before.id, blockId: proposal.before.id,
    type: 'edit' as const, title: after.title, before: proposal.before, after, canApply: true,
    expectedContentHash: proposal.checkout.baseContentHash, expectedStateHash: stateHash(proposal.before) }] };
}
export async function getFileProposal(store: CanvasStore, id: string) {
  const proposal = await branchProposal(store, id);
  return proposal ? publicProposal(proposal) : getChatProposal(store, id);
}
export async function fileProposalCanvas(store: CanvasStore, id: string): Promise<string> {
  const proposal = await branchProposal(store, id);
  if (proposal) return proposal.canvasId;
  const state = readState(store, id);
  return state.kind === 'pending' ? state.proposal.canvasId : state.canvasId;
}
/** Proposal guards and writes share the workspace-first order used by causal Undo and reconciliation. */
export async function withFileProposalWrite<T>(store: CanvasStore, id: string, work: () => Promise<T>): Promise<T> {
  const canvasId = await fileProposalCanvas(store, id);
  const canvas = await store.getCanvasSummary(canvasId);
  return new JevWorkspaceFiles(store.root).transaction(canvas.workspaceId, () => store.jevExecutor.serialized(work));
}
function guardProposalCurrent(proposal: BranchProposal, current: BranchSource, action: 'apply' | 'undo'): void {
  const expected = action === 'apply' ? proposal.checkout.baseRevision : proposal.receipt!.revision;
  if (current.incarnation !== proposal.checkout.incarnation || current.revision !== expected) throw new ApiError(409, 'The proposal branch changed; download and review it again');
  guardProposalMetadata(proposal, current, action);
}
function guardProposalMetadata(proposal: BranchProposal, current: BranchSource, action: 'apply' | 'undo'): void {
  const expected = action === 'apply' ? proposal.before : proposedDocument(proposal);
  if (current.kind !== expected.kind) throw new ApiError(409, 'The document loader changed since this file proposal');
  if (proposal.afterTitle !== undefined && current.title !== expected.title) throw new ApiError(409, 'The document title changed since this file proposal');
}
function proposalMetadataPatch(proposal: BranchProposal, action: 'apply' | 'undo') {
  const document = action === 'apply' ? proposedDocument(proposal) : proposal.before;
  return { ...(proposal.afterTitle === undefined ? {} : { title: document.title }),
    ...(proposal.afterKind === undefined ? {} : { kind: document.kind }) };
}
async function saveProposalSource(store: CanvasStore, proposal: BranchProposal, current: BranchSource, content: string, action: 'apply' | 'undo', actor: string) {
  const history = await store.documentHistory(proposal.canvasId, current.id);
  const patch = { content, expectedContentHash: current.contentHash, message: 'Review file proposal [upload:' + proposal.id + '-' + action + ']' };
  if (history.current === proposal.checkout.branch) {
    const saved = await store.updateBlock(proposal.canvasId, current.id, { ...patch, ...proposalMetadataPatch(proposal, action) }, actor);
    const after = await store.readDocumentBranch(proposal.canvasId, current.id, proposal.checkout.branch);
    return { ...saved, revision: after.revision, branch: after.branch };
  }
  return store.editDocumentBranch(proposal.canvasId, current.id, proposal.checkout.branch, patch, actor);
}
function branchReceipt(proposal: BranchProposal, saved: BranchSource, action: 'apply' | 'undo'): FileUploadReceipt {
  return { status: 'saved', saved: true, operationId: proposal.id + '-' + action, mode: 'propose', canvasId: proposal.canvasId, blockId: saved.id, branch: saved.branch,
    contentHash: saved.contentHash!, revision: saved.revision, kind: isHtmlDocument(saved.content) ? 'html' : saved.kind, filename: documentFilename(saved),
    title: saved.title, savedAt: new Date().toISOString(), proposalId: proposal.id };
}
function proposalDirection(proposal: BranchProposal, action: 'apply' | 'undo') {
  if (action === 'apply') return { content: proposal.afterContent, bundle: proposal.afterPackage, base: proposal.beforePackage };
  return { content: proposal.before.content, bundle: proposal.beforePackage, base: proposal.afterPackage };
}
function guardInterruptedSource(proposal: BranchProposal, current: BranchSource, content: string, action: 'apply' | 'undo') {
  if (current.content !== content || current.incarnation !== proposal.checkout.incarnation) throw new ApiError(409, 'The interrupted proposal source changed; review it again');
  guardProposalMetadata(proposal, current, action === 'apply' ? 'undo' : 'apply');
}
async function recoverProposalAssets(store: CanvasStore, proposal: BranchProposal, current: BranchSource, action: 'apply' | 'undo', actor: string) {
  const { content, bundle, base } = proposalDirection(proposal, action);
  guardInterruptedSource(proposal, current, content, action);
  const receipt = branchReceipt(proposal, current, action);
  if (!bundle) return receipt;
  const save = async () => { await recordWebsiteReceipt(store, receipt, bundle, actor); return receipt; };
  const history = await store.documentHistory(proposal.canvasId, current.id);
  if (history.current !== proposal.checkout.branch) return save();
  const actual = (await exportWebsite(store, current.content)).packageHash;
  if (actual !== packageHash(base!.files) && actual !== packageHash(bundle.files)) throw new ApiError(409, 'Website assets changed during proposal recovery');
  return replaceWebsite(store, current.content, bundle, actual, save, proposal.id + '-' + action);
}
async function saveBranchProposal(store: CanvasStore, proposal: BranchProposal, action: 'apply' | 'undo', actor: string) {
  const current = await store.readDocumentBranch(proposal.canvasId, proposal.before.id, proposal.checkout.branch);
  if (await operationCommitted(store, current.id, current.revision, proposal.id + '-' + action)) {
    const receipt = await recoverProposalAssets(store, proposal, current, action, actor);
    return finalizeBranchProposal(store, proposal, action, receipt);
  }
  guardProposalCurrent(proposal, current, action);
  const { content, bundle, base } = proposalDirection(proposal, action);
  const save = async () => {
    const saved = await saveProposalSource(store, proposal, current, content, action, actor);
    const receipt = branchReceipt(proposal, saved, action);
    if (bundle) await recordWebsiteReceipt(store, receipt, bundle, actor);
    return receipt;
  };
  const history = await store.documentHistory(proposal.canvasId, current.id);
  const receipt = bundle && history.current === proposal.checkout.branch
    ? await replaceWebsite(store, current.content, bundle, packageHash(base!.files), save, proposal.id + '-' + action) : await save();
  return finalizeBranchProposal(store, proposal, action, receipt);
}
async function finalizeBranchProposal(store: CanvasStore, proposal: BranchProposal, action: 'apply' | 'undo', receipt: FileUploadReceipt) {
  if (action === 'apply') proposal.receipt = receipt;
  else proposal.undoneRevision = receipt.revision;
  proposal.status = action === 'apply' ? 'applied' : 'reverted';
  proposal.expiresAt = new Date(Date.now() + lifetime).toISOString();
  await atomicJson(proposalPath(store, proposal.id), proposal, 0o600);
  return publicProposal(proposal);
}

export async function applyFileProposal(store: CanvasStore, id: string, changeIds?: string[], actor = 'file-reviewer'): Promise<unknown> {
  return withFileProposalWrite(store, id, async () => {
    const proposal = await branchProposal(store, id);
    if (!proposal) return applyChatProposal(store, id, changeIds, actor);
    if (changeIds && (changeIds.length !== 1 || changeIds[0] !== proposal.before.id)) throw new ApiError(400, 'Select the file proposal document');
    if (proposal.status !== 'pending') return publicProposal(proposal);
    return saveBranchProposal(store, proposal, 'apply', actor);
  });
}
export async function undoFileProposal(store: CanvasStore, id: string, actor = 'file-reviewer'): Promise<unknown> {
  return withFileProposalWrite(store, id, async () => {
    const proposal = await branchProposal(store, id);
    if (!proposal) return undoChatProposal(store, id, actor);
    if (proposal.status === 'reverted') return publicProposal(proposal);
    if (proposal.status !== 'applied') throw new ApiError(409, 'Apply this proposal before undoing it');
    return saveBranchProposal(store, proposal, 'undo', actor);
  });
}
