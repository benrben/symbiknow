import { createHash } from 'node:crypto';
import type { CanvasBlock } from '../shared/types.js';

/** Version every saved field an insight can read or overwrite. Locks are transient. */
export function blockStateHash(block: CanvasBlock): string {
  const state = [block.id, block.title, block.file, block.kind, block.content,
    block.x, block.y, block.width, block.height, block.links,
    Object.entries(block.linkTypes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    block.crossLinks, block.quality, block.archived, block.stale, block.tags,
    block.purpose, block.reviewer, block.group, block.workArea,
    block.headline, block.freshness, block.processingExcluded, block.jevOwnership];
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}
