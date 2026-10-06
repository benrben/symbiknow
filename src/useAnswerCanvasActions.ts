import { useEffect } from 'react';
import { uploadedSource } from '../shared/file-transfer';
import type { ResearchBlock } from './research-canvas';
import { newId } from './answer-canvas-helpers';
import type { AnswerCanvasProps } from './answer-canvas-types';
import type { AnswerCanvasState } from './useAnswerCanvasState';
import type { AnswerCanvasFocus } from './useAnswerCanvasFocus';
import type { AnswerCanvasEditing } from './useAnswerCanvasEditing';

export function useAnswerCanvasActions({ actionRequest }: AnswerCanvasProps, state: AnswerCanvasState, { focus }: AnswerCanvasFocus, { addBlock, change }: AnswerCanvasEditing) {
  const { seenAction, searchInput, setViewportRequest, generation, active, live, setSaveError } = state;
  function focusSearch() { searchInput.current?.focus(); }
  function showGroups() { setViewportRequest(current => ({ x: 24, y: 68, zoom: .28, sequence: (current?.sequence ?? 0) + 1 })); }
  useEffect(() => {
    if (!actionRequest || actionRequest.sequence === seenAction.current) return;
    seenAction.current = actionRequest.sequence;
    if (actionRequest.kind === 'upload') {
      upload(actionRequest.files);
      return;
    }
    const handlers = { add: addBlock, search: focusSearch, groups: showGroups };
    handlers[actionRequest.kind]?.();
  }, [actionRequest?.sequence]);
  function upload(files: File[] | undefined) {
    if (!files?.length) return;
    setSaveError('');
    const uploadGeneration = generation.current;
    const ownsUpload = () => active.current && uploadGeneration === generation.current;
    void Promise.all(files.map(async file => uploadedSource(file.name, await file.text()))).then(documents => {
      if (!ownsUpload()) return;
      const current = live.current;
      const bottom = Math.max(0, ...current.graph.blocks.map(block => block.y + (block.height ?? 290)));
      const added: ResearchBlock[] = documents.map((document, index) => ({
        id: newId(), turnId: current.latest?.id ?? 0, type: 'text', title: document.title, content: document.content,
        kind: document.kind, sources: [], markdown: '', x: 80 + (index % 2) * 430,
        y: bottom + 60 + Math.floor(index / 2) * 330, width: 400, height: 290,
      }));
      change({ ...current.edits, added: [...current.edits.added, ...added] });
      window.setTimeout(() => focus(added[0]), 0);
    }).catch(error => { if (ownsUpload()) setSaveError(error instanceof Error ? error.message : 'Could not add the selected files.'); });
  }
}
