import { groupPath } from '../shared/groups';
import type { CanvasBlock } from '../shared/types';

export type RootGroup = { group: string; title: string; count: number; tone: number };

export type Supergroup = {
  id: string;
  title: string;
  rootGroups: string[];
  count: number;
  topTitles: string[];
  tone: number;
};

/** The extra level is useful only when a root map would be too dense to scan. */
const MIN_SUPERGROUP_ROOTS = 9;
const MAX_ROOTS_PER_SUPERGROUP = 6;

function rootForBlock(block: CanvasBlock): string {
  return block.group ? groupPath(block.group)[0] : '__ungrouped';
}

/**
 * Divide a large canvas into small, stable communities based on document links.
 * Each root group remains in exactly one community, even if its documents have
 * no links. Input ordering and link direction do not affect the result.
 */
export function makeSupergroups(roots: RootGroup[], blocks: CanvasBlock[]): Supergroup[] {
  if (roots.length < MIN_SUPERGROUP_ROOTS) return [];

  const sortedRoots = [...roots].sort((a, b) => a.group.localeCompare(b.group));
  const byGroup = new Map(sortedRoots.map(root => [root.group, root]));
  const blockRoot = new Map(blocks.map(block => [block.id, rootForBlock(block)]));
  const weights = new Map<string, number>();
  const pairKey = (left: string, right: string) => left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

  for (const block of blocks) {
    const from = blockRoot.get(block.id);
    if (!from || !byGroup.has(from)) continue;
    for (const targetId of block.links) {
      const to = blockRoot.get(targetId);
      if (!to || from === to || !byGroup.has(to)) continue;
      const key = pairKey(from, to);
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
  }

  const weight = (left: string, right: string) => weights.get(pairKey(left, right)) ?? 0;
  const degrees = new Map(sortedRoots.map(root => [root.group, 0]));
  for (const [key, count] of weights) {
    const [left, right] = key.split('\u0000');
    degrees.set(left, (degrees.get(left) ?? 0) + count);
    degrees.set(right, (degrees.get(right) ?? 0) + count);
  }
  const degree = (group: string) => degrees.get(group) ?? 0;
  const desiredCount = Math.ceil(sortedRoots.length / MAX_ROOTS_PER_SUPERGROUP);
  const rankedRoots = [...sortedRoots].sort((a, b) => degree(b.group) - degree(a.group) || b.count - a.count || a.group.localeCompare(b.group));

  // Distant seeds keep densely connected regions from starting in the same community.
  const seeds: RootGroup[] = [rankedRoots[0]];
  const seedGroups = new Set([rankedRoots[0].group]);
  const seedAffinity = new Map(sortedRoots.map(root => [root.group, weight(root.group, rankedRoots[0].group)]));
  while (seeds.length < desiredCount) {
    const next = rankedRoots.filter(root => !seedGroups.has(root.group)).sort((a, b) =>
      (seedAffinity.get(a.group) ?? 0) - (seedAffinity.get(b.group) ?? 0)
      || degree(b.group) - degree(a.group) || b.count - a.count || a.group.localeCompare(b.group))[0];
    seeds.push(next);
    seedGroups.add(next.group);
    for (const root of sortedRoots) seedAffinity.set(root.group, (seedAffinity.get(root.group) ?? 0) + weight(root.group, next.group));
  }

  const communities: RootGroup[][] = seeds.map(seed => [seed]);
  for (const root of rankedRoots.filter(candidate => !seedGroups.has(candidate.group))) {
    const destinations = communities
      .map((members, index) => ({ members, index, affinity: members.reduce((sum, member) => sum + weight(root.group, member.group), 0) }))
      .filter(candidate => candidate.members.length < MAX_ROOTS_PER_SUPERGROUP)
      .sort((a, b) => b.affinity - a.affinity || a.members.length - b.members.length || a.members[0].group.localeCompare(b.members[0].group));
    destinations[0].members.push(root);
  }

  const sortedCommunities = communities.map(members => [...members].sort((a, b) => a.group.localeCompare(b.group)))
    .sort((a, b) => b.reduce((sum, root) => sum + root.count, 0) - a.reduce((sum, root) => sum + root.count, 0)
      || a[0].group.localeCompare(b[0].group));

  return sortedCommunities.map((members, index) => {
    const highlights = [...members].sort((a, b) => b.count - a.count
      || members.reduce((sum, other) => sum + weight(b.group, other.group), 0) - members.reduce((sum, other) => sum + weight(a.group, other.group), 0)
      || a.group.localeCompare(b.group));
    const firstTitle = highlights[0].title.replace(/^Engineering /, '');
    return {
      id: `super:${index}`,
      title: firstTitle.charAt(0).toUpperCase() + firstTitle.slice(1),
      rootGroups: members.map(member => member.group),
      count: members.reduce((sum, member) => sum + member.count, 0),
      topTitles: highlights.map(member => member.title),
      tone: highlights[0].tone,
    };
  });
}
