import { groupPath } from '../shared/groups';
import type { CanvasBlock } from '../shared/types';
import type { HierarchyConnections, RootGroup } from './canvas-hierarchy-types';

function rootForBlock(block: CanvasBlock): string {
  return block.group ? groupPath(block.group)[0] : '__ungrouped';
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function incrementConnection(from: string, to: string | undefined, roots: Set<string>, weights: Map<string, number>) {
  if (!to || from === to || !roots.has(to)) return;
  const key = pairKey(from, to);
  weights.set(key, (weights.get(key) ?? 0) + 1);
}

function addBlockConnections(block: CanvasBlock, blockRoots: Map<string, string>, roots: Set<string>, weights: Map<string, number>) {
  // Every input block has an entry; duplicate IDs retain the original last-entry behavior.
  const from = blockRoots.get(block.id)!;
  if (!roots.has(from)) return;
  for (const targetId of block.links) incrementConnection(from, blockRoots.get(targetId), roots, weights);
}

function connectionDegrees(weights: Map<string, number>): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const [key, count] of weights) {
    const [left, right] = key.split('\u0000');
    degrees.set(left, (degrees.get(left) ?? 0) + count);
    degrees.set(right, (degrees.get(right) ?? 0) + count);
  }
  return degrees;
}

export function hierarchyConnections(roots: RootGroup[], blocks: CanvasBlock[]): HierarchyConnections {
  const groups = new Set(roots.map(root => root.group));
  const blockRoots = new Map(blocks.map(block => [block.id, rootForBlock(block)]));
  const weights = new Map<string, number>();
  for (const block of blocks) addBlockConnections(block, blockRoots, groups, weights);
  const degrees = connectionDegrees(weights);
  return {
    weight: (left, right) => weights.get(pairKey(left, right)) ?? 0,
    degree: group => degrees.get(group) ?? 0,
  };
}
