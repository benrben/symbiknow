import type { CanvasBlock } from './types.js';

export type BlockDeletionPreconditions = { expectedDocumentState?: string; expectedSavedCrossLinks?: string; expectedContentHash?: string; requireUnreferenced?: boolean };

/** Review saved fields using the content version supplied by the native canvas read. Transient locks are excluded. */
export function documentReviewState(block: CanvasBlock): string {
  return JSON.stringify([block.id, block.title, block.file, block.kind, block.contentHash,
    block.x, block.y, block.width, block.height, block.links,
    Object.entries(block.linkTypes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    block.crossLinks, block.quality, block.archived, block.stale, block.tags,
    block.purpose, block.reviewer, block.group, block.workArea,
    block.headline, block.freshness, block.processingExcluded, block.jevOwnership]);
}
