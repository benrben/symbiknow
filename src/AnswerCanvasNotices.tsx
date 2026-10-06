import type { AnswerCanvasModel } from './useAnswerCanvas';

export function AnswerCanvasNotices({ model }: { model: AnswerCanvasModel }) {
  const { saveError, saved, onOpenSavedCanvas, freshness, onRecheck } = model;
  return <>
    {saveError && <div className="answer-canvas__freshness" role="alert">{saveError}</div>}
    {saved && <div className="answer-canvas__saved" role="status">Saved as {saved.name}.
      <button type="button" onClick={() => onOpenSavedCanvas(saved.id, saved.name)}>Open saved canvas ↗</button></div>}
    {freshness === 'changed' && <div className="answer-canvas__freshness" role="status">A cited source changed.
      <button type="button" onClick={onRecheck}>Recheck the latest documents</button></div>}
    {freshness === 'unavailable' && <div className="answer-canvas__freshness" role="status">Source freshness could not be checked right now.</div>}

  </>;
}
