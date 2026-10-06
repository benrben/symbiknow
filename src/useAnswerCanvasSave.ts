import { exportEditedResearchMarkdown } from './research-edits';
import type { AnswerCanvasProps } from './answer-canvas-types';
import type { AnswerCanvasState } from './useAnswerCanvasState';

export function useAnswerCanvasSave({ turns, layout, edits, onSave, onUndo }: AnswerCanvasProps, state: AnswerCanvasState) {
  const { saving, setSaving, setSaveError, setSaved, live, snapshot } = state;
  const exportMarkdown = () => {
    const blob = new Blob([exportEditedResearchMarkdown(turns, layout, edits)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'research-canvas.md';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const result = await onSave(layout);
      if (live.current.snapshot === snapshot) setSaved(result);
    }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Saving the research canvas failed.'); }
    finally { setSaving(false); }
  };
  function undo() {
    onUndo();
    setSaved(null);
  }
  return { exportMarkdown, save, undo };
}
