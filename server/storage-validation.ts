import type { BlockKind, CanvasBlock, CrossLink, DocumentGroup, LinkRelation } from '../shared/types.js';
import { validGroupKey } from '../shared/groups.js';
import { loaderFor } from '../shared/file-transfer.js';
import { ApiError } from './errors.js';
import { contentHash, validId } from './storage-shapes.js';
import { freshness } from './storage-jev-fields.js';

const kinds: BlockKind[] = ['markdown', 'slides', 'website', 'mdx'];
const linkRelations = new Set<LinkRelation>(['prerequisite', 'implements', 'decision_for', 'supersedes',
  'contradicts', 'example_of', 'same_topic', 'related']);
type BlockPosition = { blockId: string; x: number; y: number; group?: DocumentGroup | null };
type ContentChange = { expectedContentHash?: unknown };

export function optionalLabel(value: unknown, field: string, previous: string | undefined): string | undefined {
  if (value === undefined) return previous;
  if (value === null) return undefined;
  if (typeof value !== 'string' || value.length > 80) throw new ApiError(400, `${field} must be a string of at most 80 characters`);
  return value.trim() || undefined;
}

export function optionalGroup(value: unknown, previous: DocumentGroup | undefined): DocumentGroup | undefined {
  if (value === undefined) return previous;
  if (value === null || value === '') return undefined;
  if (!validGroupKey(value)) throw new ApiError(400, 'group must be a lane:, area:, purpose:, or custom: key with up to eight path segments');
  return value;
}

function validTag(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= 40 && !/[\x00-\x1f\x7f]/.test(value);
}

function uniqueTags(tags: string[]): string[] {
  const unique = new Map<string, string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!unique.has(trimmed.toLocaleLowerCase())) unique.set(trimmed.toLocaleLowerCase(), trimmed);
  }
  return [...unique.values()];
}

export function optionalTags(value: unknown, previous: string[] | undefined): string[] | undefined {
  if (value === undefined) return previous;
  if (!Array.isArray(value) || value.length > 20 || !value.every(validTag)) {
    throw new ApiError(400, 'tags must be an array of at most 20 nonempty labels, each at most 40 characters');
  }
  return uniqueTags(value);
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function linkTypeEntries(value: unknown, previous: Record<string, LinkRelation> | undefined, links: string[]): [string, unknown][] {
  const entries = Object.entries((value ?? previous ?? {}) as Record<string, unknown>);
  return entries.filter(([id]) => value !== undefined || links.includes(id));
}

export function optionalLinkTypes(value: unknown, previous: Record<string, LinkRelation> | undefined, links: string[]): Record<string, LinkRelation> | undefined {
  if (value === null) return undefined;
  if (value !== undefined && !recordValue(value)) throw new ApiError(400, 'linkTypes must be an object');
  const entries = linkTypeEntries(value, previous, links);
  checkLinkTypeEntries(entries, links);
  return entries.length ? Object.fromEntries(entries) as Record<string, LinkRelation> : undefined;
}
function checkLinkTypeEntries(entries: [string, unknown][], links: string[]): void {
  if (entries.length > 100 || entries.some(([id, relation]) => !links.includes(id) || !linkRelations.has(relation as LinkRelation))) {
    throw new ApiError(400, 'linkTypes must name saved links and supported relations');
  }
}

function crossLinkReference(link: Record<string, unknown>): link is Record<string, unknown> & { canvasId: string; blockId: string } {
  return typeof link.canvasId === 'string' && validId(link.canvasId) && typeof link.blockId === 'string' && validId(link.blockId);
}

function crossLinkRelation(value: unknown): LinkRelation | undefined {
  if (value === undefined) return undefined;
  if (!linkRelations.has(value as LinkRelation)) throw new ApiError(400, 'Invalid cross link');
  return value as LinkRelation;
}

function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function crossLinkConfidence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!validScore(value)) throw new ApiError(400, 'Invalid cross link');
  return value;
}

function crossLink(value: unknown): CrossLink {
  if (!recordValue(value)) throw new ApiError(400, 'Invalid cross link');
  if (!crossLinkReference(value)) throw new ApiError(400, 'Invalid cross link');
  const relation = crossLinkRelation(value.relation);
  const confidence = crossLinkConfidence(value.confidence);
  const result: CrossLink = { canvasId: value.canvasId, blockId: value.blockId };
  if (relation) result.relation = relation;
  if (confidence !== undefined) result.confidence = confidence;
  return result;
}

export function optionalCrossLinks(value: unknown, previous: CrossLink[] | undefined): CrossLink[] | undefined {
  if (value === undefined) return previous;
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, 'crossLinks must contain at most 20 links');
  return uniqueCrossLinks(value);
}

function uniqueCrossLinks(value: unknown[]): CrossLink[] | undefined {
  const links = new Map<string, CrossLink>();
  for (const candidate of value) {
    const link = crossLink(candidate);
    const key = `${link.canvasId}:${link.blockId}`;
    if (!links.has(key)) links.set(key, link);
  }
  return links.size ? [...links.values()] : undefined;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function optionalQuality(value: unknown, previous: CanvasBlock['quality']): CanvasBlock['quality'] {
  if (value === undefined) return previous;
  if (!recordValue(value)) throw new ApiError(400, 'Invalid quality score');
  if (!validScore(value.score) || !validDate(value.at)) throw new ApiError(400, 'Invalid quality score');
  return { score: value.score, at: value.at };
}

export function optionalBoolean(value: unknown, previous: boolean | undefined, field: string): boolean | undefined {
  if (value === undefined) return previous;
  if (value === null) return undefined;
  if (typeof value !== 'boolean') throw new ApiError(400, `${field} must be a boolean or null`);
  return value;
}

export function requiredText(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ApiError(400, `${field} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

export function contentText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1_000_000) {
    throw new ApiError(400, 'content must be a string of at most 1 MB');
  }
  return value;
}

export function coordinate(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new ApiError(400, `${field} must be a finite number within 1,000,000`);
  }
  return value;
}

export function dimension(value: unknown, field: string, fallback: number): number {
  const number = coordinate(value, field, fallback);
  if (number < 100 || number > 5000) throw new ApiError(400, `${field} must be between 100 and 5000`);
  return number;
}

function candidatePosition(index: number, origin: { x: number; y: number }): { x: number; y: number } {
  const horizontal = (index % 6) * 432;
  const vertical = Math.floor(index / 6) * 352;
  const x = origin.x + horizontal > 1_000_000 ? origin.x - horizontal : origin.x + horizontal;
  const y = origin.y + vertical > 1_000_000 ? origin.y - vertical : origin.y + vertical;
  return { x, y };
}

function positionWithinBounds(position: { x: number; y: number }): boolean {
  return Math.abs(position.x) <= 1_000_000 && Math.abs(position.y) <= 1_000_000;
}

function positionCollides(position: { x: number; y: number }, block: CanvasBlock): boolean {
  const gap = 32;
  return position.x < block.x + block.width + gap && position.x + 400 + gap > block.x &&
    position.y < block.y + block.height + gap && position.y + 320 + gap > block.y;
}

export function freeBlockPosition(blocks: CanvasBlock[], origin: { x: number; y: number }): { x: number; y: number } {
  for (let index = 0; index < (blocks.length + 1) * 100; index++) {
    const position = candidatePosition(index, origin);
    if (!positionWithinBounds(position)) continue;
    if (!blocks.some(block => positionCollides(position, block))) return position;
  }
  throw new ApiError(409, 'No free position is available near the requested coordinates');
}

export function blockKind(value: unknown): BlockKind {
  if (value === undefined) return 'markdown';
  if (!kinds.includes(value as BlockKind)) throw new ApiError(400, 'Unsupported block kind');
  return value as BlockKind;
}

export function validLinks(links: unknown, blockId: string, blocks: CanvasBlock[]): links is string[] {
  return Array.isArray(links) && links.every(link =>
    typeof link === 'string' && validId(link) && link !== blockId && blocks.some(block => block.id === link));
}

export function updatedBlock(previous: CanvasBlock, input: Record<string, unknown>, blocks: CanvasBlock[]): CanvasBlock {
  const links = input.links === undefined ? previous.links : input.links;
  if (!validLinks(links, previous.id, blocks)) {
    throw new ApiError(400, 'links must contain existing block IDs on this canvas');
  }
  return {
    ...previous,
    title: input.title === undefined ? previous.title : requiredText(input.title, 'title'),
    ...(() => {
      const content = input.content === undefined ? previous.content : contentText(input.content);
      return { content, kind: loaderFor(input.kind === undefined ? previous.kind : blockKind(input.kind), content) };
    })(),
    x: coordinate(input.x, 'x', previous.x),
    y: coordinate(input.y, 'y', previous.y),
    width: dimension(input.width, 'width', previous.width),
    height: dimension(input.height, 'height', previous.height),
    links,
    linkTypes: optionalLinkTypes(input.linkTypes, previous.linkTypes, links),
    crossLinks: optionalCrossLinks(input.crossLinks, previous.crossLinks),
    quality: optionalQuality(input.quality, previous.quality),
    archived: optionalBoolean(input.archived, previous.archived, 'archived'),
    stale: optionalBoolean(input.stale, previous.stale, 'stale'),
    tags: optionalTags(input.tags, previous.tags),
    purpose: optionalLabel(input.purpose, 'purpose', previous.purpose),
    reviewer: optionalLabel(input.reviewer, 'reviewer', previous.reviewer),
    workArea: optionalLabel(input.workArea, 'workArea', previous.workArea),
    group: optionalGroup(input.group, previous.group),
    headline: optionalLabel(input.headline, 'headline', previous.headline),
    freshness: freshness(input.freshness, previous.freshness),
    processingExcluded: optionalBoolean(input.processingExcluded, previous.processingExcluded, 'processingExcluded'),
  };
}

export function requiredCoordinate(value: unknown, field: string): number {
  if (value === undefined) throw new ApiError(400, `${field} is required`);
  return coordinate(value, field, 0);
}

function layoutGroup(value: unknown): DocumentGroup | null {
  if (value === null) return null;
  return optionalGroup(value, undefined) ?? null;
}

export function blockPosition(value: unknown): BlockPosition {
  if (!value || typeof value !== 'object') throw new ApiError(400, 'Invalid layout position');
  const entry = value as Record<string, unknown>;
  if (typeof entry.blockId !== 'string' || !validId(entry.blockId)) throw new ApiError(400, 'Invalid layout block ID');
  const result: BlockPosition = { blockId: entry.blockId, x: requiredCoordinate(entry.x, 'x'), y: requiredCoordinate(entry.y, 'y') };
  if (entry.group !== undefined) result.group = layoutGroup(entry.group);
  return result;
}

export function validPositions(value: unknown): BlockPosition[] {
  if (!Array.isArray(value) || value.length < 1) throw new ApiError(400, 'positions must contain at least one block');
  const positions = value.map(blockPosition);
  if (new Set(positions.map(item => item.blockId)).size !== positions.length) throw new ApiError(400, 'Layout contains duplicate blocks');
  return positions;
}

export function checkExpectedHash(input: ContentChange, current: string): void {
  if (input.expectedContentHash === undefined) return;
  if (typeof input.expectedContentHash !== 'string' || input.expectedContentHash !== contentHash(current)) {
    throw new ApiError(409, 'This document changed since you read it. Read it again and reapply your edit.',
      { currentContentHash: contentHash(current) });
  }
}

export function protectedChange(input: Record<string, unknown>): boolean {
  return input.content !== undefined || input.title !== undefined || input.kind !== undefined;
}
