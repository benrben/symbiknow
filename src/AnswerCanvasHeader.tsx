import type { AnswerCanvasModel } from './useAnswerCanvas';
import type { ResearchLayout } from '../shared/answer-canvas';
import { layoutNames } from './answer-canvas-helpers';

export function AnswerCanvasHeader({ model }: { model: AnswerCanvasModel }) {
  return <header className="answer-canvas__bar"><CanvasHeading model={model} /><div className="answer-canvas__bar-actions">
    <button type="button" onClick={model.undo} disabled={!model.canUndo}>Undo</button>
    <ViewControls model={model} /><SaveButton model={model} />
    <button type="button" onClick={model.onClose} aria-label="Return to main canvas">← Main graph</button>
  </div></header>;
}
function CanvasHeading({ model }: { model: AnswerCanvasModel }) {
  const { turns, graph, sources } = model;
  return <>
    <div className="answer-canvas__heading">
      <h2 title={turns[0]?.query ?? 'Research'}>{turns[0]?.query ?? 'Research'}</h2>
      <p>{graph.blocks.length} document{graph.blocks.length === 1 ? '' : 's'} · {sources.length} cited source{sources.length === 1 ? '' : 's'} · Unsaved session</p></div>

  </>;
}
function ViewControls({ model }: { model: AnswerCanvasModel }) {
  const { layout, onLayoutChange, exportMarkdown, setHistoryOpen } = model;
  return <>
    <details className="answer-canvas__more"><summary>View & export</summary><div>
      <label className="answer-canvas__layout">Layout <select aria-label="Research layout" value={layout}
        onChange={event => onLayoutChange(event.target.value as ResearchLayout)}>
        {(Object.keys(layoutNames) as ResearchLayout[]).map(value => <option value={value} key={value}>{layoutNames[value]}</option>)}</select></label>
      <button type="button" onClick={exportMarkdown}>Export Markdown</button>
      <button type="button" onClick={() => setHistoryOpen(true)}>Session history</button>
    </div></details>

  </>;
}
function SaveButton({ model }: { model: AnswerCanvasModel }) {
  const { save, saving, graph, hasSavedCopy } = model;
  return <>
    <button type="button" onClick={() => void save()} disabled={saving || !graph.blocks.length}>{saving ? 'Saving…' : hasSavedCopy ? 'Save new copy' : 'Save canvas'}</button>

  </>;
}
