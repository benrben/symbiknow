import { randomUUID } from 'node:crypto';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevSourceSnapshot } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { contentHash } from '../storage-shapes.js';

export interface JevWriteOrigin { mutationId: string; managed?: boolean; canvasId?: string }
const managedFields = ['group', 'tags', 'headline', 'freshness', 'links', 'crossLinks'];
const metadataFields = [...managedFields, 'purpose', 'reviewer', 'quality', 'stale', 'archived', 'linkTypes', 'workArea', 'processingExcluded'];

export function initializeJevStamp(block: CanvasBlock): CanvasBlock {
  if (block.incarnation) return block;
  const pins = metadataFields.filter(field => {
    const value = block[field as keyof CanvasBlock];
    return value !== undefined && (!Array.isArray(value) || value.length > 0);
  });
  return { ...block, incarnation: randomUUID(), sourceGeneration: 1, metadataRevision: 1,
    jevOwnership: { pins, removedLabels: [], removedLinks: [], managed: managedFields.filter(field => !pins.includes(field)) } };
}

function removed(previous: string[] | undefined, next: string[] | undefined): string[] {
  return (previous ?? []).filter(item => !(next ?? []).includes(item));
}

function managedOwnership(previous: CanvasBlock, updated: CanvasBlock, origin: JevWriteOrigin) {
  const old = initializeJevStamp(previous).jevOwnership!;
  const added = updated.links.filter(id => !previous.links.includes(id)).map(id => `link:${origin.canvasId}:${id}`);
  const previousCross = new Set((previous.crossLinks ?? []).map(link => `${link.canvasId}:${link.blockId}`));
  added.push(...(updated.crossLinks ?? []).filter(link => !previousCross.has(`${link.canvasId}:${link.blockId}`))
    .map(link => `link:${link.canvasId}:${link.blockId}`));
  return { ...old, managed: [...new Set([...old.managed, ...added])] };
}
function manualOwnership(previous: CanvasBlock, updated: CanvasBlock, fields: string[]) {
  const old = initializeJevStamp(previous).jevOwnership!;
  const labels = fields.includes('tags') ? removed(previous.tags, updated.tags) : [];
  const links = fields.includes('links') ? removed(previous.links, updated.links) : [];
  if (fields.includes('crossLinks')) links.push(...removed(previous.crossLinks?.map(link => `${link.canvasId}:${link.blockId}`),
    updated.crossLinks?.map(link => `${link.canvasId}:${link.blockId}`)));
  return { pins: [...new Set([...old.pins, ...fields])],
    removedLabels: [...new Set([...old.removedLabels, ...labels])],
    removedLinks: [...new Set([...old.removedLinks, ...links])],
    managed: old.managed.filter(field => !fields.includes(field)) };
}
function ownership(previous: CanvasBlock, updated: CanvasBlock, fields: string[], origin?: JevWriteOrigin) {
  return origin?.managed ? managedOwnership(previous, updated, origin) : manualOwnership(previous, updated, fields);
}
function sourceChanged(previous: CanvasBlock, updated: CanvasBlock, forceSource: boolean): boolean {
  return forceSource || previous.content !== updated.content || previous.title !== updated.title || previous.kind !== updated.kind;
}
function mutationMarker(result: CanvasBlock, origin: JevWriteOrigin | undefined, changed: boolean): void {
  if (origin) result.jevMutationId = origin.mutationId;
  else if (changed) delete result.jevMutationId;
}

export function changedJevStamp(previous: CanvasBlock, updated: CanvasBlock, origin?: JevWriteOrigin, forceSource = false): CanvasBlock {
  const stamped = initializeJevStamp(previous);
  const changedSource = sourceChanged(previous, updated, forceSource);
  const fields = metadataFields.filter(field => JSON.stringify(previous[field as keyof CanvasBlock]) !== JSON.stringify(updated[field as keyof CanvasBlock]));
  const result = { ...updated, incarnation: stamped.incarnation,
    sourceGeneration: stamped.sourceGeneration! + Number(changedSource),
    metadataRevision: stamped.metadataRevision! + Number(changedSource || fields.length > 0),
    jevOwnership: ownership(stamped, updated, fields, origin) };
  mutationMarker(result, origin, changedSource || fields.length > 0);
  return result;
}

export function sourceSnapshot(workspaceId: string, canvasId: string, block: CanvasBlock): JevSourceSnapshot {
  if (!block.incarnation) throw new ApiError(409, 'The document needs source reconciliation');
  return { workspaceId, canvasId, blockId: block.id, incarnation: block.incarnation,
    sourceGeneration: block.sourceGeneration!, metadataRevision: block.metadataRevision!, contentHash: contentHash(block.content) };
}

export function checkJevSource(block: CanvasBlock, expected: JevSourceSnapshot): void {
  const current = sourceSnapshot(expected.workspaceId, expected.canvasId, block);
  if (!sameJevSource(current, expected)) {
    throw new ApiError(409, 'The source changed since Symbi Reflex reviewed it');
  }
}

export function sameJevSource(current: JevSourceSnapshot, expected: JevSourceSnapshot): boolean {
  const fields: Array<keyof JevSourceSnapshot> = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'metadataRevision', 'contentHash'];
  return fields.every(field => current[field] === expected[field]);
}
