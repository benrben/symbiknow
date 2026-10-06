import type { AnswerCanvasModel } from './useAnswerCanvas';
import { sourceKey } from './answer-canvas-helpers';

export function AnswerCanvasStaging({ model }: { model: AnswerCanvasModel }) {
  const { latestWorking, latest, onOpenSource } = model;
  return <>
    {latestWorking && <div className="answer-canvas__staging" role="status"><strong>Preparing sources and drawing the next answer…</strong>
      {latest!.sources.map(source => <button key={sourceKey(source)} type="button" onClick={() => onOpenSource(source)}>{source.title} ↗</button>)}</div>}

  </>;
}
