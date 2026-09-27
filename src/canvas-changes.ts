import type { CanvasBlock } from '../shared/types';

export type CanvasEdit = { before: CanvasBlock; after: CanvasBlock };
export type CanvasChanges = { created: CanvasBlock[]; updated: CanvasEdit[] };

/** Compare user-visible document state, ignoring version hashes and transient locks. */
export function sameDocument(left: CanvasBlock, right: CanvasBlock): boolean {
  const relevant = (block: CanvasBlock) => ({ id: block.id, file: block.file, title: block.title, kind: block.kind,
    content: block.content, x: block.x, y: block.y, width: block.width, height: block.height,
    links: block.links, linkTypes: block.linkTypes, crossLinks: block.crossLinks, quality: block.quality,
    archived: block.archived, stale: block.stale, tags: block.tags, purpose: block.purpose,
    reviewer: block.reviewer, group: block.group, workArea: block.workArea });
  return JSON.stringify(relevant(left)) === JSON.stringify(relevant(right));
}
