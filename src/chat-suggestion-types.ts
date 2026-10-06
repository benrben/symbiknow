import type { AnswerCanvasResult, ChatViewContext } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';

export type ChatSuggestion = { title: string; detail: string };
export type SuggestionContext = {
  canvas: CanvasDocument | null;
  view: ChatViewContext;
  answerCanvas?: AnswerCanvasResult | null;
};
export type SuggestionRule = (context: SuggestionContext) => ChatSuggestion[] | null;
