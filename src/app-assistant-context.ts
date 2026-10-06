import { useMemo } from 'react';
import type { ChatViewContext } from '../shared/answer-canvas';
import type { AppModel } from './app-model';
import { editedResearchGraph } from './research-edits';

type EditorScope = ReturnType<typeof editorScope>;
type ResearchBlocks = ReturnType<typeof editedResearchGraph>['blocks'];

function editorScope(model: AppModel) {
  const editing = model.dialog === 'block';
  const editingBlock = currentEditingBlock(model);
  const documentBlockId = editing ? model.draftBlock.id : model.readerId || undefined;
  const savedMatchesDraft = editingBlock && (['title', 'kind', 'content'] as const)
    .every(field => model.draftBlock[field] === editingBlock[field]);
  return { editing, editingBlock, documentBlockId, unsaved: editing && !savedMatchesDraft };
}

function currentEditingBlock(model: AppModel) {
  if (model.dialog !== 'block' || !model.draftBlock.id) return undefined;
  return model.canvas?.blocks.find(block => block.id === model.draftBlock.id);
}

function contextBlockIds(model: AppModel, scope: EditorScope) {
  if (scope.editing || scope.documentBlockId) {
    const ids = scope.documentBlockId ? [scope.documentBlockId] : [];
    return { selectedBlockIds: ids, visibleBlockIds: ids };
  }
  return { selectedBlockIds: model.selectedBlockIds, visibleBlockIds: model.answerCanvasOpen ? [] : model.visibleBlockIds };
}

function contextViewMode(model: AppModel, scope: EditorScope): ChatViewContext['viewMode'] {
  if (scope.documentBlockId) return 'documents';
  if (scope.editing) return 'overview';
  if (model.answerCanvasOpen) return 'answer';
  if (model.canvasViewFocus.level === 'documents') return 'documents';
  return model.canvasViewFocus.level === 'overview' ? 'overview' : 'titles';
}

function contextEditorDraft(model: AppModel, scope: EditorScope) {
  if (!scope.unsaved) return undefined;
  return { title: model.draftBlock.title, kind: model.draftBlock.kind,
    content: model.draftBlock.content.slice(0, 16000), truncated: model.draftBlock.content.length > 16000 };
}

function contextAnswerFocus(model: AppModel, researchBlocks: ResearchBlocks): ChatViewContext['answerFocus'] {
  if (!model.answerCanvasOpen) return undefined;
  const focus = model.answerCanvasViewFocus;
  const sources = model.answerTurns.flatMap(turn => turn.sources);
  return {
    level: focus.level,
    visibleQuestions: model.answerTurns.filter(turn => focus.visibleAnswerIds.includes(turn.id)).map(turn => turn.query).slice(0, 8),
    visibleBlockTitles: researchBlocks.filter(block => focus.visibleBlockIds?.includes(block.id)).map(block => block.title).slice(0, 12),
    visibleSourceIds: sources.filter(source => focus.visibleSourceKeys.includes(`${source.canvasId}:${source.blockId}`))
      .map(source => source.blockId).filter((id, index, ids) => ids.indexOf(id) === index).slice(0, 12),
    focusedQuestion: model.answerTurns.find(turn => turn.id === focus.selectedAnswerId)?.query,
    focusedBlockTitle: researchBlocks.find(block => block.id === focus.selectedBlockId)?.title,
    focusedSourceId: sources.find(source => `${source.canvasId}:${source.blockId}` === focus.selectedSourceKey)?.blockId,
  };
}

/** A navigation request is one-shot; it describes the view only while that document is still on screen. */
function visibleFocusBlockId(model: AppModel): string | undefined {
  const request = model.focusRequest;
  if (request?.canvasId !== model.canvasId || !model.visibleBlockIds.includes(request.blockId)) return undefined;
  return request.blockId;
}

function contextDocumentFocus(model: AppModel, scope: EditorScope) {
  return {
    readerBlockId: scope.documentBlockId, editingBlockId: scope.editingBlock?.id,
    editorHasUnsavedChanges: scope.editing ? scope.unsaved : undefined,
    editorDraft: contextEditorDraft(model, scope),
    focusBlockId: visibleFocusBlockId(model),
    searchQuery: model.searchOpen ? model.searchQuery : undefined,
  };
}

export function useAssistantContext(model: AppModel): ChatViewContext {
  const researchBlocks = useMemo(() => editedResearchGraph(model.answerTurns, model.researchLayout, model.researchState.edits).blocks,
    [model.answerTurns, model.researchLayout, model.researchState.edits]);
  return useMemo(() => {
    const scope = editorScope(model);
    return {
      ...contextBlockIds(model, scope), ...contextDocumentFocus(model, scope), viewMode: contextViewMode(model, scope),
      activeGroup: model.answerCanvasOpen ? undefined : model.canvasViewFocus.activeGroup,
      visibleGroups: model.answerCanvasOpen ? undefined : model.canvasViewFocus.visibleGroups,
      viewport: model.journey.current?.viewport,
      answerSourceIds: [...new Set(model.answerTurns.flatMap(turn => turn.sources.map(source => source.blockId)))].slice(-12),
      answerFocus: contextAnswerFocus(model, researchBlocks),
    };
  }, [model.selectedBlockIds, model.visibleBlockIds, model.dialog, model.draftBlock, model.readerId, model.canvas,
    model.focusRequest, model.canvasId, model.searchOpen, model.searchQuery, model.journey.current?.viewport,
    model.answerCanvasOpen, model.answerTurns, model.canvasViewFocus, model.answerCanvasViewFocus, researchBlocks]);
}
