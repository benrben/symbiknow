import type { AnswerCanvasModel } from './useAnswerCanvas';

export function AnswerCanvasSearch({ model }: { model: AnswerCanvasModel }) {
  const { searchInput, search, setSearch, matches, focus } = model;
  return <>
    <div className="answer-canvas__tools">
      <label>Find on this canvas<input ref={searchInput} aria-label="Find in research canvas" value={search} onChange={event => setSearch(event.target.value)}
        placeholder="Search answers and notes…" /></label>
      {search && <span>{matches.length} match{matches.length === 1 ? '' : 'es'}</span>}
      <span className="answer-canvas__tools-tip">Drag cards · connect handles · select for details · double-click to edit</span>
    </div>
    {search && <div className="answer-canvas__matches" role="group" aria-label="Research search results">
      {matches.length ? matches.map(block => <button key={block.id} type="button" onClick={() => focus(block)}>{block.title}</button>)
        : <span>No matching blocks</span>}</div>}

  </>;
}
