import type { CanvasStore } from './storage.js';
import type { ChatViewContext } from '../shared/answer-canvas.js';
import type { BlockKind } from '../shared/types.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function sourceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 128 ? value : undefined;
}

function sourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => sourceId(item) !== undefined))].slice(0, 12);
}

function textList(value: unknown, count: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, count).map(item => item.slice(0, max));
}

function completeDraft(draft: Record<string, unknown> | null): draft is Record<string, unknown> & { content: string; title: string } {
  return Boolean(draft && typeof draft.content === 'string' && typeof draft.title === 'string');
}

function editorDraft(raw: Record<string, unknown>): ChatViewContext['editorDraft'] {
  if (raw.editorHasUnsavedChanges !== true) return undefined;
  const draft = record(raw.editorDraft);
  if (!completeDraft(draft)) return undefined;
  if (!['markdown', 'mdx', 'slides', 'website'].includes(String(draft.kind))) return undefined;
  return { title: draft.title.slice(0, 160), kind: draft.kind as BlockKind, content: draft.content.slice(0, 16000),
    truncated: draft.truncated === true || draft.content.length > 16000 };
}

function viewport(value: unknown): ChatViewContext['viewport'] {
  const view = record(value);
  if (!view) return undefined;
  const valid = ['x', 'y', 'zoom'].every(key => typeof view[key] === 'number' && Number.isFinite(view[key]));
  return valid ? { x: view.x as number, y: view.y as number, zoom: view.zoom as number } : undefined;
}

function answerFocus(value: unknown): ChatViewContext['answerFocus'] {
  const focus = record(value);
  if (!focus || !['big-picture', 'answers', 'sources'].includes(String(focus.level))) return undefined;
  return { level: focus.level as 'big-picture' | 'answers' | 'sources',
    visibleQuestions: textList(focus.visibleQuestions, 8, 200),
    visibleBlockTitles: textList(focus.visibleBlockTitles, 12, 160),
    visibleSourceIds: sourceIds(focus.visibleSourceIds),
    focusedQuestion: optionalText(focus.focusedQuestion, 200),
    focusedBlockTitle: optionalText(focus.focusedBlockTitle, 160), focusedSourceId: sourceId(focus.focusedSourceId) };
}

function availableGroups(canvas: Awaited<ReturnType<CanvasStore['getCanvas']>>): Set<string> {
  return new Set(canvas.blocks.flatMap(block => {
    const group = block.group;
    if (!group) return ['__ungrouped'];
    const separator = group.indexOf(':');
    if (separator < 0) return [group];
    const prefix = group.slice(0, separator + 1);
    const segments = group.slice(separator + 1).split('/');
    return segments.map((_, index) => prefix + segments.slice(0, index + 1).join('/'));
  }));
}

function knownIds(value: unknown, known: Set<string>, count: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && known.has(id)))].slice(0, count);
}

export function viewContext(value: unknown, canvas: Awaited<ReturnType<CanvasStore['getCanvas']>>): ChatViewContext {
  const raw = record(value) ?? {};
  const known = new Set(canvas.blocks.map(block => block.id));
  const blockId = (input: unknown) => typeof input === 'string' && known.has(input) ? input : undefined;
  const groups = availableGroups(canvas);
  const groupId = (input: unknown) => typeof input === 'string' && groups.has(input) ? input : undefined;
  const viewMode = typeof raw.viewMode === 'string' && ['overview', 'titles', 'documents', 'answer'].includes(raw.viewMode)
    ? raw.viewMode as ChatViewContext['viewMode'] : undefined;
  return {
    selectedBlockIds: knownIds(raw.selectedBlockIds, known, 12), visibleBlockIds: knownIds(raw.visibleBlockIds, known, 12),
    viewMode, readerBlockId: blockId(raw.readerBlockId), editingBlockId: blockId(raw.editingBlockId),
    editorHasUnsavedChanges: raw.editorHasUnsavedChanges === true, editorDraft: editorDraft(raw),
    focusBlockId: blockId(raw.focusBlockId), searchQuery: optionalText(raw.searchQuery, 200), viewport: viewport(raw.viewport),
    answerSourceIds: sourceIds(raw.answerSourceIds), activeGroup: groupId(raw.activeGroup),
    visibleGroups: knownIds(raw.visibleGroups, groups, 16), answerFocus: answerFocus(raw.answerFocus),
  };
}

export function viewDescription(canvas: Awaited<ReturnType<CanvasStore['getCanvas']>>, view: ChatViewContext): string {
  const title = (id: string | undefined) => canvas.blocks.find(block => block.id === id)?.title;
  const selected = view.selectedBlockIds.map(id => title(id)).filter(Boolean);
  return JSON.stringify({ canvas: canvas.name, selectedDocuments: selected,
    visibleDocuments: view.visibleBlockIds?.map(id => title(id)).filter(Boolean), viewMode: view.viewMode,
    openDocument: title(view.readerBlockId), editingDocument: title(view.editingBlockId),
    editorHasUnsavedChanges: view.editorHasUnsavedChanges, editorDraft: view.editorDraft,
    focusedDocument: title(view.focusBlockId),
    searchQuery: view.searchQuery, viewport: view.viewport, answerSourceIds: view.answerSourceIds,
    activeGroup: view.activeGroup, visibleGroups: view.visibleGroups, answerFocus: view.answerFocus });
}

