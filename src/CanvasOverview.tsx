import { useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasBlock } from '../shared/types';
import { groupPath, normalizedGroup } from '../shared/groups';
import { groupMembers } from './canvas-interactions';

export type OverviewGroup = {
  id: string;
  group: string;
  title: string;
  count: number;
  tone: number;
  depth: number;
  topTitles: string[];
};

type Props = {
  canvasName: string;
  groups: OverviewGroup[];
  blocks: CanvasBlock[];
  searchIds: Set<string>;
  searchQuery: string;
  matchCount: number;
  overview: boolean;
  drill: boolean;
  onFocus: (group: string) => void;
  onZoomWheel: (deltaY: number) => void;
};

export function CanvasOverview({ canvasName, groups, blocks, searchIds, searchQuery, matchCount, overview, drill, onFocus, onZoomWheel }: Props) {
  const boardRef = useRef<HTMLElement>(null);
  const [listOpen, setListOpen] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const roots = useMemo(() => groups.filter(group => group.depth === 0), [groups]);
  const matches = (group: OverviewGroup) => groupMembers(blocks, group.group).filter(block => searchIds.has(block.id)).length;
  const connections = useMemo(() => {
    const rootByBlock = new Map(blocks.map(block => {
      const group = normalizedGroup(block.group) ?? '__ungrouped';
      return [block.id, groupPath(group)[0]];
    }));
    const names = new Map(roots.map(group => [group.group, group.title]));
    const counts = new Map<string, { source: string; target: string; count: number }>();
    for (const block of blocks) for (const targetId of block.links) {
      const from = rootByBlock.get(block.id);
      const to = rootByBlock.get(targetId);
      if (!from || !to || from === to) continue;
      const [source, target] = [from, to].sort();
      const key = `${source}\u0000${target}`;
      const previous = counts.get(key);
      counts.set(key, { source, target, count: (previous?.count ?? 0) + 1 });
    }
    return [...counts.values()].sort((left, right) => right.count - left.count).map(link => ({
      ...link, sourceName: names.get(link.source) ?? link.source, targetName: names.get(link.target) ?? link.target,
    }));
  }, [blocks, roots]);
  const linkCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of connections) {
      counts.set(link.source, (counts.get(link.source) ?? 0) + link.count);
      counts.set(link.target, (counts.get(link.target) ?? 0) + link.count);
    }
    return counts;
  }, [connections]);

  useEffect(() => {
    const board = boardRef.current;
    if (!overview || !board) return;
    const zoom = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onZoomWheel(event.deltaY);
    };
    board.addEventListener('wheel', zoom, { passive: false });
    return () => board.removeEventListener('wheel', zoom);
  }, [overview, onZoomWheel]);

  useEffect(() => { setListOpen(false); }, [canvasName]);

  return <>
    {overview && <button type="button" className="canvas-overview-list-toggle" aria-expanded={listOpen} onClick={() => setListOpen(value => !value)}>{listOpen ? 'Show connections' : 'Browse groups'}</button>}
    {overview && listOpen && <nav ref={boardRef} className={`canvas-overview-board${roots.length <= 6 ? ' is-spacious' : ''}${roots.length <= 4 ? ' is-paired' : ''}`} aria-label="Group overview" title={`${canvasName} groups`}
      onPointerDown={event => {
        if ((event.target as HTMLElement).closest('button, summary, .canvas-overview-board__connections')) return;
        const board = event.currentTarget;
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: board.scrollLeft, top: board.scrollTop };
        board.setPointerCapture(event.pointerId);
        board.classList.add('is-dragging');
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
        event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
      }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.classList.remove('is-dragging');
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={event => { drag.current = null; event.currentTarget.classList.remove('is-dragging'); }}>
      {connections.length > 0 && <section className="canvas-overview-board__connections" aria-label="Connections between groups">
        <div className="canvas-overview-board__connections-heading"><strong>Connections between groups</strong><span>{connections.length} relationships · scroll to explore</span></div>
        <div className="canvas-overview-board__connections-list">{connections.map(link => <span className="canvas-overview-board__connection" key={`${link.source}:${link.target}`} title={`${link.sourceName} and ${link.targetName}: ${link.count} ${link.count === 1 ? 'link' : 'links'}`}>
          <span>{link.sourceName}</span><b aria-label={`${link.count} ${link.count === 1 ? 'link' : 'links'}`}>⟷ {link.count}</b><span>{link.targetName}</span>
        </span>)}</div>
      </section>}
      <div className="canvas-overview-board__grid">{roots.map(group => {
        const found = matches(group);
        return <button type="button" className={`canvas-overview-board__tile canvas-group--tone-${group.tone}${searchQuery.trim() ? found ? ' is-search-match' : ' is-search-dimmed' : ''}`} key={group.id} onClick={() => { setListOpen(false); onFocus(group.group); }}>
          <span className="canvas-overview-board__title"><span className="canvas-overview-board__icon" aria-hidden="true">▤</span><strong>{group.title}</strong><small>{group.count}</small></span>
          <span className="canvas-overview-board__previews">{group.topTitles.map((title, index) => <span className="canvas-overview-board__preview" key={index} title={title}>
            <span className="canvas-overview-board__preview-icon" aria-hidden="true">▤</span><span className="canvas-overview-board__preview-title">{title}</span>
          </span>)}{group.count > group.topTitles.length && <span className="canvas-overview-board__more">+{group.count - group.topTitles.length} more documents</span>}</span>
          {linkCounts.has(group.group) && <span className="canvas-overview-board__relations">⟷ {linkCounts.get(group.group)} links to other groups</span>}
          <span className="canvas-overview-board__open" aria-hidden="true">Explore group <span>↗</span></span>
          {found > 0 && <span className="canvas-overview-board__matches">{found} {found === 1 ? 'match' : 'matches'}</span>}
        </button>;
      })}</div>
    </nav>}
    <nav className={`canvas-map-index${overview ? ' is-overview' : ''}${drill ? ' is-drill' : ''}`} aria-label="Mini-map groups">
      <details key={overview ? 'overview' : 'detail'}>
        <summary>Map · {matchCount} {matchCount === 1 ? 'match' : 'matches'}</summary>
        <div className="canvas-map-index__list">{roots.map(group => <button key={group.id} type="button" onClick={() => onFocus(group.group)}><span className={`canvas-map-index__dot canvas-map-index__dot--${group.tone}`}/>{group.title}<small>{group.count}</small>{matches(group) > 0 && <b aria-label="Search matches in group">●</b>}</button>)}</div>
      </details>
    </nav>
  </>;
}

export function CanvasDrillBoard({ group, groups, blocks, onFocus, onSelect }: {
  group: string;
  groups: OverviewGroup[];
  blocks: CanvasBlock[];
  onFocus: (group: string) => void;
  onSelect: (blockId: string) => void;
}) {
  const frame = groups.find(item => item.group === group);
  const children = groups.filter(item => item.group !== group && groupPath(item.group).length === groupPath(group).length + 1 && groupPath(item.group).includes(group));
  const documents = groupMembers(blocks, group);
  return <div className="canvas-drill-layer"><section className={`canvas-drill-board canvas-group--tone-${frame?.tone ?? 0}`} aria-label={`${frame?.title ?? group} group documents`}>
    <header className="canvas-drill-board__heading"><span aria-hidden="true">▤</span><div><h2>{frame?.title ?? group}</h2><p>{documents.length} {documents.length === 1 ? 'document' : 'documents'}{children.length ? ` · ${children.length} ${children.length === 1 ? 'subgroup' : 'subgroups'}` : ''}</p></div></header>
    <div className="canvas-drill-board__content">
      {children.length > 0 && <div className="canvas-drill-board__children">{children.map(child => <button type="button" key={child.id} onClick={() => onFocus(child.group)}><span aria-hidden="true">▣</span><strong>{child.title}</strong><small>{child.count} docs</small><b aria-hidden="true">›</b></button>)}</div>}
      <div className="canvas-drill-board__section-heading"><strong>Documents in this group</strong><span>Choose a document to see it on the canvas</span></div>
      <div className="canvas-drill-board__documents">{documents.map(block => <button type="button" key={block.id} onClick={() => onSelect(block.id)}>
        <small>{block.kind}{normalizedGroup(block.group) !== group ? ` · ${normalizedGroup(block.group)?.split('/').at(-1)}` : ''}</small>
        <strong>{block.title}</strong>
        <span>{block.content.slice(0, 2400).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/<[^>]*>|[#*`>\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220) || 'Open this document to read more.'}</span>
        <em>View on canvas <span aria-hidden="true">↗</span></em>
      </button>)}</div>
    </div>
  </section></div>;
}
