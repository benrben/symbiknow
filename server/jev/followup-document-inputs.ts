import { isDeepStrictEqual } from 'node:util';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevOwnership, JevReceipt, JevWorkspaceState } from '../../shared/jev-types.js';
import { metadataFields } from './mutations.js';
import { automaticOrganizationReceipt } from './followup-receipt-origin.js';

type DocumentReceipt = JevReceipt & { before: Extract<JevReceipt['before'], { kind: 'document' }>;
  after: Extract<JevReceipt['after'], { kind: 'document' }> };
type IndexedReceipt = { receipt: DocumentReceipt; automatic: boolean };
function documentReceipt(receipt: JevReceipt): receipt is DocumentReceipt {
  return receipt.state === 'applied' && receipt.before.kind === 'document' && receipt.after.kind === 'document'
    && receipt.before.canvasId === receipt.after.canvasId && receipt.before.blockId === receipt.after.blockId;
}
function linkTypesPinned(ownership: JevOwnership, master: string): boolean {
  return master === 'links' && ownership.pins.includes('linkTypes');
}
function managedField(ownership: JevOwnership | undefined, field: string): boolean {
  if (!ownership) return false;
  const master = field === 'linkTypes' ? 'links' : field;
  if (ownership.pins.includes(field) || ownership.pins.includes(master)) return false;
  if (linkTypesPinned(ownership, master)) return false;
  return ownership.managed.includes(master);
}
function sameIncarnation(receipt: DocumentReceipt, block: CanvasBlock, canvasId: string): boolean {
  return receipt.sourcesAfter.some(source => source.canvasId === canvasId && source.blockId === block.id
    && source.incarnation === block.incarnation);
}
function checkedField(block: CanvasBlock, field: string, item: IndexedReceipt, canvasId: string): boolean {
  const values = block as unknown as Record<string, unknown>;
  const after = item.receipt.after.patch as Record<string, unknown>;
  return item.automatic && sameIncarnation(item.receipt, block, canvasId) && Object.hasOwn(item.receipt.before.patch, field)
    && isDeepStrictEqual(values[field] ?? null, after[field] ?? null);
}
function reverseField(block: CanvasBlock, field: string, indexed: IndexedReceipt[], canvasId: string): void {
  const values = block as unknown as Record<string, unknown>;
  for (const item of indexed) {
    const { receipt } = item;
    if (!Object.hasOwn(receipt.after.patch, field)) continue;
    if (!checkedField(block, field, item, canvasId)) break;
    const before = receipt.before.patch as Record<string, unknown>;
    if (before[field] == null) delete values[field];
    else values[field] = structuredClone(before[field]);
  }
}

/** Receipt patches are small literal values; canvas recovery proofs stay unread while planning. */
export class OrganizationDocumentProjection {
  private readonly receipts = new Map<string, IndexedReceipt[]>();
  constructor(state: JevWorkspaceState) {
    const proposals = new Map(state.proposals.map(proposal => [proposal.id, proposal]));
    for (const receipt of state.receipts.slice().reverse()) {
      if (!documentReceipt(receipt)) continue;
      const key = `${receipt.after.canvasId}:${receipt.after.blockId}`;
      const indexed = this.receipts.get(key) ?? [];
      indexed.push({ receipt, automatic: automaticOrganizationReceipt(receipt, proposals.get(receipt.proposalId)) });
      this.receipts.set(key, indexed);
    }
  }
  project(canvasId: string, block: CanvasBlock): CanvasBlock {
    const baseline = { ...block };
    const indexed = this.receipts.get(`${canvasId}:${block.id}`) ?? [];
    for (const field of metadataFields) if (managedField(block.jevOwnership, field)) reverseField(baseline, field, indexed, canvasId);
    return baseline;
  }
}

/** Per-edge ownership markers are generated output; permissions and manual correction memory remain inputs. */
export function organizationOwnership(ownership?: JevOwnership): JevOwnership | undefined {
  if (!ownership) return undefined;
  return { pins: ownership.pins.slice().sort(), removedLabels: ownership.removedLabels.slice().sort(),
    removedLinks: ownership.removedLinks.slice().sort(), managed: ownership.managed.filter(marker => !marker.startsWith('link:')).sort() };
}
