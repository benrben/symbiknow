import type { CanvasBlock } from '../shared/types.js';
import { blockStateHash } from './block-state.js';
import { ApiError } from './errors.js';

/** Validate a reviewed snapshot before a serialized document or task mutation. */
export function checkBlockStateHashes(blocks: CanvasBlock[], hashes: Record<string, unknown> | undefined, message: string): void {
  for (const [id, hash] of Object.entries(hashes ?? {})) {
    const block = blocks.find(item => item.id === id);
    if (!block || blockStateHash(block) !== hash) throw new ApiError(409, message);
  }
}
