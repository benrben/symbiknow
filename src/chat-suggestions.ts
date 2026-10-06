import type { AnswerCanvasResult, ChatViewContext } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';
import { answerSuggestions } from './chat-suggestion-answer';
import { contextSuggestions, fallbackSuggestions } from './chat-suggestion-context';
import { documentSuggestions } from './chat-suggestion-documents';
import { firstSuggestions } from './chat-suggestion-rules';
import type { ChatSuggestion } from './chat-suggestion-types';

export type { ChatSuggestion } from './chat-suggestion-types';

export function chatSuggestions(canvas: CanvasDocument | null, view: ChatViewContext,
  answerCanvas?: AnswerCanvasResult | null): ChatSuggestion[] {
  const context = { canvas, view, answerCanvas };
  return firstSuggestions(context, [answerSuggestions, documentSuggestions, contextSuggestions])
    ?? fallbackSuggestions(context);
}
