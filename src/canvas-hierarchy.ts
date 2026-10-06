import type { CanvasBlock } from '../shared/types';
import { hierarchyConnections } from './canvas-hierarchy-connections';
import { hierarchyCommunities } from './canvas-hierarchy-communities';
import { presentCommunities } from './canvas-hierarchy-presentation';
import type { RootGroup, Supergroup } from './canvas-hierarchy-types';

export type { RootGroup, Supergroup } from './canvas-hierarchy-types';

/** The extra level is useful only when a root map would be too dense to scan. */
const MIN_SUPERGROUP_ROOTS = 9;

/**
 * Divide a large canvas into small, stable communities based on document links.
 * Each root group remains in exactly one community, even if its documents have
 * no links. Input ordering and link direction do not affect the result.
 */
export function makeSupergroups(roots: RootGroup[], blocks: CanvasBlock[]): Supergroup[] {
  if (roots.length < MIN_SUPERGROUP_ROOTS) return [];
  const sortedRoots = [...roots].sort((a, b) => a.group.localeCompare(b.group));
  const connections = hierarchyConnections(sortedRoots, blocks);
  const communities = hierarchyCommunities(sortedRoots, connections);
  return presentCommunities(communities, connections);
}
