import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import type { StorageFiles } from './storage-files.js';
import type { StoredCanvas } from './storage-shapes.js';
import { canvasData } from './storage-shapes.js';

/** Read filtering must not remove saved references during unrelated writes. Explicit edits still replace them. */
export async function documentWriteSnapshot(files: StorageFiles, canvas: CanvasDocument): Promise<CanvasDocument> {
  const before = await files.readJson<StoredCanvas>(files.canvasFile(canvas.id));
  const saved = new Map(before.blocks.map(block => [block.id, block]));
  const blocks = canvas.blocks.map(block => {
    if (!saved.has(block.id)) return block;
    return { ...block, crossLinks: saved.get(block.id)!.crossLinks };
  });
  return { ...canvasData(canvas), blocks };
}

/** The saved before-state remains available for preconditions; explicit cross-link patches replace it. */
export function changedDocumentSnapshot(snapshot: CanvasDocument, updated: CanvasBlock, input: Record<string, unknown>): CanvasDocument {
  const blocks = snapshot.blocks.map(block => {
    if (block.id !== updated.id) return block;
    return { ...updated, crossLinks: input.crossLinks === undefined ? block.crossLinks : updated.crossLinks };
  });
  return { ...snapshot, blocks };
}
