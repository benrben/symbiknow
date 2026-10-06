import type { FormEvent } from 'react';
import type { CanvasBlock } from '../shared/types';
import type { BlockPosition } from './canvas-types';
import { patchResearchBlock, type ResearchCanvasEdits } from './research-edits';
import type { ResearchBlock } from './research-canvas';
import { newId, roomForBlock } from './answer-canvas-helpers';
import type { AnswerCanvasProps } from './answer-canvas-types';
import type { AnswerCanvasGraph } from './useAnswerCanvasGraph';
import type { AnswerCanvasState } from './useAnswerCanvasState';
import type { AnswerCanvasFocus } from './useAnswerCanvasFocus';

export function useAnswerCanvasEditing({ edits, onEditsChange }: AnswerCanvasProps, { graph, latest }: AnswerCanvasGraph, state: AnswerCanvasState, { focus }: AnswerCanvasFocus) {
  const { live, setSaved, setEditorMode, draft, setDraft, setDuplicateId } = state;
  const change = (next: ResearchCanvasEdits) => {
    live.current.edits = next;
    onEditsChange(next);
    setSaved(null);
  };
  const updateBlock = async (id: string, patch: Partial<CanvasBlock>) => { change(patchResearchBlock(edits, graph, id, patch)); };
  const moveBlocks = async (positions: BlockPosition[]) => {
    let next = edits;
    for (const position of positions) next = patchResearchBlock(next, graph, position.blockId,
      { x: position.x, y: position.y, ...(position.group !== undefined ? { group: position.group } : {}) });
    change(next);
  };
  const deleteBlock = async (id: string) => { change({ ...edits, deleted: [...edits.deleted, id] }); };
  const updateDraft = async (_id: string, patch: Partial<CanvasBlock>) => {
    if (patch.content !== undefined) setDraft(current => current ? { ...current, content: patch.content! } : current);
  };
  const addBlock = () => {
    setEditorMode('source');
    setDraft({ title: '', content: '# New note\n\n', kind: 'markdown' });
  };
  const editBlock = (block: CanvasBlock) => {
    setEditorMode('source');
    setDraft({
      id: block.id, title: block.title, content: block.content, kind: block.kind,
    });
  };
  const saveDraft = (event: FormEvent) => {
    event.preventDefault();
    if (!draft?.title.trim()) return;
    if (draft.id) {
      void updateBlock(draft.id, { title: draft.title.trim(), content: draft.content, kind: draft.kind });
      setDraft(null);
      return;
    }
    const anchor = graph.blocks.at(-1);
    const block: ResearchBlock = {
      id: newId(), turnId: latest?.id ?? 0, type: 'text', title: draft.title.trim(),
      content: draft.content, kind: draft.kind, sources: [], markdown: '', ...roomForBlock(graph.blocks, anchor),
      width: 400, height: 290
    };
    change({ ...edits, added: [...edits.added, block] });
    setDraft(null);
    window.setTimeout(() => focus(block), 0);
  };
  const duplicateBlock = (block: ResearchBlock) => {
    const copy = {
      ...block, id: newId(), title: block.title + ' copy',
      ...roomForBlock(graph.blocks, block, block.width ?? 400, block.height ?? 290)
    };
    change({ ...edits, added: [...edits.added, copy] });
    setDuplicateId('');
    window.setTimeout(() => focus(copy), 0);
  };
  return { change, updateBlock, moveBlocks, deleteBlock, updateDraft, addBlock, editBlock, saveDraft, duplicateBlock };
}
export type AnswerCanvasEditing = ReturnType<typeof useAnswerCanvasEditing>;
