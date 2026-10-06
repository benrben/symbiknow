import type { HierarchyConnections, RootGroup, Supergroup } from './canvas-hierarchy-types';

function communityCount(members: RootGroup[]): number {
  return members.reduce((sum, root) => sum + root.count, 0);
}

function internalAffinity(root: RootGroup, members: RootGroup[], connections: HierarchyConnections): number {
  return members.reduce((sum, other) => sum + connections.weight(root.group, other.group), 0);
}

function communityHighlights(members: RootGroup[], connections: HierarchyConnections): RootGroup[] {
  return [...members].sort((a, b) => b.count - a.count
    || internalAffinity(b, members, connections) - internalAffinity(a, members, connections)
    || a.group.localeCompare(b.group));
}

function presentCommunity(members: RootGroup[], index: number, connections: HierarchyConnections): Supergroup {
  const highlights = communityHighlights(members, connections);
  const firstTitle = highlights[0].title.replace(/^Engineering /, '');
  return {
    id: `super:${index}`,
    title: firstTitle.charAt(0).toUpperCase() + firstTitle.slice(1),
    rootGroups: members.map(member => member.group),
    count: communityCount(members),
    topTitles: highlights.map(member => member.title),
    tone: highlights[0].tone,
  };
}

export function presentCommunities(communities: RootGroup[][], connections: HierarchyConnections): Supergroup[] {
  const sorted = communities.map(members => [...members].sort((a, b) => a.group.localeCompare(b.group)))
    .sort((a, b) => communityCount(b) - communityCount(a) || a[0].group.localeCompare(b[0].group));
  return sorted.map((members, index) => presentCommunity(members, index, connections));
}
