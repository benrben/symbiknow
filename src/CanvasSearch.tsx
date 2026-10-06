import type { CanvasSearchProps } from './canvas-search-types';
import { searchResultId, useCanvasSearch } from './canvas-search-model';
import { CanvasSearchConfirmation } from './CanvasSearchConfirmation';
import { CanvasSearchFilters } from './CanvasSearchFilters';
import { CanvasSearchSection, CanvasSearchStatus } from './CanvasSearchResults';
import { useEscapeLayer } from './escape-layers';
import './canvas-search.css';

type SearchModel = ReturnType<typeof useCanvasSearch>;

function SearchInput({ props, model }: { props: CanvasSearchProps; model: SearchModel }) {
  const activeId = model.navigation.active ? searchResultId(model.navigation.active) : undefined;
  return <div className="canvas-search__input">
    <span aria-hidden="true">⌕</span>
    <input ref={model.navigation.inputRef} autoFocus placeholder="Search every Markdown file…" value={props.query} onChange={event => props.onQuery(event.target.value)}
      onKeyDown={model.keyDown} aria-label="Search every Markdown file" aria-controls={model.navigation.resultsId} aria-activedescendant={activeId}/>
    {props.query && <button type="button" onClick={() => props.onQuery('')} aria-label="Clear search">×</button>}
    <button type="button" onClick={props.onClose} aria-label="Close search">Close</button>
  </div>;
}

function showCount(props: CanvasSearchProps): boolean {
  return Boolean(props.query.trim() && !props.loading && !props.error);
}

function SearchCount({ props, model }: { props: CanvasSearchProps; model: SearchModel }) {
  const total = model.navigable.length;
  if (!showCount(props)) return null;
  return <div className="canvas-search__count">
    <strong>{total ? Math.min(model.navigation.index + 1, total) : 0} of {total}</strong>
    <span>{model.localHits.length} on this canvas · {model.otherHits.length} elsewhere</span>
    <button type="button" onClick={() => model.navigation.step(-1)} disabled={!total} aria-label="Previous search result">↑</button>
    <button type="button" onClick={() => model.navigation.step(1)} disabled={!total} aria-label="Next search result">↓</button>
  </div>;
}

function SearchSections({ props, model }: { props: CanvasSearchProps; model: SearchModel }) {
  if (props.loading || props.error) return null;
  const shared = { activeIndex: model.navigation.index, query: props.query, hashes: props.currentContentHashes,
    request: model.actions.request, evidenceEnabled: Boolean(props.onOpenEvidence) };
  return <>
    <CanvasSearchSection {...shared} label="On this canvas" hits={model.localHits} offset={0}/>
    <CanvasSearchSection {...shared} label="Other canvases" hits={model.otherHits} offset={model.localHits.length}/>
  </>;
}

function SearchConfirmation({ model }: { model: SearchModel }) {
  const pending = model.actions.pending;
  if (!pending) return null;
  return <CanvasSearchConfirmation hit={pending.hit} fallbackFocus={model.navigation.inputRef} onCancel={model.actions.cancel} onConfirm={() => model.actions.confirm(pending)}/>;
}

export function CanvasSearch(props: CanvasSearchProps) {
  const model = useCanvasSearch(props);
  useEscapeLayer(true, props.onClose);
  const activeId = model.navigation.active ? searchResultId(model.navigation.active) : undefined;
  return <aside className="canvas-search" role="dialog" aria-modal="false" aria-label="Search documents">
    <SearchInput props={props} model={model}/>
    <SearchCount props={props} model={model}/>
    <CanvasSearchFilters filters={model.filters} choices={model.choices} onChange={model.changeFilter}/>
    <div ref={model.navigation.resultsRef} id={model.navigation.resultsId} className="canvas-search__results" role="listbox" aria-label="Search results" aria-activedescendant={activeId}>
      <CanvasSearchStatus {...props} filteredCount={model.filtered.length}/>
      <SearchSections props={props} model={model}/>
    </div>
    <p className="canvas-search__hint">↑ ↓ move · Enter show on canvas · Esc close</p>
    <SearchConfirmation model={model}/>
  </aside>;
}
