import type { AnswerCanvasModel } from './useAnswerCanvas';
import type { AnswerDraft } from './answer-canvas-types';
import type { BlockKind } from '../shared/types';
import { MarkdownEditor, ViewToggle } from './MarkdownEditor';
import { BlockContent } from './Loaders';

export function AnswerCanvasEditor({ model }: { model: AnswerCanvasModel }) {
  const { draft, setDraft, saveDraft, deleteBlock } = model;
  if (!draft) return null;
  return (
    <div className="overlay modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setDraft(null); }}>
      <div className="modal editor-modal block-modal" role="dialog" aria-modal="true" aria-label="Block editor">
        <div className="modal-heading"><div><span className="eyebrow">SESSION RESEARCH</span><h2>{draft.id ? 'Edit block' : 'New block'}</h2></div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setDraft(null)}>×</button></div>
        <form className="modal-form" onSubmit={saveDraft}>
          <div className="form-row"><label>Title<input required value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>Loader<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as BlockKind })}>
              <option value="markdown">Markdown</option><option value="slides">Slides</option><option value="mdx">MDX components</option>
              <option value="website">Full website</option>
            </select></label></div>
          <DraftViews model={model} draft={draft} />
          <div className="editor-footnote">This edit stays in the research session. Save the canvas to keep it in the workspace.</div>
          <div className="modal-actions">{draft.id && <button type="button" className="danger-button"
            onClick={() => {
              void deleteBlock(draft.id!);
              setDraft(null);
            }}>Delete</button>}
            <span className="actions-spacer" /><button type="button" className="secondary-button" onClick={() => setDraft(null)}>Cancel</button>
            <button className="primary-button">Save block</button></div>
        </form>
      </div></div>
  );
}
function DraftViews({ model, draft }: { model: AnswerCanvasModel; draft: AnswerDraft }) {
  const { editorMode, setEditorMode, setDraft, canvas, setSaveError, updateDraft } = model;
  return <>
    <div className="editor-view-bar"><span>{editorMode === 'preview' ? 'Live preview' : editorMode === 'split' ? 'Source and live preview' : 'Document content'}</span>
      <ViewToggle mode={editorMode} onChange={setEditorMode} /></div>
    <div className={'editor-workspace editor-workspace--' + editorMode}>
      {editorMode !== 'preview' && <MarkdownEditor label="Markdown source" value={draft.content}
        onChange={content => setDraft({ ...draft, content })} onToggleView={() => setEditorMode(current => current === 'preview' ? 'source' : 'preview')} />}
      {editorMode !== 'source' && <div className="editor-preview" role="region" aria-label="Document preview"><BlockContent
        block={{
          id: draft.id ?? 'draft', title: draft.title, file: 'research/draft.md', kind: draft.kind, content: draft.content,
          x: 0, y: 0, width: 400, height: 290, links: []
        }} canvasId={canvas.id}
        onUpdateBlock={updateDraft} onError={setSaveError} /></div>}
    </div>
  </>;
}
