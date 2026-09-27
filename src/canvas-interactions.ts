import type { CanvasBlock } from '../shared/types';
import type { Edge } from '@xyflow/react';
import { groupPath, normalizedGroup } from '../shared/groups';

export type Point = { x: number; y: number };

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

export function arrangeConnected(blocks: CanvasBlock[]): Map<string, Point> {
  const groups = new Map<string, CanvasBlock[]>();
  for (const block of blocks) {
    const key = normalizedGroup(block.group) ?? '__ungrouped';
    groups.set(key, [...(groups.get(key) ?? []), block]);
  }
  const result = new Map<string, Point>();
  const columnsOfGroups = groups.size > 3 ? 3 : groups.size > 1 ? 2 : 1;
  const columnBottoms = Array.from({ length: columnsOfGroups }, () => 0);
  const columnWidth = Math.max(780, ...blocks.map(block => block.width * 2 + 160));
  for (const members of groups.values()) {
    const byId = new Map(members.map(block => [block.id, block]));
    const ordered: CanvasBlock[] = [];
    const seen = new Set<string>();
    for (const start of [...members].sort((a, b) => b.links.length - a.links.length)) {
      const queue = [start.id];
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const block = byId.get(id);
        if (!block) continue;
        ordered.push(block);
        queue.push(...block.links, ...members.filter(item => item.links.includes(id)).map(item => item.id));
      }
    }
    const column = columnBottoms.indexOf(Math.min(...columnBottoms));
    const left = column * columnWidth;
    const top = columnBottoms[column];
    const columns = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const cellWidth = Math.max(...members.map(block => block.width)) + 56;
    const cellHeight = Math.max(...members.map(block => block.height)) + 56;
    ordered.forEach((block, index) => result.set(block.id, {
      x: left + (index % columns) * cellWidth,
      y: top + Math.floor(index / columns) * cellHeight,
    }));
    columnBottoms[column] += Math.ceil(members.length / columns) * cellHeight + 120;
  }
  return result;
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
