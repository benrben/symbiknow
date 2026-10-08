import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { ApiError, CanvasStore, contentHash } from './storage.js';
import type { AppliedState, ChatProposal, ChatProposalChange, ChatProposalReceipt } from './chat-proposal-types.js';
import { lifetime, proposalFile, readState, saveState } from './chat-proposal-journal.js';
import { stateHash } from './chat-proposal-values.js';
import { documentReviewState } from '../shared/document-state.js';
import { preflightCausalParentUndo, withCausalParentUndo, type JevParentUndo } from './jev/parent-undo.js';
import { initializeJevStamp } from './jev/stamps.js';

export type { ChatProposal, ChatProposalChange, ChatProposalReceipt } from './chat-proposal-types.js';

const proposalActor = new AsyncLocalStorage<string>();
// Only reached inside applyChatProposal/undoChatProposal, which always run with an actor (default 'Symbi').
function reviewActor(): string { return proposalActor.getStore()!; }
const busy = new Set<string>();
function clone(block: CanvasBlock): CanvasBlock { return structuredClone(block); }
function cloneOrNull(block: CanvasBlock | null): CanvasBlock | null { return block ? clone(block) : null; }
function expectedHashes(before: CanvasBlock | null): Pick<ChatProposalChange, 'expectedContentHash' | 'expectedStateHash'> {
  if (!before) return { expectedContentHash: null, expectedStateHash: null };
  return { expectedContentHash: contentHash(before.content), expectedStateHash: stateHash(before) };
}
function recordedType(before: CanvasBlock | null, after: CanvasBlock | null, previous: ChatProposalChange | undefined,
  type: ChatProposalChange['type']): ChatProposalChange['type'] {
  if (!before) return 'create';
  if (!after) return 'delete';
  if (previous?.type === 'delete') return 'edit';
  return type;
}

export class ChatProposalDraft {
  private readonly original: Map<string, CanvasBlock>;
  private readonly projected: Map<string, CanvasBlock>;
  private readonly changed = new Map<string, ChatProposalChange>();
  private published: ChatProposal | null = null;
  constructor(private readonly store: CanvasStore, readonly canvasId: string, canvas: CanvasDocument) {
    this.original = new Map(canvas.blocks.map(block => [block.id, clone(block)]));
    this.projected = new Map(canvas.blocks.map(block => [block.id, clone(block)]));
  }
  get(blockId: string): CanvasBlock {
    const block = this.projected.get(blockId);
    if (!block) throw new ApiError(404, 'Document not found');
    return clone(block);
  }
  private record(blockId: string, type: ChatProposalChange['type']): void {
    const before = this.original.get(blockId) ?? null;
    const after = this.projected.get(blockId) ?? null;
    if (!before && !after) { this.changed.delete(blockId); return; }
    this.changed.set(blockId, { id: blockId, type: recordedType(before, after, this.changed.get(blockId), type),
      blockId, title: (after ?? before!).title, before: cloneOrNull(before), after: cloneOrNull(after),
      ...expectedHashes(before), canApply: Boolean(after) });
  }
  create(input: { title: string; content: string; kind?: CanvasBlock['kind']; x?: number; y?: number }): CanvasBlock {
    const id = randomUUID();
    const block: CanvasBlock = { id, title: input.title, content: input.content, kind: input.kind ?? 'markdown',
      file: `docs/${id}.md`, x: input.x ?? 100, y: input.y ?? 100, width: 400, height: 320, links: [], contentHash: contentHash(input.content) };
    this.projected.set(id, block); this.record(id, 'create'); return clone(block);
  }
  patch(blockId: string, patch: Partial<CanvasBlock>, type: ChatProposalChange['type']): CanvasBlock {
    const block = this.get(blockId);
    const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<CanvasBlock>;
    const after = { ...block, ...definedPatch, contentHash: contentHash(definedPatch.content ?? block.content) };
    this.projected.set(blockId, after); this.record(blockId, type); return clone(after);
  }
  delete(blockId: string): void { this.get(blockId); this.projected.delete(blockId); this.record(blockId, 'delete'); }
  publish(requestedId?: string, includeUnchanged = false): ChatProposal | null {
    if (this.published) return this.published;
    const changes = [...this.changed.values()].filter(change => includeUnchanged || JSON.stringify(change.before) !== JSON.stringify(change.after));
    if (!changes.length) return null;
    const proposal: ChatProposal = { id: requestedId ?? randomUUID(), canvasId: this.canvasId, status: 'pending',
      expiresAt: new Date(Date.now() + lifetime).toISOString(), changes };
    saveState(this.store, proposal.id, { version: 1, kind: 'pending', proposal, expires: Date.parse(proposal.expiresAt) });
    this.published = proposal;
    return proposal;
  }
}

export function getChatProposal(store: CanvasStore, id: string): ChatProposal | ChatProposalReceipt {
  const state = readState(store, id);
  return state.kind === 'pending' ? state.proposal : state.receipt;
}

async function withProposalLock<T>(store: CanvasStore, id: string, action: string, work: () => Promise<T>): Promise<T> {
  const file = proposalFile(store, id);
  if (busy.has(file)) throw new ApiError(409, `This Chat proposal is already being ${action}`);
  busy.add(file);
  try { return await work(); }
  finally { busy.delete(file); }
}

function pendingProposal(store: CanvasStore, id: string): ChatProposal {
  const entry = readState(store, id);
  if (entry.kind !== 'pending') throw new ApiError(410, 'This Chat proposal has already been applied. Review its receipt.');
  return entry.proposal;
}

type ApplySelection = { applicable: ChatProposalChange[]; skipped: ChatProposalReceipt['skipped'] };
function validateSelection(proposal: ChatProposal, changeIds?: string[]): void {
  if (changeIds && new Set(changeIds).size !== changeIds.length) throw new ApiError(400, 'Unknown or duplicate change ID');
  const known = new Set(proposal.changes.map(change => change.id));
  if (changeIds?.some(id => !known.has(id))) throw new ApiError(400, 'Unknown or duplicate change ID');
}
function selectedChanges(proposal: ChatProposal, changeIds?: string[]): ApplySelection {
  validateSelection(proposal, changeIds);
  const selected = proposal.changes.filter(change => !changeIds || changeIds.includes(change.id));
  if (!selected.length) throw new ApiError(400, 'Select at least one proposed change');
  const applicable = selected.filter(change => change.canApply);
  const skipped = selected.filter(change => !change.canApply).map(change => ({ id: change.id, reason: 'Delete needs a reversible restore path; use the document action outside Chat.' }));
  if (!applicable.length) throw new ApiError(400, 'This proposal has no changes that can be safely applied');
  return { applicable, skipped };
}

function assertSelectedLinks(proposal: ChatProposal, applicable: ChatProposalChange[]): void {
  const selectedIds = new Set(applicable.map(change => change.blockId));
  const stagedIds = new Set(proposal.changes.filter(change => change.type === 'create').map(change => change.blockId));
  if (applicable.some(change => change.after?.links.some(id => stagedIds.has(id) && !selectedIds.has(id)))) {
    throw new ApiError(400, 'Select the new documents referenced by the selected links');
  }
}

async function assertCurrentDocuments(store: CanvasStore, proposal: ChatProposal, applicable: ChatProposalChange[]): Promise<Map<string, CanvasBlock>> {
  const canvas = await store.getCanvas(proposal.canvasId);
  const current = new Map(canvas.blocks.map(block => [block.id, block]));
  const conflicts = applicable.filter(change => change.before && (!current.has(change.blockId)
    || stateHash(current.get(change.blockId)!) !== stateHash(change.before))).map(change => ({ id: change.id, reason: 'Document changed since preview' }));
  if (conflicts.length) throw new ChatProposalConflict(conflicts);
  return current;
}

type ApplyProgress = Pick<ChatProposalReceipt, 'createdBlockIds' | 'documents' | 'applied'>;
function emptyProgress(): ApplyProgress { return { createdBlockIds: {}, documents: [], applied: [] }; }
function savedId(progress: ApplyProgress, blockId: string): string { return progress.createdBlockIds[blockId] ?? blockId; }
function savedLinkTypes(progress: ApplyProgress, types: CanvasBlock['linkTypes']): CanvasBlock['linkTypes'] {
  if (!types) return undefined;
  return Object.fromEntries(Object.entries(types).map(([id, relation]) => [savedId(progress, id), relation]));
}
async function saveCreatedChanges(store: CanvasStore, proposal: ChatProposal, changes: ChatProposalChange[], progress: ApplyProgress): Promise<void> {
  for (const change of changes.filter(item => item.type === 'create')) {
    const after = change.after!;
    const initial = await store.createBlock(proposal.canvasId, { title: after.title, content: after.content, kind: after.kind, x: after.x, y: after.y }, reviewActor());
    const saved = initial.x === after.x && initial.y === after.y ? initial
      : await store.updateBlock(proposal.canvasId, initial.id, { x: after.x, y: after.y }, reviewActor());
    progress.createdBlockIds[change.blockId] = saved.id;
    progress.applied.push(change.id);
    progress.documents.push({ id: change.id, before: null, after: saved });
  }
}
async function saveExistingChanges(store: CanvasStore, proposal: ChatProposal, changes: ChatProposalChange[], progress: ApplyProgress): Promise<void> {
  for (const change of changes.filter(item => item.type !== 'create')) {
    const after = change.after!;
    const saved = await store.updateBlock(proposal.canvasId, change.blockId, {
      title: after.title, content: after.content, kind: after.kind, x: after.x, y: after.y,
      links: after.links.map(id => savedId(progress, id)), linkTypes: savedLinkTypes(progress, after.linkTypes),
      expectedContentHash: change.expectedContentHash,
    }, reviewActor());
    progress.applied.push(change.id);
    progress.documents.push({ id: change.id, before: change.before, after: saved });
  }
}
async function saveCreatedLinks(store: CanvasStore, proposal: ChatProposal, changes: ChatProposalChange[], progress: ApplyProgress): Promise<void> {
  for (const change of changes.filter(item => item.type === 'create' && item.after?.links.length)) {
    const after = change.after!;
    const id = savedId(progress, change.blockId);
    const saved = await store.updateBlock(proposal.canvasId, id, {
      links: after.links.map(link => savedId(progress, link)), linkTypes: savedLinkTypes(progress, after.linkTypes),
    }, reviewActor());
    progress.documents = progress.documents.map(item => item.after?.id === id ? { ...item, after: saved } : item);
  }
}
type CommitResult = { ok: true } | { ok: false; failure: unknown };
async function commitChanges(store: CanvasStore, proposal: ChatProposal, changes: ChatProposalChange[], progress: ApplyProgress): Promise<CommitResult> {
  try {
    await saveCreatedChanges(store, proposal, changes, progress);
    await saveExistingChanges(store, proposal, changes, progress);
    await saveCreatedLinks(store, proposal, changes, progress);
    return { ok: true };
  } catch (failure) { return { ok: false, failure }; }
}

function discoverSavedCreate(change: ChatProposalChange, latest: CanvasBlock[], before: Map<string, CanvasBlock>, progress: ApplyProgress): CanvasBlock | undefined {
  const after = latest.find(block => !before.has(block.id) && !progress.documents.some(item => item.after?.id === block.id)
    && block.title === change.after?.title && block.content === change.after?.content);
  if (after) progress.createdBlockIds[change.id] = after.id;
  return after;
}
function savedChange(change: ChatProposalChange, latest: CanvasBlock[], before: Map<string, CanvasBlock>, progress: ApplyProgress): CanvasBlock | undefined {
  const saved = latest.find(block => block.id === savedId(progress, change.id));
  if (saved || change.type !== 'create') return saved;
  return discoverSavedCreate(change, latest, before, progress);
}
function recordSavedChange(change: ChatProposalChange, after: CanvasBlock | undefined, progress: ApplyProgress): void {
  if (!after || (change.before && stateHash(after) === stateHash(change.before))) return;
  const known = progress.documents.find(item => item.id === change.id);
  if (known) known.after = after;
  else progress.documents.push({ id: change.id, before: change.before, after });
  if (!progress.applied.includes(change.id)) progress.applied.push(change.id);
}
async function reconcileApplyFailure(store: CanvasStore, proposal: ChatProposal, changes: ChatProposalChange[],
  before: Map<string, CanvasBlock>, progress: ApplyProgress, skipped: ChatProposalReceipt['skipped'], failure: unknown): Promise<void> {
  const latest = (await store.getCanvas(proposal.canvasId)).blocks;
  for (const change of changes) recordSavedChange(change, savedChange(change, latest, before, progress), progress);
  const reason = failure instanceof Error ? failure.message : 'The save stopped unexpectedly';
  for (const change of changes.filter(item => !progress.applied.includes(item.id))) {
    skipped.push({ id: change.id, reason: `Apply stopped: ${reason}` });
  }
}
async function applyPending(store: CanvasStore, id: string, changeIds?: string[]): Promise<ChatProposalReceipt> {
  const proposal = pendingProposal(store, id);
  const { applicable, skipped } = selectedChanges(proposal, changeIds);
  assertSelectedLinks(proposal, applicable);
  const before = await assertCurrentDocuments(store, proposal, applicable);
  const progress = emptyProgress();
  const result = await commitChanges(store, proposal, applicable, progress);
  if (!result.ok) await reconcileApplyFailure(store, proposal, applicable, before, progress, skipped, result.failure);
  const receipt: ChatProposalReceipt = { id, status: skipped.length || !result.ok ? 'partial' : 'applied', skipped, ...progress };
  saveState(store, id, { version: 1, kind: 'applied', canvasId: proposal.canvasId, receipt, expires: Date.now() + lifetime });
  return receipt;
}
export async function applyChatProposal(store: CanvasStore, id: string, changeIds?: string[], actor = 'Symbi'): Promise<ChatProposalReceipt> {
  return proposalActor.run(actor, () => withProposalLock(store, id, 'applied', () => applyPending(store, id, changeIds)));
}

type UndoResult = { id: string; status: 'reverted' | 'partial'; reverted: string[]; skipped: { id: string; reason: string }[] };
type ReceiptDocument = ChatProposalReceipt['documents'][number];
function appliedRun(store: CanvasStore, id: string): AppliedState {
  const run = readState(store, id);
  if (run.kind !== 'applied' || !run.receipt.documents.length) throw new ApiError(410, 'This applied Chat proposal is no longer available to undo. Review the current documents.');
  return run;
}
async function assertUndoCurrent(store: CanvasStore, run: AppliedState): Promise<void> {
  const canvas = await store.getCanvas(run.canvasId);
  const current = new Map(canvas.blocks.map(block => [block.id, block]));
  const conflicts = run.receipt.documents.filter(item => !item.after || !current.has(item.after.id)
    || stateHash(current.get(item.after.id)!) !== stateHash(item.after)).map(item => ({ id: item.after!.id, reason: 'Document changed since apply' }));
  if (conflicts.length) throw new ChatProposalConflict(conflicts);
}
function restoredPlacement(before: CanvasBlock): Parameters<CanvasStore['updateBlock']>[2] {
  return { group: before.group ?? null, purpose: before.purpose ?? '',
    reviewer: before.reviewer ?? '', workArea: before.workArea ?? '' };
}
function restoredMetadata(before: CanvasBlock): Parameters<CanvasStore['updateBlock']>[2] {
  return { linkTypes: before.linkTypes ?? {}, ...restoredPlacement(before),
    crossLinks: before.crossLinks ?? [], headline: before.headline ?? null, freshness: before.freshness ?? null };
}
function restoredTags(before: CanvasBlock): Parameters<CanvasStore['updateBlock']>[2] {
  return before.tags === undefined ? {} : { tags: before.tags };
}
function restorePatch(before: CanvasBlock, after: CanvasBlock): Parameters<CanvasStore['updateBlock']>[2] {
  return { title: before.title, content: before.content, kind: before.kind,
    x: before.x, y: before.y, width: before.width, height: before.height, links: before.links,
    ...restoredMetadata(before), ...restoredTags(before),
    expectedContentHash: contentHash(after.content) };
}
async function revertDocument(store: CanvasStore, canvasId: string, item: ReceiptDocument): Promise<void> {
  if (!item.before) { await store.deleteBlock(canvasId, item.after!.id, reviewActor()); return; }
  await store.updateBlock(canvasId, item.after!.id, restorePatch(item.before, item.after!), reviewActor());
  await store.jevExecutor.setOwnership(canvasId, item.after!.id, initializeJevStamp(item.before).jevOwnership!);
}
async function revertDocuments(store: CanvasStore, run: AppliedState, ordered: ReceiptDocument[]): Promise<unknown> {
  const peers: JevParentUndo[] = ordered.map(item => item.before ? { kind: 'edited', before: item.before, after: item.after! } : { kind: 'created', after: item.after! });
  for (const item of ordered) {
    try {
      const canvas = await store.getCanvas(run.canvasId, true);
      const parent: JevParentUndo = item.before ? { kind: 'edited', before: item.before, after: item.after! } : { kind: 'created', after: item.after! };
      await withCausalParentUndo(store, canvas.workspaceId, canvas.id, [parent],
        { id: reviewActor(), kind: 'user', access: 'write', canApprove: true }, () => revertDocument(store, run.canvasId, item), { peers });
    }
    catch (error) { return error; }
  }
  return undefined;
}
function wasReverted(item: ReceiptDocument, current: Map<string, CanvasBlock>): boolean {
  if (!item.before) return !current.has(item.after!.id);
  const latest = current.get(item.after!.id);
  if (!latest) return false;
  const expected = { ...item.before, jevOwnership: initializeJevStamp(item.before).jevOwnership, contentHash: contentHash(item.before.content) };
  return documentReviewState(latest) === documentReviewState(expected);
}
async function finalizeUndo(store: CanvasStore, id: string, run: AppliedState, ordered: ReceiptDocument[], failure: unknown): Promise<UndoResult> {
  const latest = new Map((await store.getCanvas(run.canvasId)).blocks.map(block => [block.id, block]));
  const reverted = ordered.filter(item => wasReverted(item, latest)).map(item => item.id);
  run.receipt.documents = run.receipt.documents.filter(item => !reverted.includes(item.id));
  run.receipt.applied = run.receipt.applied.filter(changeId => !reverted.includes(changeId));
  if (run.receipt.documents.length) saveState(store, id, run);
  else rmSync(proposalFile(store, id), { force: true });
  const reason = failure instanceof Error ? failure.message : 'Undo stopped before every change was reverted';
  return { id, status: run.receipt.documents.length ? 'partial' : 'reverted', reverted,
    skipped: run.receipt.documents.map(item => ({ id: item.id, reason })) };
}
async function undoApplied(store: CanvasStore, id: string): Promise<UndoResult> {
  const run = appliedRun(store, id);
  // Per-document causal guards include the source generation and the original parent snapshot.
  // Preserve the existing all-document preflight when no causal enrichment changed the receipt.
  const canvas = await store.getCanvas(run.canvasId, true);
  const current = new Map(canvas.blocks.map(block => [block.id, block]));
  const conflicts = run.receipt.documents.filter(item => {
    const block = item.after && current.get(item.after.id);
    return !block || block.incarnation !== item.after!.incarnation || block.sourceGeneration !== item.after!.sourceGeneration;
  }).map(item => ({ id: item.after?.id ?? '', reason: 'Document changed since apply' }));
  if (conflicts.length) throw new ChatProposalConflict(conflicts);
  if (run.receipt.documents.every(item => current.get(item.after!.id)!.jevMutationId === item.after!.jevMutationId)) await assertUndoCurrent(store, run);
  await preflightCausalParentUndo(store, canvas.workspaceId, canvas.id, run.receipt.documents.map(item =>
    item.before ? { kind: 'edited', before: item.before, after: item.after! } : { kind: 'created', after: item.after! }));
  const ordered = [...run.receipt.documents.filter(item => item.before), ...run.receipt.documents.filter(item => !item.before)];
  const failure = await revertDocuments(store, run, ordered);
  return finalizeUndo(store, id, run, ordered, failure);
}
export async function undoChatProposal(store: CanvasStore, id: string, actor = 'Symbi'): Promise<UndoResult> {
  return proposalActor.run(actor, () => withProposalLock(store, id, 'undone', () => undoApplied(store, id)));
}

export class ChatProposalConflict extends ApiError {
  constructor(readonly conflicts: { id: string; reason: string }[]) {
    super(409, 'A document changed since this Chat proposal. Review the current canvas and try again.');
  }
}
