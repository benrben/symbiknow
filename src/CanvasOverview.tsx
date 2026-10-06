import { useMemo } from 'react';
import { CanvasOverviewIndex } from './CanvasOverviewIndex';
import { groupMatchCount } from './canvas-overview-data';
import type { CanvasOverviewProps, OverviewGroup } from './canvas-overview-types';

export type { OverviewGroup } from './canvas-overview-types';
export { CanvasDrillBoard } from './CanvasDrillBoard';

export function CanvasOverview({ groups, blocks, searchIds, matchCount, overview, drill, onFocus }: CanvasOverviewProps) {
  const roots = useMemo(() => groups.filter(group => group.depth === 0), [groups]);
  const matches = (group: OverviewGroup) => groupMatchCount(blocks, group.group, searchIds);
  return <CanvasOverviewIndex overview={overview} drill={drill} matchCount={searchIds.size ? matchCount : undefined} roots={roots} matches={matches} onFocus={onFocus} />;
}
