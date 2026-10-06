import type { AnswerCanvasProps } from './answer-canvas-types';
import { useAnswerCanvas } from './useAnswerCanvas';
import { AnswerCanvasHeader } from './AnswerCanvasHeader';
import { AnswerQuestions, AnswerOutline } from './AnswerCanvasOutline';
import { AnswerCanvasSearch } from './AnswerCanvasSearch';
import { AnswerCanvasStaging } from './AnswerCanvasStaging';
import { AnswerCanvasEvidence } from './AnswerCanvasEvidence';
import { AnswerCanvasNotices } from './AnswerCanvasNotices';
import { AnswerCanvasWorkspace } from './AnswerCanvasWorkspace';
import { AnswerCanvasEditor } from './AnswerCanvasEditor';
import { AnswerCanvasReader } from './AnswerCanvasReader';
import { AnswerSessionHistory, AnswerDuplicates } from './AnswerCanvasDialogs';
import './answer-canvas.css';

export type { AnswerCanvasProps } from './answer-canvas-types';

export function AnswerCanvas(props: AnswerCanvasProps) {
  const model = useAnswerCanvas(props);
  return <section className="answer-canvas" aria-label="Research canvas">
    <AnswerCanvasHeader model={model} />
    <div className="answer-canvas__controls">
      <AnswerCanvasSearch model={model} /><AnswerQuestions model={model} />
      <AnswerOutline model={model} /><AnswerCanvasEvidence model={model} />
    </div>
    <AnswerCanvasStaging model={model} /><AnswerCanvasNotices model={model} />
    <AnswerCanvasWorkspace model={model} /><AnswerCanvasEditor model={model} />
    <AnswerCanvasReader model={model} />
    <AnswerSessionHistory model={model} /><AnswerDuplicates model={model} />
  </section>;
}
