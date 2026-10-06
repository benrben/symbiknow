import { groupPath, normalizedGroup } from '../shared/groups';
import type { CanvasBlock } from '../shared/types';

export type DrillPositions = Map<string, { x: number; y: number }>;

const gap = 48;
/** A group whose bounding box is this many times larger than its cards needs is too spread out to read. */
const sparseRatio = 3;

function inGroup(block: CanvasBlock, group: string): boolean {
  const key = normalizedGroup(block.group);
  return key ? groupPath(key).includes(group) : group === '__ungrouped';
}

function bounds(blocks: CanvasBlock[]) {
  return {
    left: Math.min(...blocks.map(block => block.x)), top: Math.min(...blocks.map(block => block.y)),
    right: Math.max(...blocks.map(block => block.x + block.width)), bottom: Math.max(...blocks.map(block => block.y + block.height)),
  };
}

function isSparse(blocks: CanvasBlock[]): boolean {
  const { left, top, right, bottom } = bounds(blocks);
  const needed = blocks.reduce((total, block) => total + (block.width + gap) * (block.height + gap), 0);
  return (right - left) * (bottom - top) > needed * sparseRatio;
}

function readingOrder(left: CanvasBlock, right: CanvasBlock): number {
  return (normalizedGroup(left.group) ?? '').localeCompare(normalizedGroup(right.group) ?? '') || left.y - right.y || left.x - right.x;
}

/**
 * Groups made by automatic organization keep each document's place on the whole canvas, which can leave a
 * group scattered far apart. Inside the group, show a sparse group packed in reading order; saved positions are untouched.
 */
export function drillLayout(blocks: CanvasBlock[], group: string): DrillPositions {
  const members = group ? blocks.filter(block => inGroup(block, group)) : [];
  if (members.length < 2 || !isSparse(members)) return new Map();
  const ordered = [...members].sort(readingOrder);
  const columns = Math.ceil(Math.sqrt(ordered.length));
  const cellWidth = Math.max(...ordered.map(block => block.width)) + gap;
  const cellHeight = Math.max(...ordered.map(block => block.height)) + gap;
  const { left, top } = bounds(members);
  return new Map(ordered.map((block, index) => [block.id,
    { x: left + (index % columns) * cellWidth, y: top + Math.floor(index / columns) * cellHeight }]));
}

/** A card the person has moved in this session keeps the place they gave it. */
export function drillPosition(positions: DrillPositions, node: { id: string; position: { x: number; y: number }; data: { block: CanvasBlock } }) {
  const packed = positions.get(node.id);
  const unmoved = node.position.x === node.data.block.x && node.position.y === node.data.block.y;
  return packed && unmoved ? packed : node.position;
}

type Box = { x: number; y: number; width: number; height: number };
type View = { width: number; height: number };

function packedBox(blocks: CanvasBlock[], positions: DrillPositions): Box {
  const placed = blocks.filter(block => positions.has(block.id)).map(block => ({ ...block, ...positions.get(block.id)! }));
  const { left, top, right, bottom } = bounds(placed);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function fittedZoom(box: Box, view: View): number {
  // Before the surface is measured there is nothing to fit, so keep the usual reading zoom.
  if (!view.width || !view.height) return 0.8;
  return Math.min(0.8, Math.max(0.4, Math.min(view.width / (box.width + 96), view.height / (box.height + 160))));
}

/** Where the camera goes when entering a group: the middle of what is actually shown, zoomed to fit it. */
export function drillCamera(blocks: CanvasBlock[], group: string, frame: Box | undefined, view: View) {
  const positions = drillLayout(blocks, group);
  const box = positions.size ? packedBox(blocks, positions) : frame;
  if (!box) return undefined;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: fittedZoom(box, view) };
}
