import { editPreview } from './chat-turn-state';
import type { TurnMessageProps } from './chat-message-types';

export function ChangedDocuments({ turn, undoingBlockId, onShowBlock, onUndoCreated, onUndoEdited }:
  Pick<TurnMessageProps, 'turn' | 'undoingBlockId' | 'onShowBlock' | 'onUndoCreated' | 'onUndoEdited'>) {
  return <>
    {turn.createdBlocks?.map(block => <div className="ai-chat__created-row" key={block.id}>
      <button className="ai-chat__created" type="button" onClick={() => onShowBlock(block, turn.createdCanvasId)}>Show {block.title} on canvas</button>
      {turn.createdCanvasId && <button type="button" disabled={undoingBlockId === block.id}
        onClick={() => onUndoCreated(turn.id, block)}>{undoingBlockId === block.id ? 'Undoing…' : 'Undo creation'}</button>}
    </div>)}
    {turn.editedBlocks?.map(edit => <div className="ai-chat__created-row" key={edit.after.id}>
      <details className="ai-chat__edit-preview"><summary>Review changes to {edit.after.title}</summary>
        <p>Changed: {editPreview(edit).fields}</p>
        {edit.before.content !== edit.after.content && <div className="ai-chat__edit-compare">
          <div><strong>Before</strong><pre>{editPreview(edit).before}</pre></div>
          <div><strong>After</strong><pre>{editPreview(edit).after}</pre></div>
        </div>}
        <button type="button" onClick={() => onShowBlock(edit.after, turn.createdCanvasId)}>Open updated document</button>
      </details>
      {turn.createdCanvasId && <button type="button" disabled={undoingBlockId === edit.after.id}
        onClick={() => onUndoEdited(turn.id, edit)}>{undoingBlockId === edit.after.id ? 'Undoing…' : 'Undo edit'}</button>}
    </div>)}
    {turn.undoMessage && <p className="ai-chat__undo-message" role="status">{turn.undoMessage}</p>}
    {turn.undoError && <p className="ai-chat__undo-error" role="alert">{turn.undoError}</p>}
  </>;
}

