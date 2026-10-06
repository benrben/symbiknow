import { expect } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import { initializeJevStamp } from '../jev/stamps.js';

/** A historical restore preserves logical fields while generation counters remain monotonic. */
export function expectRestoredCanvas<T extends { blocks: CanvasBlock[] }>(current: T, previous: T): void {
  const logical = (canvas: T) => ({ ...canvas, blocks: canvas.blocks.map(source => {
    const block = { ...source };
    delete block.incarnation; delete block.sourceGeneration; delete block.metadataRevision; delete block.jevMutationId;
    const old = previous.blocks.find(item => item.id === block.id)!;
    if (!old.incarnation) delete block.jevOwnership;
    return block;
  }) });
  expect(logical(current)).toEqual(logical(previous));
  for (const block of current.blocks) {
    const old = previous.blocks.find(item => item.id === block.id)!;
    if (old.incarnation) expect(block.incarnation).toBe(old.incarnation);
    if (block.incarnation) {
      expect(block.sourceGeneration).toBeGreaterThanOrEqual(old.sourceGeneration ?? 1);
      expect(block.metadataRevision).toBeGreaterThanOrEqual(old.metadataRevision ?? 1);
      expect(block.jevOwnership).toEqual(initializeJevStamp(old).jevOwnership);
    }
  }
}
