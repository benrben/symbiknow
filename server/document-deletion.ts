import { documentReviewState, type BlockDeletionPreconditions } from '../shared/document-state.js';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { ApiError } from './errors.js';
import type { StorageContext } from './storage-context.js';
import type { StoredCanvas } from './storage-shapes.js';
import { contentHash } from './storage-shapes.js';

export function checkReviewedDocumentState(block: CanvasBlock, expected: unknown): void {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || documentReviewState(block) !== expected) {
    throw new ApiError(409, 'This document changed since review. Read it again before applying this change.');
  }
}

/** A filtered canvas view cannot establish whether a retained source link was changed. */
export function checkSavedCrossLinkState(block: Pick<CanvasBlock, 'crossLinks'>, expected: unknown): void {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || JSON.stringify(block.crossLinks ?? []) !== expected) {
    throw new ApiError(409, 'This document has saved source links that need review before applying this change.');
  }
}

/** Check inside the serialized write, before recording history or removing data. */
export function checkDeletionPreconditions(canvas: CanvasDocument, block: CanvasBlock, expected?: BlockDeletionPreconditions): void {
  if (!expected) return;
  if (expected.expectedContentHash !== undefined && expected.expectedContentHash !== contentHash(block.content)) {
    throw new ApiError(409, 'This document changed since you read it. Read it again before deleting.',
      { currentContentHash: contentHash(block.content) });
  }
  checkReviewedDocumentState(block, expected.expectedDocumentState);
  if (expected.requireUnreferenced && canvas.blocks.some(other => other.id !== block.id && other.links.includes(block.id))) {
    throw new ApiError(409, 'This document has a new reference. Review it before deleting.');
  }
}

/** Retained references on other canvases must survive even when their source is archived. */
export async function checkCrossCanvasDeletionReferences(context: StorageContext, canvas: CanvasDocument, block: CanvasBlock, required?: boolean): Promise<void> {
  if (!required) return;
  const workspaces = await context.listWorkspaces();
  const others = workspaces.flatMap(workspace => workspace.canvases);
  for (const other of others) {
    if (other.id === canvas.id) continue;
    const saved = await context.files.readJson<StoredCanvas>(context.files.canvasFile(other.id));
    if (saved.blocks.some(source => source.crossLinks?.some(link => link.canvasId === canvas.id && link.blockId === block.id))) {
      throw new ApiError(409, 'This document has a new cross-canvas reference. Review it before deleting.');
    }
  }
}
