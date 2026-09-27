import type { CanvasBlock } from '../shared/types';
import { normalizedGroup } from '../shared/groups';

/** Reading order on the canvas: groups left to right in rows, then each group's cards top to bottom. */
export function readingSequence(blocks: CanvasBlock[]): CanvasBlock[] {
  const anchors = new Map<string, { x: number; y: number }>();
  for (const block of blocks) {
    const key = normalizedGroup(block.group) ?? `solo:${block.id}`;
    const anchor = anchors.get(key);
    anchors.set(key, anchor ? { x: Math.min(anchor.x, block.x), y: Math.min(anchor.y, block.y) } : { x: block.x, y: block.y });
  }
  const anchor = (block: CanvasBlock) => anchors.get(normalizedGroup(block.group) ?? `solo:${block.id}`)!;
  const row = (y: number) => Math.round(y / 400);
  return [...blocks].sort((a, b) => row(anchor(a).y) - row(anchor(b).y) || anchor(a).x - anchor(b).x || a.y - b.y || a.x - b.x);
}
