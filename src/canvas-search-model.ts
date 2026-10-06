import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { SearchHit } from '../shared/types';
import { groupLabel } from '../shared/groups';
import type { CanvasSearchProps, PendingSearchAction, SearchAction, SearchFilters, SearchFilterOptions } from './canvas-search-types';

const allFilters: SearchFilters = { canvas: 'all', group: 'all', tag: 'all', kind: 'all' };

export function searchCanvasName(hit: SearchHit): string { return hit.canvasName || hit.canvasId; }
export function searchResultId(hit: SearchHit): string { return `search-${encodeURIComponent(hit.canvasId)}:${encodeURIComponent(hit.blockId)}`; }

function options(values: string[], label: (value: string) => string) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
    .map(value => ({ value, label: label(value) }));
}

function filterOptions(hits: SearchHit[]): SearchFilterOptions {
  const canvases = new Map(hits.map(hit => [hit.canvasId, { value: hit.canvasId, label: searchCanvasName(hit) }]));
  return {
    canvas: [...canvases.values()].sort((left, right) => left.label.localeCompare(right.label)),
    group: options(hits.map(hit => hit.group ?? ''), groupLabel),
    tag: options(hits.flatMap(hit => hit.tags ?? []), value => value),
    kind: options(hits.map(hit => hit.kind), value => value),
  };
}

function matchesFilter(value: string | undefined, filter: string): boolean {
  return filter === 'all' || value === filter;
}

function matchesTag(hit: SearchHit, tag: string): boolean {
  return tag === 'all' || Boolean(hit.tags?.includes(tag));
}

function matchesFilters(hit: SearchHit, filters: SearchFilters): boolean {
  return matchesFilter(hit.canvasId, filters.canvas) && matchesFilter(hit.group, filters.group)
    && matchesTag(hit, filters.tag) && matchesFilter(hit.kind, filters.kind);
}

function activeHit(props: CanvasSearchProps, hits: SearchHit[], index: number): SearchHit | undefined {
  if (props.loading || props.error || !props.query.trim()) return undefined;
  return hits[Math.min(index, hits.length - 1)];
}

function performAction(props: CanvasSearchProps, { hit, action }: PendingSearchAction) {
  if (action === 'edit') { props.onEdit(hit); return; }
  if (action === 'evidence') { props.onOpenEvidence?.(hit); return; }
  props.onReveal(hit);
}

function scrollToActive(results: HTMLDivElement | null) {
  results?.querySelector<HTMLElement>('.canvas-search__result.is-active')?.scrollIntoView?.({ block: 'nearest' });
}

function useSearchActions(props: CanvasSearchProps, filters: SearchFilters) {
  const [pending, setPending] = useState<PendingSearchAction | null>(null);
  useEffect(() => { setPending(null); }, [props.query, props.hits, props.currentCanvasId, props.loading, props.error, filters]);
  function request(hit: SearchHit, action: SearchAction) {
    if (hit.canvasId !== props.currentCanvasId) { setPending({ hit, action }); return; }
    performAction(props, { hit, action });
  }
  function confirm(action: PendingSearchAction) {
    performAction(props, action);
    setPending(null);
  }
  return { pending, request, confirm, cancel: () => setPending(null) };
}

function useSearchNavigation(props: CanvasSearchProps, filters: SearchFilters, hits: SearchHit[]) {
  const [index, setIndex] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const active = activeHit(props, hits, index);
  useEffect(() => { setIndex(0); }, [props.query, props.hits, props.currentCanvasId, filters]);
  useEffect(() => { scrollToActive(resultsRef.current); }, [index, active?.blockId, active?.canvasId]);
  function step(direction: number) {
    if (props.loading || props.error || !hits.length) return;
    setIndex((index + direction + hits.length) % hits.length);
  }
  return { index, active, resultsRef, inputRef, resultsId, step };
}

function useSearchKeyboard(props: CanvasSearchProps, navigation: ReturnType<typeof useSearchNavigation>, actions: ReturnType<typeof useSearchActions>) {
  function enter(event: KeyboardEvent<HTMLInputElement>) {
    if (!navigation.active) return;
    event.preventDefault();
    actions.request(navigation.active, 'reveal');
  }
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (actions.pending) return;
    const direction = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (direction) { event.preventDefault(); navigation.step(direction); return; }
    if (event.key === 'Enter') enter(event);
  };
}

export function useCanvasSearch(props: CanvasSearchProps) {
  const [filters, setFilters] = useState(allFilters);
  const choices = useMemo(() => filterOptions(props.hits), [props.hits]);
  const filtered = useMemo(() => props.hits.filter(hit => matchesFilters(hit, filters)), [props.hits, filters]);
  const localHits = filtered.filter(hit => hit.canvasId === props.currentCanvasId);
  const otherHits = filtered.filter(hit => hit.canvasId !== props.currentCanvasId);
  const navigable = [...localHits, ...otherHits];
  const actions = useSearchActions(props, filters);
  const navigation = useSearchNavigation(props, filters, navigable);
  const keyDown = useSearchKeyboard(props, navigation, actions);
  function changeFilter(key: keyof SearchFilters, value: string) { setFilters(current => ({ ...current, [key]: value })); }
  return { filters, choices, changeFilter, filtered, localHits, otherHits, navigable, actions, navigation, keyDown };
}
