import type { AnswerCanvasModel } from './useAnswerCanvas';

export function AnswerSessionHistory({ model }: { model: AnswerCanvasModel }) {
  const { historyOpen, historyCount, canUndo, undo, setHistoryOpen } = model;
  return <>
    {historyOpen && <div className="answer-canvas__small-dialog" role="dialog" aria-modal="true" aria-label="Session history">
      <h2>Session history</h2><p>{historyCount ? historyCount + ' manual action' + (historyCount === 1 ? '' : 's') + ' in this session. Undo them one at a time.' : 'No manual changes yet.'}</p>
      <button type="button" disabled={!canUndo} onClick={undo}>Undo last action</button>
      <button type="button" onClick={() => setHistoryOpen(false)}>Close</button></div>}

  </>;
}
export function AnswerDuplicates({ model }: { model: AnswerCanvasModel }) {
  const { candidate, similar, setDuplicateId, focus, duplicateBlock } = model;
  return <>
    {candidate && <div className="answer-canvas__small-dialog" role="dialog" aria-modal="true" aria-label="Compare similar research blocks">
      <h2>Similar blocks</h2><p>{similar.length ? 'Review possible duplicates in this research session.' : 'No similar blocks found in this session.'}</p>
      {similar.map(block => <button key={block.id} type="button" onClick={() => {
        setDuplicateId('');
        focus(block);
      }}>{block.title}</button>)}
      <button type="button" onClick={() => duplicateBlock(candidate)}>Duplicate this block</button>
      <button type="button" onClick={() => setDuplicateId('')}>Close</button></div>}

  </>;
}
