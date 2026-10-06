import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevOwnership, JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import type { StoredBlock } from '../storage-shapes.js';
import type { JevArtifact } from '../storage-jev-executor.js';
import { automationPrincipal } from './authorization.js';
import type { JevProposalExecutor, StoredJevReceipt } from './proposals.js';
import type { JevWorkspaceFiles } from './workspace.js';
import { sameJevSource, sourceSnapshot } from './stamps.js';
import { approvalTrail, lastApprovalFields } from './approval-chain.js';

const prefix = 'origin-migration:';
const organization = ['group', 'tags', 'headline', 'freshness', 'links', 'crossLinks', 'linkTypes'];
type DocumentReceipt = StoredJevReceipt & { after: Extract<StoredJevReceipt['after'], {kind: 'document'}> };
type OriginReceipt = DocumentReceipt & { ownershipReconciled?: boolean; ownershipOriginalAfter?: StoredBlock };

/** Approval keeps the trusted proposal's origin; editing its values is a manual correction. */
export function trustedManagedOrigin(proposal: JevProposal): boolean {
  return !proposal.reviewerEdited && !proposal.jobId.startsWith('override:')
    && proposal.sources.length > 0 && proposal.evidence.length > 0;
}
function documentReceipt(receipt: StoredJevReceipt): receipt is DocumentReceipt {
  return receipt.state === 'applied' && receipt.after.kind === 'document';
}
function receiptArtifact(receipt: DocumentReceipt): Extract<JevArtifact, {kind: 'canvas'}> | undefined {
  return receipt.preparedArtifacts?.find((artifact): artifact is Extract<JevArtifact, {kind: 'canvas'}> =>
    artifact.kind === 'canvas' && artifact.id === receipt.after.canvasId);
}
function receiptBlock(receipt: DocumentReceipt, phase: 'before' | 'after'): StoredBlock | undefined {
  return receiptArtifact(receipt)?.[phase].blocks.find(block => block.id === receipt.after.blockId);
}
function master(field: string): string { return field === 'linkTypes' ? 'links' : field; }
function introducedFields(receipt: DocumentReceipt): string[] {
  const before = receiptBlock(receipt, 'before')?.jevOwnership;
  const after = receiptBlock(receipt, 'after')?.jevOwnership;
  if (!before || !after) return [];
  return Object.keys(receipt.after.patch).filter(field => organization.includes(field)
    && before.managed.includes(master(field)) && !before.pins.includes(field) && after.pins.includes(field));
}
function expectedOwnership(receipt: DocumentReceipt, block: CanvasBlock, fields: string[]): JevOwnership | undefined {
  const saved = receiptBlock(receipt, 'after');
  if (saved?.jevMutationId !== receipt.id || !isDeepStrictEqual(saved.jevOwnership, block.jevOwnership)) return undefined;
  const ownership = block.jevOwnership!;
  return { ...ownership, pins: ownership.pins.filter(field => !fields.includes(field)),
    managed: [...new Set([...ownership.managed, ...fields.map(master)])] };
}
function sameFields(receipt: DocumentReceipt, block: CanvasBlock): boolean {
  return Object.entries(receipt.after.patch).every(([field, value]) =>
    isDeepStrictEqual(block[field as keyof CanvasBlock] ?? null, value ?? null));
}
function exactSource(receipt: DocumentReceipt, source: JevSourceSnapshot): boolean {
  const expected = receipt.sourcesAfter.find(item => item.canvasId === source.canvasId && item.blockId === source.blockId);
  return Boolean(expected && sameJevSource(source, expected));
}
function latestReceipts(state: JevWorkspaceState): DocumentReceipt[] {
  const latest = new Map<string, DocumentReceipt>();
  for (const receipt of state.receipts as StoredJevReceipt[]) if (documentReceipt(receipt)) {
    latest.set(`${receipt.after.canvasId}:${receipt.after.blockId}`, receipt);
  }
  return [...latest.values()];
}
function originalProposal(state: JevWorkspaceState, receipt: DocumentReceipt): JevProposal | undefined {
  if (receipt.automatic || (receipt as OriginReceipt).ownershipReconciled) return undefined;
  const proposal = state.proposals.find(item => item.id === receipt.proposalId);
  return proposal && trustedManagedOrigin(proposal) ? proposal : undefined;
}
function migrationProposal(original: JevProposal, receipt: DocumentReceipt, source: JevSourceSnapshot): JevProposal {
  return { id: randomUUID(), jobId: `${prefix}${receipt.id}`, action: 'profile', state: 'pending',
    title: 'Restore Reflex metadata ownership', explanation: 'Durable approval provenance confirms no later correction',
    createdAt: new Date().toISOString(), evidence: original.evidence, sources: [source],
    mutation: { kind: 'document', canvasId: receipt.after.canvasId, blockId: receipt.after.blockId, patch: {} } };
}
function migrationOriginal(state: JevWorkspaceState, originalId: string): OriginReceipt | undefined {
  const receipt = state.receipts.find(item => item.id === originalId) as OriginReceipt | undefined;
  if (!receipt || receipt.ownershipReconciled || !documentReceipt(receipt)) return undefined;
  return receipt;
}
function finalizeMigration(state: JevWorkspaceState, migration: DocumentReceipt): boolean {
  const proposal = state.proposals.find(item => item.id === migration.proposalId);
  if (!proposal?.jobId.startsWith(prefix)) return false;
  const original = migrationOriginal(state, proposal.jobId.slice(prefix.length));
  if (!original) return false;
  const artifact = receiptArtifact(original); const migrated = receiptBlock(migration, 'after');
  if (!artifact || !migrated) return false;
  original.ownershipOriginalAfter ??= structuredClone(artifact.after.blocks.find(block => block.id === original.after.blockId)!);
  artifact.after.blocks = artifact.after.blocks.map(block => block.id === migrated.id ? { ...block,
    jevOwnership: migrated.jevOwnership, metadataRevision: migrated.metadataRevision, jevMutationId: migrated.jevMutationId } : block);
  original.sourcesAfter = original.sourcesAfter.map(source => migration.sourcesAfter.find(item =>
    item.canvasId === source.canvasId && item.blockId === source.blockId) ?? source);
  original.ownershipReconciled = true;
  return true;
}
async function finalizeCommitted(files: JevWorkspaceFiles, workspaceId: string): Promise<void> {
  const state = await files.read(workspaceId);
  let changed = false;
  for (const receipt of state.receipts as StoredJevReceipt[]) if (documentReceipt(receipt)) changed = finalizeMigration(state, receipt) || changed;
  if (changed) await files.write(workspaceId, state);
}
async function checkedReceiptSource(store: CanvasStore, workspaceId: string, receipt: DocumentReceipt): Promise<{block: CanvasBlock; source: JevSourceSnapshot} | undefined> {
  const canvas = await store.getCanvas(receipt.after.canvasId, true);
  const block = canvas.blocks.find(item => item.id === receipt.after.blockId);
  if (!block || !sameFields(receipt, block)) return undefined;
  const source = sourceSnapshot(workspaceId, canvas.id, block);
  return exactSource(receipt, source) ? { block, source } : undefined;
}
function historicalBlock(state: JevWorkspaceState, receipt: DocumentReceipt, phase: 'before' | 'after'): StoredBlock | undefined {
  if (phase === 'before') return receiptBlock(receipt, phase);
  const original = (receipt as OriginReceipt).ownershipOriginalAfter;
  if (original) return original;
  const migration = (state.receipts as StoredJevReceipt[]).find(item => state.proposals.find(proposal => proposal.id === item.proposalId)?.jobId === `${prefix}${receipt.id}`);
  if (migration && documentReceipt(migration)) {
    const before = receiptBlock(migration, 'before');
    if (before?.jevMutationId === receipt.id) return before;
  }
  return receiptBlock(receipt, phase);
}
function sameContentGeneration(receipt: DocumentReceipt, source: JevSourceSnapshot): boolean {
  const expected = receipt.sourcesAfter.find(item => item.canvasId === source.canvasId && item.blockId === source.blockId);
  return Boolean(expected && expected.incarnation === source.incarnation
    && expected.sourceGeneration === source.sourceGeneration && expected.contentHash === source.contentHash);
}
async function checkedApprovalSource(store: CanvasStore, workspaceId: string, state: JevWorkspaceState, receipt: DocumentReceipt):
  Promise<{block: CanvasBlock; source: JevSourceSnapshot; latest: DocumentReceipt} | undefined> {
  const latest = latestReceipts(state).find(item => item.after.canvasId === receipt.after.canvasId && item.after.blockId === receipt.after.blockId)!;
  const checked = await checkedReceiptSource(store, workspaceId, latest);
  if (!checked || !sameContentGeneration(receipt, checked.source)) return undefined;
  return { ...checked, latest };
}
async function migrateReceipt(store: CanvasStore, files: JevWorkspaceFiles, executor: JevProposalExecutor,
  workspaceId: string, receipt: DocumentReceipt, fields: string[]): Promise<void> {
  const state = await files.read(workspaceId); const original = originalProposal(state, receipt);
  if (!original) return;
  const checked = await checkedApprovalSource(store, workspaceId, state, receipt);
  if (!checked) return;
  const { block, source, latest } = checked;
  const ownership = expectedOwnership(latest, block, fields);
  if (!ownership) return;
  const proposal = state.proposals.find(item => item.jobId === `${prefix}${receipt.id}`) ?? migrationProposal(original, receipt, source);
  if (!state.proposals.includes(proposal)) { state.proposals.push(proposal); await files.write(workspaceId, state); }
  await executor.applyInside(workspaceId, proposal.id, automationPrincipal, true, ownership, undefined, false);
  await finalizeCommitted(files, workspaceId);
}
/** Called after prepared recovery while holding both workspace and canonical write serialization. */
export async function reconcileApprovedOwnership(store: CanvasStore, files: JevWorkspaceFiles,
  executor: JevProposalExecutor, workspaceId: string): Promise<void> {
  await finalizeCommitted(files, workspaceId);
  const state = await files.read(workspaceId);
  for (const latest of latestReceipts(state)) {
    const trail = approvalTrail(state, latest, (receipt, phase) => historicalBlock(state, receipt, phase));
    const pins = receiptBlock(latest, 'after')?.jevOwnership?.pins ?? [];
    for (const { receipt, fields } of lastApprovalFields(trail, pins, introducedFields)) {
      await migrateReceipt(store, files, executor, workspaceId, receipt, fields);
    }
  }
}

/** Internal journal records never become review cards or semantic saved-change counts. */
export function withoutOriginMigrations(state: JevWorkspaceState): JevWorkspaceState {
  const internal = new Set(state.proposals.filter(proposal => proposal.jobId.startsWith(prefix)).map(proposal => proposal.id));
  return { ...state, proposals: state.proposals.filter(proposal => !internal.has(proposal.id)),
    receipts: state.receipts.filter(receipt => !internal.has(receipt.proposalId)) };
}
