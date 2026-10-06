import type { AnswerCanvasResult, ChatViewContext } from '../shared/answer-canvas.js';
import type { CanvasStore } from './storage.js';
import { answerSurface, chooseLayout } from './answer-surface.js';
import { candidatesForQuestion } from './answer-retrieval.js';
import { answerSources } from './answer-sources.js';

export async function selectAnswerCanvas(store: CanvasStore, canvasId: string, query: string,
  context: ChatViewContext): Promise<AnswerCanvasResult> {
  const candidates = await candidatesForQuestion(store, canvasId, query, context);
  const surface = answerSurface(query);
  const layout = surface === 'canvas' ? chooseLayout(query) : undefined;
  const sources = answerSources(candidates, query);
  return { query, canvasId, selection: 'local', sources, layout, surface };
}
