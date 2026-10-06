import type { AnswerCanvasProps } from './answer-canvas-types';
import { useEscapeLayer } from './escape-layers';
import type { AnswerCanvasState } from './useAnswerCanvasState';

/** Escape closes the topmost research surface first: editor, comparison, history, reader, then the canvas itself. */
export function useAnswerCanvasKeyboard({ onClose }: AnswerCanvasProps, state: AnswerCanvasState) {
  const { draft, setDraft, readerId, setReaderId, historyOpen, setHistoryOpen, duplicateId, setDuplicateId } = state;
  useEscapeLayer(true, () => {
    if (draft) setDraft(null);
    else if (duplicateId) setDuplicateId('');
    else if (historyOpen) setHistoryOpen(false);
    else if (readerId) setReaderId('');
    else onClose();
  });
}
