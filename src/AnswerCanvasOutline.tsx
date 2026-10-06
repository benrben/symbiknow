import type { AnswerCanvasModel } from './useAnswerCanvas';

export function AnswerQuestions({ model }: { model: AnswerCanvasModel }) {
  const { turns, focusedTurnId, focusTurn, graph } = model;
  return <>
    {turns.length > 1 && <nav className="answer-canvas__turn-nav" aria-label="Research questions"><span>RESEARCH PATH</span>
      {turns.map((turn, index) => <button key={turn.id} type="button" aria-current={focusedTurnId === turn.id ? 'step' : undefined}
        aria-label={'Question ' + (index + 1) + ': ' + turn.query} onClick={() => focusTurn(turn.id)}>
        <b>{String(index + 1).padStart(2, '0')}</b><span>{turn.query}</span>
        <small>{graph.blocks.filter(block => block.turnId === turn.id).length} blocks</small>
      </button>)}</nav>}

  </>;
}
export function AnswerOutline({ model }: { model: AnswerCanvasModel }) {
  const { story, focus } = model;
  return <>
    {story.length > 0 && <details className="answer-canvas__outline">
      <summary>Answer outline · {story.length} step{story.length === 1 ? '' : 's'}</summary>
      <nav className="answer-canvas__story" aria-label="Latest answer structure"><span>READ THIS ANSWER</span>
        {story.map((block, index) => <button key={block.id} type="button" onClick={() => focus(block)}
          aria-label={'Step ' + (index + 1) + ': ' + block.title}><b>{index + 1}</b><span>{block.title}</span></button>)}</nav>
    </details>}

  </>;
}
