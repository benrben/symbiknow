import type { CanvasDocument } from '../shared/types.js';
import type { StorageFiles } from './storage-files.js';
import type { StoredCanvas } from './storage-shapes.js';
import { canvasData } from './storage-shapes.js';

/** Public reads hide unavailable references; a move and its rollback must retain the saved references. */
export async function moveSnapshot(files: StorageFiles, canvas: CanvasDocument): Promise<CanvasDocument> {
  const saved = await files.readJson<StoredCanvas>(files.canvasFile(canvas.id));
  const references = new Map(saved.blocks.map(block => [block.id, block.crossLinks]));
  return { ...canvasData(canvas), blocks: canvas.blocks.map(block => ({ ...block, crossLinks: references.get(block.id) })) };
}
