import type { HierarchyConnections, RootGroup } from './canvas-hierarchy-types';

const MAX_ROOTS_PER_SUPERGROUP = 6;
type Destination = { members: RootGroup[]; index: number; affinity: number };

function compareRankedRoots(a: RootGroup, b: RootGroup, connections: HierarchyConnections): number {
  return connections.degree(b.group) - connections.degree(a.group) || b.count - a.count || a.group.localeCompare(b.group);
}

function initialAffinities(roots: RootGroup[], seed: RootGroup, connections: HierarchyConnections): Map<string, number> {
  const affinities = new Map<string, number>();
  for (const root of roots) {
    const value = connections.weight(root.group, seed.group);
    // Disconnected roots use the same zero default without storing redundant entries.
    if (value) affinities.set(root.group, value);
  }
  return affinities;
}

function seedAffinity(affinities: Map<string, number>, group: string): number {
  return affinities.get(group) ?? 0;
}

function nextSeed(ranked: RootGroup[], seeded: Set<string>, affinities: Map<string, number>, connections: HierarchyConnections): RootGroup {
  return ranked.filter(root => !seeded.has(root.group)).sort((a, b) =>
    seedAffinity(affinities, a.group) - seedAffinity(affinities, b.group) || compareRankedRoots(a, b, connections))[0];
}

function updateAffinities(roots: RootGroup[], seed: RootGroup, affinities: Map<string, number>, connections: HierarchyConnections) {
  for (const root of roots) affinities.set(root.group, seedAffinity(affinities, root.group) + connections.weight(root.group, seed.group));
}

function communitySeeds(sorted: RootGroup[], ranked: RootGroup[], connections: HierarchyConnections): RootGroup[] {
  const desiredCount = Math.ceil(sorted.length / MAX_ROOTS_PER_SUPERGROUP);
  const seeds = [ranked[0]];
  const seeded = new Set([ranked[0].group]);
  const affinities = initialAffinities(sorted, ranked[0], connections);
  // Distant seeds keep densely connected regions from starting in the same community.
  while (seeds.length < desiredCount) {
    const next = nextSeed(ranked, seeded, affinities, connections);
    seeds.push(next);
    seeded.add(next.group);
    updateAffinities(sorted, next, affinities, connections);
  }
  return seeds;
}

function compareDestinations(a: Destination, b: Destination): number {
  return b.affinity - a.affinity || a.members.length - b.members.length || a.members[0].group.localeCompare(b.members[0].group);
}

function destinationFor(root: RootGroup, communities: RootGroup[][], connections: HierarchyConnections): RootGroup[] {
  const destinations = communities.map((members, index) => ({
    members, index,
    affinity: members.reduce((sum, member) => sum + connections.weight(root.group, member.group), 0)
  }))
    .filter(candidate => candidate.members.length < MAX_ROOTS_PER_SUPERGROUP)
    .sort(compareDestinations);
  // The seed count reserves enough capacity to place every root within the cap.
  return destinations[0].members;
}

export function hierarchyCommunities(sortedRoots: RootGroup[], connections: HierarchyConnections): RootGroup[][] {
  const rankedRoots = [...sortedRoots].sort((a, b) => compareRankedRoots(a, b, connections));
  const seeds = communitySeeds(sortedRoots, rankedRoots, connections);
  const seeded = new Set(seeds.map(seed => seed.group));
  const communities = seeds.map(seed => [seed]);
  for (const root of rankedRoots.filter(candidate => !seeded.has(candidate.group))) destinationFor(root, communities, connections).push(root);
  return communities;
}
