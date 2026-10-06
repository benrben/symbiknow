import { isDeepStrictEqual } from 'node:util';
import type { JevWorkspaceState } from '../../shared/jev-types.js';
import type { StoredBlock } from '../storage-shapes.js';
import type { StoredJevReceipt } from './proposals.js';
export type DocumentApprovalReceipt = StoredJevReceipt & { after: Extract<StoredJevReceipt['after'], {kind: 'document'}> };
type Snapshot = (receipt: DocumentApprovalReceipt, phase: 'before' | 'after') => StoredBlock | undefined;
function previousReceipt(state: JevWorkspaceState, current: DocumentApprovalReceipt, before?: StoredBlock): DocumentApprovalReceipt | undefined {
  return state.receipts.find((receipt): receipt is DocumentApprovalReceipt => receipt.id === before?.jevMutationId
    && receipt.state === 'applied' && receipt.after.kind === 'document'
    && receipt.after.canvasId === current.after.canvasId && receipt.after.blockId === current.after.blockId);
}
function unchangedGeneration(before?: StoredBlock, after?: StoredBlock): boolean {
  return Boolean(before && after && before.incarnation === after.incarnation && before.sourceGeneration === after.sourceGeneration);
}
/** Full native snapshots and markers prove every step; matching field values alone never establish lineage. */
export function approvalTrail(state: JevWorkspaceState, latest: DocumentApprovalReceipt, snapshot: Snapshot): DocumentApprovalReceipt[] {
  const trail: DocumentApprovalReceipt[] = []; const seen = new Set<string>();
  let current: DocumentApprovalReceipt | undefined = latest;
  while (current && !seen.has(current.id)) {
    const before = snapshot(current, 'before');
    if (!unchangedGeneration(before, snapshot(current, 'after'))) break;
    trail.push(current); seen.add(current.id);
    const previous = previousReceipt(state, current, before);
    if (!previous || !isDeepStrictEqual(snapshot(previous, 'after'), before)) break;
    current = previous;
  }
  return trail;
}
/** A later manual or reviewed write settles ownership for that field before older candidates are considered. */
export function lastApprovalFields(trail: DocumentApprovalReceipt[], pins: string[], introduced: (receipt: DocumentApprovalReceipt) => string[]):
  Array<{receipt: DocumentApprovalReceipt; fields: string[]}> {
  const seen = new Set<string>(); const found: Array<{receipt: DocumentApprovalReceipt; fields: string[]}> = [];
  for (const receipt of trail) {
    const fields = introduced(receipt).filter(field => !seen.has(field) && pins.includes(field));
    for (const field of Object.keys(receipt.after.patch)) seen.add(field);
    if (fields.length) found.push({ receipt, fields });
  }
  return found;
}
