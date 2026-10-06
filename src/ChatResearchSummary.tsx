import type { TurnMessageProps } from './chat-message-types';

export function ResearchSummary({ turn, onOpenAnswerCanvas }: Pick<TurnMessageProps, 'turn' | 'onOpenAnswerCanvas'>) {
  return <>
    {(turn.answerCanvas || turn.researchPatch) && <button className="ai-chat__source-button" type="button" onClick={onOpenAnswerCanvas}>
      Open research canvas · {turn.researchPatch?.blocks.length ?? 0} new block{turn.researchPatch?.blocks.length === 1 ? '' : 's'} ↗
    </button>}

  </>;
}
