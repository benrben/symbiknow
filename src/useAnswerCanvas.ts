import type { AnswerCanvasProps } from './answer-canvas-types';
import { useAnswerCanvasGraph } from './useAnswerCanvasGraph';
import { useAnswerCanvasState } from './useAnswerCanvasState';
import { useAnswerCanvasFocus } from './useAnswerCanvasFocus';
import { useAnswerSourceFreshness } from './useAnswerSourceFreshness';
import { useAnswerCanvasKeyboard } from './useAnswerCanvasKeyboard';
import { useAnswerCanvasEditing } from './useAnswerCanvasEditing';
import { useAnswerCanvasActions } from './useAnswerCanvasActions';
import { useAnswerCanvasSave } from './useAnswerCanvasSave';
import { answerCanvasSelection } from './answer-canvas-selection';

export function useAnswerCanvas(props: AnswerCanvasProps) {
  const data = useAnswerCanvasGraph(props);
  const state = useAnswerCanvasState(props, data);
  const focus = useAnswerCanvasFocus(props, data, state);
  useAnswerSourceFreshness(data.sources, state.setFreshness);
  useAnswerCanvasKeyboard(props, state);
  const editing = useAnswerCanvasEditing(props, data, state, focus);
  useAnswerCanvasActions(props, state, focus, editing);
  const save = useAnswerCanvasSave(props, state);
  const selection = answerCanvasSelection(data.graph, state.search, state.duplicateId);
  const readerIndex = data.canvas.blocks.findIndex(block => block.id === state.readerId);
  const reader = data.canvas.blocks[readerIndex];
  const latestWorking = data.latest?.status === 'working' && !data.latest.patch;
  return { ...props, ...data, ...state, ...focus, ...editing, ...save, ...selection, readerIndex, reader, latestWorking };
}
export type AnswerCanvasModel = ReturnType<typeof useAnswerCanvas>;
