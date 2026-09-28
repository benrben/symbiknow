import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '../shared/types';
import { groupLabel } from '../shared/groups';
import './canvas-search.css';

type SearchFilter = 'all' | string;

type Props = {
  query: string;
  hits: SearchHit[];
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  currentCanvasId: string;
  onQuery: (query: string) => void;
  onClose: () => void;
  onReveal: (hit: SearchHit) => void;
  onEdit: (hit: SearchHit) => void;
  onOpenEvidence?: (hit: SearchHit) => void;
  currentContentHashes?: Record<string, string>;
};

function markMatch(value: string, query: string) {
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0 || !query) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}

function selectOptions(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function canvasName(hit: SearchHit): string { return hit.canvasName || hit.canvasId; }

export function CanvasSearch({ query, hits, loading, error, onRetry, currentCanvasId, onQuery, onClose, onReveal, onEdit, onOpenEvidence, currentContentHashes }: Props) {
  const [canvasFilter, setCanvasFilter] = useState<SearchFilter>('all');
  const [groupFilter, setGroupFilter] = useState<SearchFilter>('all');
  const [tagFilter, setTagFilter] = useState<SearchFilter>('all');
  const [kindFilter, setKindFilter] = useState<SearchFilter>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [pendingHit, setPendingHit] = useState<{ hit: SearchHit; action: 'reveal' | 'edit' | 'evidence' } | null>(null);
  const canvasNames = useMemo(() => selectOptions(hits.map(canvasName)), [hits]);
  const groups = useMemo(() => selectOptions(hits.map(hit => hit.group ?? '')), [hits]);
  const tags = useMemo(() => selectOptions(hits.flatMap(hit => hit.tags ?? [])), [hits]);
  const kinds = useMemo(() => selectOptions(hits.map(hit => hit.kind)), [hits]);
  const filtered = useMemo(() => hits.filter(hit =>
    (canvasFilter === 'all' || canvasName(hit) === canvasFilter) &&
    (groupFilter === 'all' || hit.group === groupFilter) &&
    (tagFilter === 'all' || hit.tags?.includes(tagFilter)) &&
    (kindFilter === 'all' || hit.kind === kindFilter)),
  [hits, canvasFilter, groupFilter, tagFilter, kindFilter]);
  const localHits = filtered.filter(hit => hit.canvasId === currentCanvasId);
  const otherHits = filtered.filter(hit => hit.canvasId !== currentCanvasId);
  const navigable = [...localHits, ...otherHits];

  useEffect(() => { setActiveIndex(0); }, [query, hits, canvasFilter, groupFilter, tagFilter, kindFilter]);
  const active = !loading && !error && query.trim() ? navigable[Math.min(activeIndex, navigable.length - 1)] : undefined;
  useEffect(() => { resultsRef.current?.querySelector<HTMLElement>('.canvas-search__result.is-active')?.scrollIntoView?.({ block: 'nearest' }); }, [activeIndex, active?.blockId]);

  function reveal(hit: SearchHit) {
    if (hit.canvasId !== currentCanvasId) { setPendingHit({ hit, action: 'reveal' }); return; }
    onReveal(hit);
  }

  function edit(hit: SearchHit) {
    if (hit.canvasId !== currentCanvasId) { setPendingHit({ hit, action: 'edit' }); return; }
    onEdit(hit);
  }

  function openEvidence(hit: SearchHit) {
    if (!hit.evidence || !onOpenEvidence) return;
    if (hit.canvasId !== currentCanvasId) { setPendingHit({ hit, action: 'evidence' }); return; }
    onOpenEvidence(hit);
  }

  function step(direction: number) {
    if (loading || error || !navigable.length) return;
    const next = (activeIndex + direction + navigable.length) % navigable.length;
    setActiveIndex(next);
  }

  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      reveal(active);
    } else if (event.key === 'Escape') onClose();
  }

  return <aside className="canvas-search" role="dialog" aria-modal="false" aria-label="Search documents">
    <div className="canvas-search__input">
      <span aria-hidden="true">⌕</span>
      <input autoFocus placeholder="Search every Markdown file…" value={query} onChange={event => onQuery(event.target.value)} onKeyDown={keyDown} aria-label="Search every Markdown file"/>
      {query && <button type="button" onClick={() => onQuery('')} aria-label="Clear search">×</button>}
      <button type="button" onClick={onClose} aria-label="Close search">Close</button>
    </div>
    {query.trim() && !loading && !error && <div className="canvas-search__count"><strong>{navigable.length ? Math.min(activeIndex + 1, navigable.length) : 0} of {navigable.length}</strong><span>{localHits.length} on this canvas · {otherHits.length} elsewhere</span>
      <button type="button" onClick={() => step(-1)} disabled={!navigable.length} aria-label="Previous search result">↑</button>
      <button type="button" onClick={() => step(1)} disabled={!navigable.length} aria-label="Next search result">↓</button>
    </div>}
    <div className="canvas-search__filters" aria-label="Filter search results">
      <label>Canvas<select aria-label="Filter by canvas" value={canvasFilter} onChange={event => setCanvasFilter(event.target.value)}><option value="all">All</option>{canvasNames.map(name => <option key={name}>{name}</option>)}</select></label>
      <label>Group<select aria-label="Filter by group" value={groupFilter} onChange={event => setGroupFilter(event.target.value)}><option value="all">All</option>{groups.map(group => <option value={group} key={group}>{groupLabel(group)}</option>)}</select></label>
      <label>Tag<select aria-label="Filter by tag" value={tagFilter} onChange={event => setTagFilter(event.target.value)}><option value="all">All</option>{tags.map(tag => <option key={tag}>{tag}</option>)}</select></label>
      <label>Type<select aria-label="Filter by type" value={kindFilter} onChange={event => setKindFilter(event.target.value)}><option value="all">All</option>{kinds.map(kind => <option key={kind}>{kind}</option>)}</select></label>
    </div>
    <div ref={resultsRef} className="canvas-search__results" role="listbox" aria-label="Search results" aria-activedescendant={active ? `search-${active.canvasId}-${active.blockId}` : undefined}>
      {!query.trim() && <p>Search titles and content across your workspaces.</p>}
      {query.trim() && loading && <p role="status">Searching documents… Results are loading.</p>}
      {query.trim() && !loading && error && <div className="canvas-search__error" role="alert"><p>Search failed: {error}</p><button type="button" onClick={onRetry}>Retry search</button></div>}
      {query.trim() && !loading && !error && !filtered.length && <p>{hits.length ? 'No matching documents for these filters.' : 'No matching documents.'}</p>}
      {!loading && !error && localHits.length > 0 && <section className="canvas-search__section"><h3>On this canvas · {localHits.length}</h3>{localHits.map((hit, index) =>
        <SearchResult key={`${hit.canvasId}:${hit.blockId}`} hit={hit} query={query} selected={index === activeIndex} stale={Boolean(hit.evidence?.contentHash && currentContentHashes?.[`${hit.canvasId}:${hit.blockId}`] && hit.evidence.contentHash !== currentContentHashes[`${hit.canvasId}:${hit.blockId}`])} onReveal={() => reveal(hit)} onEdit={() => edit(hit)} onOpenEvidence={onOpenEvidence ? () => openEvidence(hit) : undefined}/>)}</section>}
      {!loading && !error && otherHits.length > 0 && <section className="canvas-search__section"><h3>Other canvases · {otherHits.length}</h3>{otherHits.map((hit, index) =>
        <SearchResult key={`${hit.canvasId}:${hit.blockId}`} hit={hit} query={query} selected={localHits.length + index === activeIndex} stale={Boolean(hit.evidence?.contentHash && currentContentHashes?.[`${hit.canvasId}:${hit.blockId}`] && hit.evidence.contentHash !== currentContentHashes[`${hit.canvasId}:${hit.blockId}`])} onReveal={() => reveal(hit)} onEdit={() => edit(hit)} onOpenEvidence={onOpenEvidence ? () => openEvidence(hit) : undefined}/>)}</section>}
    </div>
    <p className="canvas-search__hint">↑ ↓ move · Enter show on canvas · Esc close</p>
    {pendingHit && <div className="canvas-search__confirm" role="dialog" aria-label="Switch canvas">
      <strong>Switch to {canvasName(pendingHit.hit)}?</strong>
      <p>{pendingHit.hit.title}{pendingHit.hit.group ? ` · ${groupLabel(pendingHit.hit.group)}` : ''} is on another canvas.</p>
      <div><button type="button" onClick={() => setPendingHit(null)}>Cancel</button><button type="button" onClick={() => { if (pendingHit.action === 'edit') onEdit(pendingHit.hit); else if (pendingHit.action === 'evidence') onOpenEvidence?.(pendingHit.hit); else onReveal(pendingHit.hit); setPendingHit(null); }}>Switch canvas</button></div>
    </div>}
  </aside>;
}

function SearchResult({ hit, query, selected, stale, onReveal, onEdit, onOpenEvidence }: { hit: SearchHit; query: string; selected: boolean; stale: boolean; onReveal: () => void; onEdit: () => void; onOpenEvidence?: () => void }) {
  return <div className={`canvas-search__result${selected ? ' is-active' : ''}`} role="option" aria-selected={selected} id={`search-${hit.canvasId}-${hit.blockId}`}>
    <button type="button" className="canvas-search__result-main" onClick={onReveal} aria-label={`Show ${hit.title} on canvas`}>
      <span className="canvas-search__result-title">{markMatch(hit.title, query)}<em>{hit.matchIn === 'title' ? 'Title match' : 'Body match'}</em></span>
      <span className="canvas-search__location">in {canvasName(hit)}{hit.group ? ` › ${groupLabel(hit.group)}` : ''} · {hit.kind || 'markdown'}</span>
      <span className="canvas-search__excerpt">{markMatch(hit.excerpt, query)}</span>
      {hit.evidence && <span className="canvas-search__provenance">
        <strong>{hit.evidence.passageKind === 'exact' ? 'Exact source passage' : 'Approximate source context'}</strong>
        <span>{hit.evidence.passage}</span>
        <small>Checked {new Date(hit.evidence.checkedAt).toLocaleDateString()}{hit.evidence.contentHash ? ` · Hash ${hit.evidence.contentHash}` : ''}</small>
        {stale && <span className="canvas-search__stale">Document changed since this search. Re-run search before relying on this passage.</span>}
      </span>}
    </button>
    <span className="canvas-search__result-actions"><button type="button" className="canvas-search__edit" onClick={onEdit} aria-label={`Edit ${hit.title}`}>Edit</button>
      {hit.evidence && onOpenEvidence && <button type="button" className="canvas-search__read" onClick={onOpenEvidence} aria-label={stale ? `Read current document ${hit.title}` : `Read cited passage in ${hit.title}`}>{stale ? 'Read current document' : 'Read source'}</button>}</span>
  </div>;
}
