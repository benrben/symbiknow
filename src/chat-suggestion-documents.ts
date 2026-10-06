import type { CanvasBlock } from '../shared/types';
import { shortSuggestionTitle } from './chat-suggestion-titles';
import type { ChatSuggestion, SuggestionContext } from './chat-suggestion-types';

export function documentSuggestions(context: SuggestionContext): ChatSuggestion[] | null {
  const selected = selectedDocuments(context);
  if (selected.length > 1) return selectedSuggestions(selected.length);
  const focused = focusedDocument(selected, context);
  if (focused) return focusedSuggestions(focused, context);
  if (!context.view.editorDraft) return null;
  return [
    { title: 'Review this draft', detail: 'Check structure and wording' },
    { title: 'What is missing from this draft?', detail: 'Find gaps before saving' },
    { title: 'Suggest a clearer version', detail: 'Keep the changes in chat until you choose them' },
  ];
}

function selectedDocuments({ canvas, view }: SuggestionContext): CanvasBlock[] {
  return canvas?.blocks.filter(block => view.selectedBlockIds.includes(block.id)) ?? [];
}

function focusedDocument(selected: CanvasBlock[], { canvas, view }: SuggestionContext): CanvasBlock | undefined {
  return selected[0] ?? canvas?.blocks.find(block => block.id === view.readerBlockId || block.id === view.focusBlockId);
}

function selectedSuggestions(count: number): ChatSuggestion[] {
  return [
    { title: 'Where do these documents agree or conflict?', detail: `${count} selected sources` },
    { title: 'What is missing between these documents?', detail: 'Find gaps and unresolved questions' },
    { title: 'What should we do with these findings?', detail: 'Suggest concrete next steps' },
  ];
}

function focusedSuggestions(block: CanvasBlock, { view }: SuggestionContext): ChatSuggestion[] {
  const title = shortSuggestionTitle(block.title);
  if (view.editingBlockId === block.id) return editorSuggestions(title, Boolean(view.editorHasUnsavedChanges));
  return [
    { title: `Explain ${title} in context`, detail: 'Connect this document to the canvas' },
    { title: `Which documents support or challenge ${title}?`, detail: 'Explore related evidence' },
    { title: `What should happen next for ${title}?`, detail: 'Find useful next actions' },
  ];
}

function editorSuggestions(title: string, unsaved: boolean): ChatSuggestion[] {
  return [
    { title: `Review ${title} for clarity`, detail: 'Check structure and wording' },
    { title: `What is missing from ${title}?`, detail: 'Check gaps against related documents' },
    unsaved
      ? { title: `Suggest edits for ${title} without saving`, detail: 'Keep your unsaved draft in the editor' }
      : { title: `Edit ${title} for clarity`, detail: 'Update the saved document' },
  ];
}
