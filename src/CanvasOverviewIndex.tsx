import { countLabel } from './canvas-overview-data';
import type { OverviewGroup } from './canvas-overview-types';

type Props = {
  overview: boolean;
  drill: boolean;
  /** Absent when no search is active, so the legend counts groups instead of reporting zero matches. */
  matchCount?: number;
  roots: OverviewGroup[];
  matches: (group: OverviewGroup) => number;
  onFocus: (group: string) => void;
};

export function CanvasOverviewIndex({ overview, drill, matchCount, roots, matches, onFocus }: Props) {
  return <nav className={`canvas-map-index${overview ? ' is-overview' : ''}${drill ? ' is-drill' : ''}`} aria-label="Mini-map groups">
    <details key={overview ? 'overview' : 'detail'}>
      <summary>Map · {matchCount === undefined ? countLabel(roots.length, 'group', 'groups') : countLabel(matchCount, 'match', 'matches')}</summary>
      <div className="canvas-map-index__list">{roots.map(group => <button key={group.id} type="button" onClick={() => onFocus(group.group)}><span className={`canvas-map-index__dot canvas-map-index__dot--${group.tone}`} />{group.title}<small>{group.count}</small>{matches(group) > 0 && <b aria-label="Search matches in group">●</b>}</button>)}</div>
    </details>
  </nav>;
}
