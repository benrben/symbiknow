import type { CanvasBlock, CanvasDocument } from '../../shared/types.js';
import { changedJevStamp } from './stamps.js';

function mutationMarker(block: CanvasBlock, mutationId?: string): string { return mutationId ?? block.jevMutationId ?? ''; }

function movedOwnership(previous: CanvasBlock, changed: CanvasBlock, oldCanvasId: string, canvasId: string,
  sourceId: string, targetId: string, movedId: string): void {
  const ownership = previous.jevOwnership;
  if (!ownership) return;
  const removedLinks = ownership.removedLinks.map(link => {
    let sourceCanvasId = oldCanvasId;
    let id = link;
    if (link.includes(':')) [sourceCanvasId, id] = link.split(':');
    if (sourceCanvasId === sourceId && id === movedId) sourceCanvasId = targetId;
    return sourceCanvasId === canvasId ? id : `${sourceCanvasId}:${id}`;
  });
  const managed = ownership.managed.map(field => field === `link:${sourceId}:${movedId}` ? `link:${targetId}:${movedId}` : field);
  changed.jevOwnership = { ...ownership, managed, removedLinks };
  if (JSON.stringify(changed.jevOwnership) !== JSON.stringify(ownership) && changed.metadataRevision === previous.metadataRevision) {
    changed.metadataRevision!++;
  }
}

/** Retargeted references keep manual ownership while their canonical metadata revision advances. */
export function stampedMove(before: CanvasDocument[], after: CanvasDocument[], sourceId: string, targetId: string,
  movedId: string, mutationId?: string): CanvasDocument[] {
  const previous = new Map(before.flatMap(canvas => canvas.blocks.map(block => [block.id, { canvasId: canvas.id, block }] as const)));
  return after.map(canvas => ({ ...canvas, blocks: canvas.blocks.map(block => {
    const old = previous.get(block.id)!;
    const changed = changedJevStamp(old.block, block, { mutationId: mutationMarker(old.block, mutationId), managed: true, canvasId: old.canvasId });
    if (old.canvasId !== canvas.id && changed.metadataRevision === old.block.metadataRevision) changed.metadataRevision!++;
    if (!mutationId) changed.jevMutationId = old.block.jevMutationId;
    movedOwnership(old.block, changed, old.canvasId, canvas.id, sourceId, targetId, movedId);
    return changed;
  }) }));
}
