import type { SearchHit } from '../shared/types';
import { groupLabel } from '../shared/groups';
import type { CanvasSearchProps, SearchAction } from './canvas-search-types';
import { searchCanvasName, searchResultId } from './canvas-search-model';

function markMatch(value: string, query: string) {
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0 || !query) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}

const retrievalLabels: Record<string, string> = {
  fuzzy_title: 'Similar title', terms: 'Related terms', phrase: 'Phrase match',
};

function matchLabel(hit: SearchHit): string {
  const retrieval = hit.retrieval?.kind;
  if (retrieval && retrievalLabels[retrieval]) return retrievalLabels[retrieval];
  return hit.matchIn === 'title' ? 'Title match' : 'Body match';
}

function isStale(hit: SearchHit, hashes: CanvasSearchProps['currentContentHashes']): boolean {
  const checkedHash = hit.evidence?.contentHash;
  const currentHash = hashes?.[`${hit.canvasId}:${hit.blockId}`];
  return Boolean(checkedHash && currentHash && checkedHash !== currentHash);
}

function SearchProvenance({ evidence, stale }: { evidence: NonNullable<SearchHit['evidence']>; stale: boolean }) {
  return <div className="canvas-search__provenance">
    <strong>{evidence.passageKind === 'exact' ? 'Exact source passage' : 'Approximate source context'}</strong>
    <span>{evidence.passage}</span>
    <small>Checked {new Date(evidence.checkedAt).toLocaleDateString()}{evidence.contentHash ? ` · Hash ${evidence.contentHash}` : ''}</small>
    {stale && <span className="canvas-search__stale">Document changed since this search. Re-run search before relying on this passage.</span>}
  </div>;
}

function EvidenceButton({ hit, stale, onOpen }: { hit: SearchHit; stale: boolean; onOpen?: () => void }) {
  if (!hit.evidence || !onOpen) return null;
  const label = stale ? `Read current document ${hit.title}` : `Read cited passage in ${hit.title}`;
  return <button type="button" className="canvas-search__read" onClick={onOpen} aria-label={label}>{stale ? 'Read current document' : 'Read source'}</button>;
}

type ResultProps = { hit: SearchHit; query: string; selected: boolean; stale: boolean; request: (hit: SearchHit, action: SearchAction) => void; evidenceEnabled: boolean };

function SearchSourceDetails({ hit, stale }: Pick<ResultProps, 'hit' | 'stale'>) {
  if (!hit.evidence) return null;
  return <details className="canvas-search__source-details"><summary>Source details</summary><SearchProvenance evidence={hit.evidence} stale={stale}/></details>;
}

function SearchResultActions({ hit, stale, request, evidenceEnabled }: Omit<ResultProps, 'query' | 'selected'>) {
  return <span className="canvas-search__result-actions">
    <button type="button" className="canvas-search__edit" onClick={() => request(hit, 'edit')} aria-label={`Edit ${hit.title}`}>Edit</button>
    <EvidenceButton hit={hit} stale={stale} onOpen={evidenceEnabled ? () => request(hit, 'evidence') : undefined}/>
  </span>;
}

function resultClass(selected: boolean) { return selected ? 'canvas-search__result is-active' : 'canvas-search__result'; }

function resultKind(hit: SearchHit) { return hit.kind || 'markdown'; }

function cleanExcerpt(excerpt: string): string {
  return excerpt.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(?:\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ').trim();
}

function SearchResult({ hit, query, selected, stale, request, evidenceEnabled }: ResultProps) {
  return <div className={resultClass(selected)} role="option" aria-selected={selected} id={searchResultId(hit)}>
    <div className="canvas-search__result-content">
      <button type="button" className="canvas-search__result-main" onClick={() => request(hit, 'reveal')} aria-label={`Show ${hit.title} on canvas`}>
        <span className="canvas-search__result-title">{markMatch(hit.title, query)}<em>{matchLabel(hit)}</em></span>
        <span className="canvas-search__location">in {searchCanvasName(hit)}{hit.group ? ` › ${groupLabel(hit.group)}` : ''} · {resultKind(hit)}</span>
        <span className="canvas-search__excerpt">{markMatch(cleanExcerpt(hit.excerpt), query)}</span>
      </button>
      <SearchSourceDetails hit={hit} stale={stale}/>
      {stale && <span className="canvas-search__stale-indicator">Source changed since this search</span>}
    </div>
    <SearchResultActions hit={hit} stale={stale} request={request} evidenceEnabled={evidenceEnabled}/>
  </div>;
}

type SectionProps = {
  label: string; hits: SearchHit[]; offset: number; activeIndex: number; query: string;
  hashes: CanvasSearchProps['currentContentHashes']; request: ResultProps['request']; evidenceEnabled: boolean;
};

export function CanvasSearchSection({ label, hits, offset, activeIndex, query, hashes, request, evidenceEnabled }: SectionProps) {
  if (!hits.length) return null;
  return <section className="canvas-search__section"><h3>{label} · {hits.length}</h3>
    {hits.map((hit, index) => <SearchResult key={`${hit.canvasId}:${hit.blockId}`} hit={hit} query={query} selected={offset + index === activeIndex}
      stale={isStale(hit, hashes)} request={request} evidenceEnabled={evidenceEnabled}/>)}
  </section>;
}

export function CanvasSearchStatus({ query, loading, error, onRetry, hits, filteredCount }: CanvasSearchProps & { filteredCount: number }) {
  if (!query.trim()) return <p>Search titles and content across your workspaces.</p>;
  if (loading) return <p role="status">Searching documents… Results are loading.</p>;
  if (error) return <div className="canvas-search__error" role="alert"><p>Search failed: {error}</p><button type="button" onClick={onRetry}>Retry search</button></div>;
  return <EmptyResults total={hits.length} filtered={filteredCount}/>;
}

function EmptyResults({ total, filtered }: { total: number; filtered: number }) {
  if (filtered) return null;
  return <p>{total ? 'No matching documents for these filters.' : 'No matching documents.'}</p>;
}
