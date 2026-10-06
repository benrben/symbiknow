import type { CanvasBlock, CrossLink, LinkRelation } from '../shared/types.js';
import { ApiError } from './errors.js';

export function outgoingRelations(keeper: CanvasBlock, merging: CanvasBlock[]): Record<string, LinkRelation> {
  return Object.assign({}, ...merging.map(block => block.linkTypes), keeper.linkTypes);
}

export function outgoingCrossLinks(keeper: CanvasBlock, merging: CanvasBlock[]): CrossLink[] {
  const links = [...(keeper.crossLinks ?? []), ...merging.flatMap(block => block.crossLinks ?? [])];
  const unique = new Map<string, CrossLink>();
  for (const link of links) {
    const key = `${link.canvasId}:${link.blockId}`;
    if (!unique.has(key)) unique.set(key, link);
  }
  if (unique.size > 20) throw new ApiError(409, 'Merging these documents would exceed the cross-canvas link limit. Review their links first.');
  return [...unique.values()];
}
