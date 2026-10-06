import type { AnswerCanvasModel } from './useAnswerCanvas';
import type { AnswerSource } from '../shared/answer-canvas';
import { sourceKey, sourcePassage } from './answer-canvas-helpers';

export function AnswerCanvasEvidence({ model }: { model: AnswerCanvasModel }) {
  const { sources } = model;
  return <>
    {sources.length > 0 && <details className="answer-canvas__evidence" aria-label="Research source evidence">
      <summary>Sources · {sources.length} cited</summary>
      <div className="answer-canvas__evidence-content">
        <SourceList model={model} />
      </div>
    </details>}

  </>;
}
function SourceList({ model }: { model: AnswerCanvasModel }) {
  const { sources, onOpenSource } = model;
  return <>
    {sources.length > 0 && <>
      <p>These passages explain why documents were selected for research. Read the document to verify each answer claim.</p>
      <ul>{sources.map(source => <SourceItem key={sourceKey(source)} source={source} onOpenSource={onOpenSource} />)}</ul>
    </>}

  </>;
}
function SourceItem({ source, onOpenSource }: { source: AnswerSource; onOpenSource: AnswerCanvasModel['onOpenSource'] }) {
  return (
    <li>
      <div><strong>{source.title}</strong><small>{source.canvasName} · {source.evidence?.passageKind === 'exact' ? 'Exact passage' : 'Approximate context'}</small></div>
      <blockquote>{sourcePassage(source)}</blockquote>
      {source.evidence && <small>{source.evidence.claim} · Checked {new Date(source.evidence.checkedAt).toLocaleString()}
        {source.evidence.revision ? ` · Revision ${source.evidence.revision}` : source.evidence.contentHash ? ` · Hash ${source.evidence.contentHash}` : ''}</small>}
      <button type="button" onClick={() => onOpenSource(source)}>Read source ↗</button>
    </li>
  );
}
