import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AppDialogModel } from './app-dialog-contract';
import { Icon } from './AppIcon';
import { BlockContent } from './Loaders';
import { MarkdownEditor, ViewToggle, type EditorMode } from './MarkdownEditor';
import { blockPath, renamedBlockDraft, updatedBlockDraft, type BlockDraft } from './app-model-helpers';
import type { BlockKind, CanvasBlock } from '../shared/types';

function savedDraftChanged(saved: CanvasBlock | undefined, draft: BlockDraft) {
  return Boolean(saved && saved.contentLoaded !== false && draft.contentHash && saved.contentHash !== draft.contentHash);
}

function useEditorView() {
  const [view, setView] = useState<EditorMode>('source');
  const form = useRef<HTMLFormElement>(null);
  const shortcutFocus = useRef(false);
  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key.toLowerCase() !== 'e' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    shortcutFocus.current = true;
    setView(current => current === 'preview' ? 'source' : 'preview');
  }
  useEffect(() => {
    if (!shortcutFocus.current) return;
    shortcutFocus.current = false;
    form.current?.querySelector<HTMLButtonElement>('.view-toggle button[aria-pressed="true"]')?.focus();
  }, [view]);
  return { view, setView, form, onKeyDown };
}

export function BlockForm({ model, onClose }: { model: AppDialogModel; onClose: () => void }) {
  const { saveBlock, draftBlock, setDraftBlock, importEditedFile, busy } = model;
  const { view, setView, form, onKeyDown } = useEditorView();
  const [importing, setImporting] = useState(false);
  const savedBlock = model.canvas?.blocks.find(block => block.id === draftBlock.id);
  const changed = savedDraftChanged(savedBlock, draftBlock);
  async function loadEditedFile(file: File) {
    setImporting(true);
    model.setError('');
    try { await importEditedFile(file); }
    finally { setImporting(false); }
  }
  return <form ref={form} onSubmit={saveBlock} onKeyDownCapture={onKeyDown} className="modal-form">
    <div className="form-row"><label>Title<input required value={draftBlock.title} onChange={event => setDraftBlock(current => renamedBlockDraft(current, event.target.value))}/></label>
      <label>Loader<select value={draftBlock.kind} onChange={event => {
        const kind = event.target.value as BlockKind;
        setDraftBlock(current => updatedBlockDraft(current, kind));
      }}><option value="markdown">Markdown</option><option value="slides">Slides</option><option value="website">Full website</option><option value="mdx">MDX components</option></select></label></div>
    <EditorLock model={model}/>
    <SavedVersionWarning model={model} saved={savedBlock} changed={changed}/>
    <EditorFileActions model={model} onImport={loadEditedFile}/>
    <EditorWorkspace model={model} view={view} setView={setView}/>
    <div className="editor-footnote">Each block is saved as its own Markdown file with its own Git history. Website blocks use frontmatter to select a generator and source folder.</div>
    <div className="modal-actions"><DeleteDraftAction model={model}/><span className="actions-spacer"/>
      <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
      <button className="primary-button" disabled={busy || importing || changed}>{importing ? 'Loading file…' : 'Save block'}</button></div>
  </form>;
}

function EditorLock({ model }: { model: AppDialogModel }) {
  const { draftLock, draftBlock, takeOverLock } = model;
  if (!draftLock || !draftBlock.id) return null;
  const id = draftBlock.id;
  const until = new Date(draftLock.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return <div className="editor-lock" role="status"><span><strong>{draftLock.owner}</strong> is editing this file until {until}{draftLock.note ? ` — ${draftLock.note}` : ''}. Saving now will be refused.</span>
    <button type="button" className="secondary-button" onClick={() => void takeOverLock(id)}>Take over</button></div>;
}

function SavedVersionWarning({ model, saved, changed }: { model: AppDialogModel; saved: CanvasBlock | undefined; changed: boolean }) {
  if (!changed || !saved) return null;
  return <div className="editor-external-change" role="status"><span>The saved document changed while this editor was open. Your draft is still here. Copy it before loading the saved version.</span>
    <button type="button" className="secondary-button" onClick={() => model.setDraftBlock({ id: saved.id, title: saved.title, kind: saved.kind,
      content: saved.content, contentHash: saved.contentHash })}>Load saved version</button></div>;
}

function EditorFileActions({ model, onImport }: { model: AppDialogModel; onImport: (file: File) => Promise<void> }) {
  const id = model.draftBlock.id;
  if (!id) return null;
  return <div className="editor-file-actions"><a className="secondary-button" href={`/api${blockPath(model.canvasId, id)}/download`}>Download .md</a>
    <label className="secondary-button">Upload edited file<input type="file" accept=".md,.mdx,.html,text/markdown,text/html" hidden onChange={event => {
      const file = event.currentTarget.files?.[0];
      if (file) void onImport(file);
      event.currentTarget.value = '';
    }}/></label></div>;
}

const viewLabels: Record<EditorMode, string> = { preview: 'Live preview', split: 'Source and live preview', source: 'Document content' };
function EditorWorkspace({ model, view, setView }: { model: AppDialogModel; view: EditorMode; setView: (mode: EditorMode | ((current: EditorMode) => EditorMode)) => void }) {
  const { draftBlock, setDraftBlock } = model;
  return <><div className="editor-view-bar"><span>{viewLabels[view]} <span className="editor-shortcut"><kbd>⌘</kbd><kbd>E</kbd> to switch</span></span><ViewToggle mode={view} onChange={setView}/></div>
    <div className={`editor-workspace editor-workspace--${view}`}>
      {view !== 'preview' && <MarkdownEditor label="Markdown source" value={draftBlock.content} onChange={content => setDraftBlock(current => ({ ...current, content }))}/>}
      {view !== 'source' && <BlockDraftPreview model={model}/>}
    </div></>;
}

function DeleteDraftAction({ model }: { model: AppDialogModel }) {
  return model.draftBlock.id && <button type="button" className="danger-button" onClick={() => void model.deleteBlock()} disabled={model.busy}><Icon name="trash" size={16}/> Delete</button>;
}

function previewBlock(draft: BlockDraft): CanvasBlock {
  const id = draft.id ?? 'unsaved-preview';
  return { id, title: draft.title || 'Untitled', kind: draft.kind, content: draft.content, file: `${id}.md`,
    x: 0, y: 0, width: 600, height: 360, links: [] };
}

export function BlockDraftPreview({ model }: { model: AppDialogModel }) {
  const { draftBlock, canvasId, setDraftBlock, setError } = model;
  if (draftBlock.kind === 'website' && !draftBlock.id) {
    return <div className="editor-preview editor-preview--empty">Save this website block to build and preview its documentation site.</div>;
  }
  return <div className="editor-preview" role="region" aria-label="Document preview">
    {draftBlock.kind === 'website' && <p className="editor-preview__note">Website preview uses the last saved source. Save changes to rebuild it.</p>}
    <BlockContent block={previewBlock(draftBlock)} canvasId={canvasId} onError={setError} onUpdateBlock={async (_id, patch) => {
      if (patch.content !== undefined) setDraftBlock(current => ({ ...current, content: patch.content ?? current.content }));
    }}/>
  </div>;
}
