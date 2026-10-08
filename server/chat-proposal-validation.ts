import type { CanvasBlock } from '../shared/types.js';
import { contentHash } from './storage.js';
import type { ChatProposal, ChatProposalChange, ChatProposalReceipt, StoredState } from './chat-proposal-types.js';
import { isRecord, isString, isStringArray, stateHash } from './chat-proposal-values.js';

function validBlock(value: unknown): value is CanvasBlock {
  if (!isRecord(value)) return false;
  const block = value as Partial<CanvasBlock>;
  const identity = [block.id, block.title, block.content, block.file].every(isString);
  if (!identity) return false;
  const geometry = ['x', 'y', 'width', 'height'].every(key => Number.isFinite(block[key as keyof CanvasBlock]));
  const hash = block.contentHash === undefined || block.contentHash === contentHash(block.content!);
  return [identity, geometry, hash, isStringArray(block.links), ['markdown', 'slides', 'website', 'mdx'].includes(block.kind ?? '')].every(Boolean);
}
function validSnapshot(value: unknown): value is CanvasBlock | null { return value === null || validBlock(value); }
function validChangeIdentity(change: ChatProposalChange): boolean {
  return [isString(change.id), change.id === change.blockId, isString(change.title),
    ['create', 'edit', 'delete', 'move', 'link'].includes(change.type)].every(Boolean);
}
function snapshotMatchesId(snapshot: CanvasBlock | null, id: string): boolean {
  return snapshot === null || snapshot.id === id;
}
function validChangeSnapshots(change: ChatProposalChange): boolean {
  if (!validSnapshot(change.before) || !validSnapshot(change.after)) return false;
  return [snapshotMatchesId(change.before, change.blockId), snapshotMatchesId(change.after, change.blockId),
    change.canApply === Boolean(change.after)].every(Boolean);
}
function validChangeHashes(change: ChatProposalChange): boolean {
  const content = change.before ? contentHash(change.before.content) : null;
  const state = change.before ? stateHash(change.before) : null;
  return change.expectedContentHash === content && state === change.expectedStateHash;
}
function validChange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const change = value as ChatProposalChange;
  return validChangeIdentity(change) && validChangeSnapshots(change) && validChangeHashes(change);
}
function validPendingState(state: Record<string, unknown>, id: string): boolean {
  if (!isRecord(state.proposal)) return false;
  const proposal = state.proposal as ChatProposal;
  if (!Array.isArray(proposal.changes)) return false;
  const unique = new Set(proposal.changes.map(change => change?.id)).size === proposal.changes.length;
  return [proposal.id === id, proposal.status === 'pending', isString(proposal.canvasId),
    isString(proposal.expiresAt) && !Number.isNaN(Date.parse(proposal.expiresAt)),
    proposal.changes.length > 0, proposal.changes.every(validChange), unique].every(Boolean);
}
function validSkipped(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && isString(value.reason);
}
function validReceiptDocument(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && validSnapshot(value.before) && validSnapshot(value.after);
}
function validAppliedState(state: Record<string, unknown>, id: string): boolean {
  if (!isRecord(state.receipt)) return false;
  const receipt = state.receipt as ChatProposalReceipt;
  const lists = [isStringArray(receipt.applied), Array.isArray(receipt.skipped) && receipt.skipped.every(validSkipped),
    Array.isArray(receipt.documents) && receipt.documents.every(validReceiptDocument)];
  const ids = isRecord(receipt.createdBlockIds) && Object.values(receipt.createdBlockIds).every(isString);
  return [isString(state.canvasId), receipt.id === id, ['applied', 'partial'].includes(receipt.status), ids, ...lists].every(Boolean);
}
export function validState(value: unknown, id: string): value is StoredState {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || !Number.isFinite(value.expires)) return false;
  if (value.kind === 'pending') return validPendingState(value, id);
  if (value.kind === 'applied') return validAppliedState(value, id);
  return false;
}
