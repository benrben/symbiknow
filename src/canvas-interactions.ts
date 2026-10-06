import type { CanvasBlock } from '../shared/types';
import type { Edge } from '@xyflow/react';
import { groupPath, normalizedGroup } from '../shared/groups';
import type { Point } from './canvas-interaction-types';

export type { Point } from './canvas-interaction-types';

export function focusedEdges(edges: Edge[], ids: Set<string>): Edge[] {
  return edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
    .map(edge => ({ ...edge, style: { ...edge.style, strokeWidth: 2.5, opacity: 0.85 } }));
}

export function relatedIds(blocks: CanvasBlock[], selectedId: string, hops: 1 | 2): Set<string> {
  const neighbors = new Map(blocks.map(block => [block.id, new Set<string>()]));
  for (const block of blocks) for (const target of block.links) {
    neighbors.get(block.id)?.add(target);
    neighbors.get(target)?.add(block.id);
  }
  const result = new Set([selectedId]);
  let frontier = [selectedId];
  for (let step = 0; step < hops; step += 1) {
    frontier = frontier.flatMap(id => [...(neighbors.get(id) ?? [])].filter(target => !result.has(target)));
    frontier.forEach(id => result.add(id));
  }
  return result;
}

export function groupMembers(blocks: CanvasBlock[], group: string): CanvasBlock[] {
  if (group === '__ungrouped') return blocks.filter(block => !normalizedGroup(block.group));
  return blocks.filter(block => groupPath(normalizedGroup(block.group) ?? '').includes(group));
}

export function pullNeighbors(blocks: CanvasBlock[], selectedId: string, hops: 1 | 2): Map<string, Point> {
  const center = blocks.find(block => block.id === selectedId);
  if (!center) return new Map();
  const neighbors = [...relatedIds(blocks, selectedId, hops)].filter(id => id !== selectedId);
  const radius = Math.max(center.width, center.height) + 120;
  return new Map(neighbors.map((id, index) => {
    const angle = (index / Math.max(1, neighbors.length)) * Math.PI * 2;
    return [id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }];
  }));
}
