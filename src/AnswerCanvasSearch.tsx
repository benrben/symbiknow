import type { AnswerCanvasModel } from './useAnswerCanvas';

export function AnswerCanvasSearch({ model }: { model: AnswerCanvasModel }) {
  const { searchInput, search, setSearch, matches, focus } = model;
  return <>
    <div className="answer-canvas__tools">
      <label><input ref={searchInput} aria-label="Find in research canvas" value={search} onChange={event => setSearch(event.target.value)}
        placeholder="Find in research…" /></label>
      {search && <span>{matches.length} match{matches.length === 1 ? '' : 'es'}</span>}
    </div>
    {search && <div className="answer-canvas__matches" role="group" aria-label="Research search results">
      {matches.length ? matches.map(block => <button key={block.id} type="button" onClick={() => focus(block)}>{block.title}</button>)
        : <span>No matching blocks</span>}</div>}

  </>;
}
