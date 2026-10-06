import type { CanvasBlock } from '../../shared/types.js';
import type { JevPrincipal } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import { ApiError } from '../errors.js';
import { contentHash } from '../storage-shapes.js';
import { documentReviewState } from '../../shared/document-state.js';
import { initializeJevStamp } from './stamps.js';
import { browserUndoDefaults, withCausalParentUndo, type JevParentUndo } from './parent-undo.js';

function validParent(parent: JevParentUndo): boolean {
  if (!parent || !['created', 'edited'].includes(parent.kind) || !parent.after?.id || !parent.after.incarnation) return false;
  return parent.kind !== 'edited' || parent.before?.id === parent.after.id;
}
function checkEditedParent(parent: JevParentUndo): void {
  if (parent.kind !== 'edited') return;
  if (!parent.after.contentHash || JSON.stringify(parent.before.quality) !== JSON.stringify(parent.after.quality)) throw new ApiError(409, 'This edit needs review in document history');
}
async function normalizedParent(store: CanvasStore, canvasId: string, parent: JevParentUndo): Promise<JevParentUndo> {
  if (!validParent(parent)) throw new ApiError(400, 'Invalid parent Undo');
  checkEditedParent(parent);
  if (parent.kind !== 'created' || parent.after.contentHash) return parent;
  const current = (await store.getCanvas(canvasId, true)).blocks.find(block => block.id === parent.after.id);
  if (!current || current.content !== parent.after.content) throw new ApiError(409, 'This document changed after creation');
  return { ...parent, after: { ...parent.after, contentHash: contentHash(parent.after.content) } };
}
function restoredFields(parent: Extract<JevParentUndo, { kind: 'edited' }>): Record<string, unknown> {
  const before = parent.before;
  const fields: Record<string, unknown> = { ...before, message: `Undo agent edit to ${before.title}` };
  for (const key of ['id', 'file', 'incarnation', 'sourceGeneration', 'metadataRevision', 'jevOwnership', 'jevMutationId', 'contentHash', 'lock', 'lastModified', 'authors', 'latestAuthor']) delete fields[key];
  for (const [key, value] of Object.entries(browserUndoDefaults)) fields[key] = fields[key] ?? value;
  return fields;
}

async function restoreBrowserEdit(store: CanvasStore, canvasId: string, current: CanvasBlock,
  parent: Extract<JevParentUndo, { kind: 'edited' }>, expected: Record<string, unknown>): Promise<CanvasBlock> {
  await store.updateBlock(canvasId, current.id, { ...expected, expectedContentHash: current.contentHash, ...restoredFields(parent) }, 'Browser');
  await store.jevExecutor.setOwnership(canvasId, current.id, initializeJevStamp(parent.before).jevOwnership!);
  return (await store.getCanvas(canvasId, true)).blocks.find(block => block.id === current.id)!;
}
export async function undoBrowserParent(store: CanvasStore, workspaceId: string, canvasId: string,
  suppliedParent: JevParentUndo, principal: JevPrincipal): Promise<CanvasBlock | null> {
  const parent = await normalizedParent(store, canvasId, suppliedParent);
  return withCausalParentUndo(store, workspaceId, canvasId, [parent], principal, async () => {
    const current = (await store.getCanvas(canvasId, true)).blocks.find(block => block.id === parent.after.id)!;
    const expected = { expectedDocumentState: documentReviewState(current), expectedSavedCrossLinks: JSON.stringify(parent.after.crossLinks ?? []) };
    if (parent.kind === 'edited') return restoreBrowserEdit(store, canvasId, current, parent, expected);
    await store.deleteBlock(canvasId, current.id, 'Browser', { ...expected, requireUnreferenced: true });
    return null;
  }, { actor: 'Browser' });
}
