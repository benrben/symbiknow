import type { AnswerCanvasTurn, ChatViewContext } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';
import { groupLabel } from '../shared/groups';

export type ChatScope = 'view' | 'canvas' | 'selection' | 'research';
export type ScopeOption = { id: ChatScope; label: string; detail: string; context: ChatViewContext };

export function requestContextForScope(view: ChatViewContext, option: ScopeOption): ChatViewContext {
  if (option.id === 'view' || !view.editingBlockId || !view.editorHasUnsavedChanges) return option.context;
  return { ...option.context, editingBlockId: view.editingBlockId, editorHasUnsavedChanges: true };
}

function documentTitle(canvas: CanvasDocument | null, id?: string): string | undefined {
  return canvas?.blocks.find(block => block.id === id)?.title;
}

export function currentViewLabel(canvas: CanvasDocument | null, view: ChatViewContext): string {
  if (view.viewMode === 'answer') return researchLabel(view);
  if (view.selectedBlockIds.length > 1) return `${view.selectedBlockIds.length} selected documents`;
  const focused = focusedDocumentTitle(canvas, view);
  if (focused) return focused;
  return otherViewLabel(canvas, view);
}

function otherViewLabel(canvas: CanvasDocument | null, view: ChatViewContext): string {
  return draftLabel(view) ?? activeGroupLabel(view) ?? searchLabel(view) ?? overviewLabel(canvas, view);
}

function researchLabel(view: ChatViewContext): string {
  return view.answerFocus?.focusedBlockTitle ? `Research · ${view.answerFocus.focusedBlockTitle}` : 'Research canvas';
}

function focusedDocumentTitle(canvas: CanvasDocument | null, view: ChatViewContext): string | undefined {
  return documentTitle(canvas, view.selectedBlockIds[0] ?? view.readerBlockId ?? view.focusBlockId);
}

function draftLabel(view: ChatViewContext): string | undefined {
  return view.editorDraft ? `Draft · ${view.editorDraft.title.trim() || 'Untitled'}` : undefined;
}

function activeGroupLabel(view: ChatViewContext): string | undefined {
  return view.activeGroup ? `${groupLabel(view.activeGroup)} group` : undefined;
}

function searchLabel(view: ChatViewContext): string | undefined {
  return view.searchQuery?.trim() ? `Search · ${view.searchQuery.trim()}` : undefined;
}

function overviewLabel(canvas: CanvasDocument | null, view: ChatViewContext): string {
  if (view.visibleGroups?.length && view.viewMode !== 'documents') return `${view.visibleGroups.length} visible groups`;
  return canvas?.name ?? 'Current canvas';
}

export function chatScopeOptions(canvas: CanvasDocument | null, view: ChatViewContext,
  turns: AnswerCanvasTurn[]): ScopeOption[] {
  const options: ScopeOption[] = [
    { id: 'view', label: 'Current view', detail: currentViewLabel(canvas, view), context: view },
    { id: 'canvas', label: 'Whole canvas', detail: canvas?.name ?? 'All documents', context: {
      selectedBlockIds: [], viewMode: 'overview', answerSourceIds: [],
    } },
  ];
  if (view.selectedBlockIds.length) options.push({ id: 'selection', label: 'Selected documents',
    detail: `${view.selectedBlockIds.length} selected`, context: {
      selectedBlockIds: view.selectedBlockIds, viewMode: 'documents', visibleBlockIds: view.selectedBlockIds,
    } });
  if (turns.length) options.push(researchScope(view, turns));
  return options;
}

function researchScope(view: ChatViewContext, turns: AnswerCanvasTurn[]): ScopeOption {
  // Called only after the nonempty guard; every AnswerCanvasTurn has a query, including a valid empty string.
  return { id: 'research', label: 'Research canvas', detail: turns.at(-1)!.query, context: {
    selectedBlockIds: [], viewMode: 'answer',
    answerSourceIds: [...new Set(turns.flatMap(turn => turn.sources.map(source => source.blockId)))].slice(-12),
    answerFocus: view.viewMode === 'answer' && view.answerFocus ? view.answerFocus : {
      level: 'big-picture', visibleQuestions: turns.map(turn => turn.query).slice(-8), visibleSourceIds: [],
    },
  } };
}
