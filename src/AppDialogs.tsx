import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppDialogModel } from './app-dialog-contract';
import { Icon } from './AppIcon';
import { BlockContent } from './Loaders';
import { SettingsPage } from './SettingsPage';
import { MarkdownEditor, ViewToggle, type EditorMode } from './MarkdownEditor';
import { VersionPanel } from './VersionPanel';
import { readingSequence } from './reading';
import { browserActor } from './api';
import { blockPath, renamedBlockDraft, updatedBlockDraft, type BlockDraft, type Dialog } from './app-model-helpers';
import type { BlockKind, CanvasBlock } from '../shared/types';

export function ModalOverlay({ model }: { model: AppDialogModel }) {
  const { dialog, busy, setDialog } = model;
  const modalRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const originalDraft = useRef(JSON.stringify(model.draftBlock));
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = dialog === 'block' && JSON.stringify(model.draftBlock) !== originalDraft.current;
  function close() {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else setDialog(null);
  }
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    if (!modal.contains(document.activeElement)) modal.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')?.focus();
    return () => returnFocus.current?.focus();
  }, []);
  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (confirmClose) setConfirmClose(false);
      else close();
      return;
    }
    if (event.key !== 'Tab') return;
    const scope = confirmClose ? modalRef.current?.querySelector<HTMLElement>('.dirty-close') : modalRef.current;
    const items = [...(scope?.querySelectorAll<HTMLElement>('*') ?? [])]
      .filter(item => item.matches('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')
        && !item.closest('[hidden]') && !item.hasAttribute('hidden'));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="overlay modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={modalRef} onKeyDown={trapFocus} className={'modal ' + (dialog === 'settings' ? 'settings-modal' : dialog === 'block' ? 'editor-modal block-modal' : dialog === 'versions' ? 'editor-modal' : '')} role="dialog" aria-modal={dialog === 'block' && model.showChat ? 'false' : 'true'} aria-label={modalLabel(dialog)}>
      <ModalHeading model={model} onClose={close}/>
      <ModalContent model={model} onClose={close}/>
      {confirmClose && <div className="dirty-close" role="alertdialog" aria-modal="true" aria-label="Unsaved changes">
        <h3>Unsaved changes</h3><p>Save this document before closing, or discard your draft.</p>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setConfirmClose(false)} autoFocus>Continue editing</button>
          <button type="button" className="danger-button" onClick={() => setDialog(null)}>Discard changes</button>
          <button type="button" className="primary-button" onClick={() => { setConfirmClose(false); modalRef.current?.querySelector<HTMLFormElement>('form.modal-form')?.requestSubmit(); }}>Save changes</button></div>
      </div>}
    </div>
  </div>;
}

function modalLabel(dialog: Dialog) {
  if (dialog === 'delete-canvas') return 'Delete canvas';
  if (dialog === 'delete-workspace') return 'Delete workspace';
  if (dialog === 'settings') return 'Settings';
  if (dialog === 'block') return 'Block editor';
  if (dialog === 'versions') return 'History and branches';
  return 'Create new';
}

function ModalContent({ model, onClose }: { model: AppDialogModel; onClose: () => void }) {
  if (model.dialog === 'delete-canvas') return <DeleteCanvasForm model={model}/>;
  if (model.dialog === 'delete-workspace') return <DeleteWorkspaceForm model={model}/>;
  if (model.dialog === 'settings') return <SettingsPage settings={model.settings} busy={model.busy} onSave={model.saveSettings} onCancel={onClose} onSettings={model.setSettings} onOpenHistory={model.openActivityHistory}/>;
  if (model.dialog === 'block') return <BlockForm model={model} onClose={onClose}/>;
  if (model.dialog === 'versions') {
    const block = model.canvas?.blocks.find(item => item.id === model.versionBlockId);
    return block ? <VersionPanel canvasId={model.canvasId} block={block} initialRevision={model.versionRevision} onChanged={model.refreshAfterVersionChange}/> : null;
  }
  return <NamedForm model={model}/>;
}

function modalHeading(dialog: Dialog, draft: BlockDraft) {
  if (dialog === 'delete-canvas') return { eyebrow: 'REMOVE CANVAS', title: 'Delete canvas?' };
  if (dialog === 'delete-workspace') return { eyebrow: 'REMOVE WORKSPACE', title: 'Delete workspace?' };
  if (dialog === 'settings') return { eyebrow: 'WORKSPACE SETTINGS', title: 'Connections and agents' };
  if (dialog === 'block') return { eyebrow: 'MARKDOWN FILE', title: draft.id ? 'Edit block' : 'New block' };
  if (dialog === 'versions') return { eyebrow: 'DOCUMENT HISTORY', title: 'File revisions and branches' };
  return { eyebrow: 'CREATE NEW', title: dialog === 'workspace' ? 'New workspace' : 'New canvas' };
}

function DeleteCanvasForm({ model }: { model: AppDialogModel }) {
  const target = model.canvasToDelete;
  if (!target) return null;
  return <div className="modal-form">
    <p>Delete <strong>{target.name}</strong> and all its documents, tasks, and file histories? This cannot be undone.</p>
    {model.error && <p className="delete-canvas-error" role="alert">{model.error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => model.setDialog(null)} disabled={model.busy} autoFocus>Cancel</button><button type="button" className="danger-button delete-canvas-confirm" onClick={() => void model.deleteCanvas()} disabled={model.busy}><Icon name="trash" size={16}/>{model.busy ? 'Deleting…' : 'Delete canvas'}</button></div>
  </div>;
}

function DeleteWorkspaceForm({ model }: { model: AppDialogModel }) {
  const target = model.workspaceToDelete;
  if (!target) return null;
  return <div className="modal-form">
    <p>Delete <strong>{target.name}</strong> and its {target.canvases.length} {target.canvases.length === 1 ? 'canvas' : 'canvases'}, including all documents, tasks, and file histories? This cannot be undone.</p>
    {model.error && <p className="delete-canvas-error" role="alert">{model.error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => model.setDialog(null)} disabled={model.busy} autoFocus>Cancel</button><button type="button" className="danger-button delete-workspace-confirm" onClick={() => void model.deleteWorkspace()} disabled={model.busy}><Icon name="trash" size={16}/>{model.busy ? 'Deleting…' : 'Delete workspace'}</button></div>
  </div>;
}

function ModalHeading({ model, onClose }: { model: AppDialogModel; onClose: () => void }) {
  const { eyebrow, title } = modalHeading(model.dialog, model.draftBlock);
  return <div className="modal-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div><div className="modal-heading__actions">
    {model.dialog === 'block' && <button type="button" className="secondary-button document-assistant-trigger" onClick={model.openDocumentAssistant}><Icon name="spark" size={15}/> Ask Symbi</button>}
    <button className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={model.busy}><Icon name="close" size={19}/></button>
  </div></div>;
}

function BlockForm({ model, onClose }: { model: AppDialogModel; onClose: () => void }) {
  const { saveBlock, draftBlock, setDraftBlock, importEditedFile, deleteBlock, busy, canvasId, draftLock, takeOverLock } = model;
  const [view, setView] = useState<EditorMode>('source');
  const [importing, setImporting] = useState(false);
  const toggle = () => setView(current => current === 'preview' ? 'source' : 'preview');
  async function loadEditedFile(file: File) {
    setImporting(true);
    try { await importEditedFile(file); }
    finally { setImporting(false); }
  }
  const lockUntil = draftLock ? new Date(draftLock.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const savedBlock = model.canvas?.blocks.find(block => block.id === draftBlock.id);
  const savedVersionChanged = Boolean(savedBlock && draftBlock.contentHash && savedBlock.contentHash !== draftBlock.contentHash);
  return <form onSubmit={saveBlock} className="modal-form">
    <div className="form-row"><label>Title<input required value={draftBlock.title} onChange={event => setDraftBlock(current => renamedBlockDraft(current, event.target.value))}/></label><label>Loader<select value={draftBlock.kind} onChange={event => { const kind = event.target.value as BlockKind; setDraftBlock(current => updatedBlockDraft(current, kind)); }}><option value="markdown">Markdown</option><option value="slides">Slides</option><option value="website">Full website</option><option value="mdx">MDX components</option></select></label></div>
    {draftLock && draftBlock.id && <div className="editor-lock" role="status"><span><strong>{draftLock.owner}</strong> is editing this file until {lockUntil}{draftLock.note ? ` — ${draftLock.note}` : ''}. Saving now will be refused.</span>
      <button type="button" className="secondary-button" onClick={() => void takeOverLock(draftBlock.id!)}>Take over</button></div>}
    {savedVersionChanged && savedBlock && <div className="editor-external-change" role="status"><span>The saved document changed while this editor was open. Your draft is still here. Copy it before loading the saved version.</span>
      <button type="button" className="secondary-button" onClick={() => setDraftBlock({ id: savedBlock.id, title: savedBlock.title, kind: savedBlock.kind,
        content: savedBlock.content, contentHash: savedBlock.contentHash })}>Load saved version</button></div>}
    {draftBlock.id && <div className="editor-file-actions"><a className="secondary-button" href={`/api${blockPath(canvasId, draftBlock.id)}/download`}>Download .md</a><label className="secondary-button">Upload edited file<input type="file" accept=".md,.mdx,.html,text/markdown,text/html" hidden onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void loadEditedFile(file); event.currentTarget.value = ''; }}/></label></div>}
    <div className="editor-view-bar"><span>{view === 'preview' ? 'Live preview' : view === 'split' ? 'Source and live preview' : 'Document content'} <span className="editor-shortcut"><kbd>⌘</kbd><kbd>E</kbd> to switch</span></span><ViewToggle mode={view} onChange={setView}/></div>
    <div className={`editor-workspace editor-workspace--${view}`}>
      {view !== 'preview' && <MarkdownEditor label="Markdown source" value={draftBlock.content} onChange={content => setDraftBlock(current => ({ ...current, content }))} onToggleView={toggle}/>}
      {view !== 'source' && <BlockDraftPreview model={model}/>}
    </div>
    <div className="editor-footnote">Each block is saved as its own Markdown file with its own Git history. Website blocks use frontmatter to select a generator and source folder.</div>
    <div className="modal-actions">{draftBlock.id && <button type="button" className="danger-button" onClick={() => void deleteBlock()} disabled={busy}><Icon name="trash" size={16}/> Delete</button>}<span className="actions-spacer"/><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || importing || savedVersionChanged}>{importing ? 'Loading file…' : 'Save block'}</button></div>
  </form>;
}

function BlockDraftPreview({ model }: { model: AppDialogModel }) {
  const { draftBlock, canvasId, setDraftBlock, setError } = model;
  if (draftBlock.kind === 'website' && !draftBlock.id) {
    return <div className="editor-preview editor-preview--empty">Save this website block to build and preview its documentation site.</div>;
  }
  const block: CanvasBlock = { id: draftBlock.id ?? 'unsaved-preview', title: draftBlock.title || 'Untitled',
    kind: draftBlock.kind, content: draftBlock.content, file: `${draftBlock.id ?? 'unsaved-preview'}.md`,
    x: 0, y: 0, width: 600, height: 360, links: [] };
  return <div className="editor-preview" role="region" aria-label="Document preview">
    {draftBlock.kind === 'website' && <p className="editor-preview__note">Website preview uses the last saved source. Save changes to rebuild it.</p>}
    <BlockContent block={block} canvasId={canvasId} onError={setError} onUpdateBlock={async (_id, patch) => {
      if (patch.content !== undefined) setDraftBlock(current => ({ ...current, content: patch.content ?? current.content }));
    }}/>
  </div>;
}

export function FullPageReader({ model }: { model: AppDialogModel }) {
  const sequence = useMemo(() => {
    const blocks = model.canvas?.blocks ?? [];
    if (!model.readingPath) return readingSequence(blocks);
    return model.readingPath.blockIds.map(id => blocks.find(block => block.id === id)).filter((block): block is CanvasBlock => Boolean(block));
  }, [model.canvas, model.readingPath]);
  const index = sequence.findIndex(item => item.id === model.readerId);
  const block = sequence[index];
  const previous = sequence[index - 1];
  const next = sequence[index + 1];
  const scroller = useRef<HTMLElement>(null);
  useEffect(() => { scroller.current?.scrollTo?.({ top: 0 }); }, [model.readerId]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((event.key === 'ArrowRight' || event.key === ']') && next) model.showReaderDocument(next.id);
      if ((event.key === 'ArrowLeft' || event.key === '[') && previous) model.showReaderDocument(previous.id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [model, next, previous]);
  if (!block) return null;
  return <div className="page-reader" role="dialog" aria-modal={model.showChat ? 'false' : 'true'} aria-label={`${block.title} full page`}>
    <header className="page-reader__header">
      <button className="page-reader__back" onClick={model.closeReader} autoFocus>← Back to canvas</button>
      <span className="page-reader__location">{model.canvas?.name} <span>/</span> {model.readingPath ? `${model.readingPath.name} / ` : ''}{block.title}</span>
      <nav className="page-reader__pager" aria-label={model.readingPath ? `Reading path: ${model.readingPath.name}` : 'Documents on this canvas'}>
        <button className="icon-button" aria-label="Previous document" title={previous ? `Previous: ${previous.title}` : 'First document'} disabled={!previous} onClick={() => previous && model.showReaderDocument(previous.id)}>‹</button>
        <select aria-label="Jump to document" value={block.id} onChange={event => model.showReaderDocument(event.target.value)}>
          {sequence.map((item, position) => <option key={item.id} value={item.id}>{position + 1}. {item.title}</option>)}</select>
        <span className="page-reader__count">{index + 1} / {sequence.length}</span>
        <button className="icon-button" aria-label="Next document" title={next ? `Next: ${next.title}` : 'Last document'} disabled={!next} onClick={() => next && model.showReaderDocument(next.id)}>›</button>
      </nav>
      <div className="page-reader__actions">
        <button className="secondary-button document-assistant-trigger" onClick={model.openDocumentAssistant}><Icon name="spark" size={15}/> Ask Symbi</button>
        <button className="secondary-button" onClick={() => { model.closeReader(); model.openVersionHistory(block); }}>File history</button>
        <a className="secondary-button" href={`/api${blockPath(model.canvasId, block.id)}/download`}>Download .md</a>
        <button className="primary-button" onClick={() => { model.closeReader(); model.openBlock(block); }}>Edit document</button>
      </div>
    </header>
    <main className="page-reader__scroll" ref={scroller}><div className="page-reader__document">
      <div className="page-reader__eyebrow">{block.kind} · {block.file}{block.lock && block.lock.owner !== browserActor ? ` · ${block.lock.owner} is editing` : ''}</div>
      <h1>{block.title}</h1>
      {model.sourceFocus?.blockId === block.id && model.sourceFocus.canvasId === model.canvasId && model.sourceFocus.excerpt &&
        <aside className="page-reader__source-focus" aria-label="Source context from Chat">
          <strong>Source context from Chat</strong>
          <p>{model.sourceFocus.excerpt}</p>
          <small>{model.sourceFocus.contentHash && block.contentHash !== model.sourceFocus.contentHash
            ? 'This document changed since Chat checked it. Review the current text before relying on the answer.'
            : block.content.includes(model.sourceFocus.excerpt) ? 'This passage appears in the current document.'
              : 'This excerpt is approximate context. Check the current document text below.'}</small>
        </aside>}
      <div className="page-reader__content"><BlockContent block={block} canvasId={model.canvasId} onUpdateBlock={model.updateBlock} onError={model.setError} fullPage/></div>
      {Boolean(block.crossLinks?.length) && <aside className="page-reader__related" aria-label="Related on other canvases" style={{ borderTop: '1px solid var(--sk-border)', marginTop: 24, paddingTop: 18 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Related on other canvases</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {block.crossLinks?.map(link => {
            const label = model.crossLinkLabels?.[`${link.canvasId}:${link.blockId}`] ?? `${link.canvasId} · ${link.blockId}`;
            return <li key={`${link.canvasId}:${link.blockId}`}>
              <button type="button" className="secondary-button" aria-label={`Open ${label}`} onClick={() => model.openCrossLink(link.canvasId, link.blockId)}>
                ↗ {label}{link.relation ? <small style={{ display: 'block', fontSize: 10, textAlign: 'left' }}>{link.relation.replaceAll('_', ' ')}</small> : null}
              </button>
            </li>;
          })}
        </ul>
      </aside>}
      {(previous || next) && <footer className="page-reader__footer">
        {previous ? <button onClick={() => model.showReaderDocument(previous.id)}><small>Previous</small><strong>‹ {previous.title}</strong></button> : <span/>}
        {next ? <button onClick={() => model.showReaderDocument(next.id)}><small>Next</small><strong>{next.title} ›</strong></button> : <span/>}
      </footer>}
    </div></main>
  </div>;
}

/** Keep the unchanged edges visible and mark the complete changed span of a proposed merge. */
function mergeDiff(before: string, after: string) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let end = 0;
  while (end < oldLines.length - start && end < newLines.length - start
    && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end++;
  return { before: oldLines.slice(start, oldLines.length - end), after: newLines.slice(start, newLines.length - end),
    prefix: oldLines.slice(0, start), suffix: end ? oldLines.slice(oldLines.length - end) : [] };
}

export function MergeReviewDialog({ model }: { model: AppDialogModel }) {
  const review = model.mergeReview;
  if (!review) return null;
  const [keeper, ...merged] = review.blocks;
  const diff = mergeDiff(keeper.content, review.content);
  return <div className="overlay modal-overlay">
    <section className="modal editor-modal" role="dialog" aria-modal="true" aria-label="Review merge draft" style={{ padding: 24 }}>
      <div className="modal-heading" style={{ padding: 0, marginBottom: 16 }}><div><span className="eyebrow">MERGE PREVIEW</span><h2>Review merge draft</h2></div>
        <button type="button" className="icon-button" aria-label="Close merge review" onClick={() => model.setMergeReview(null)} disabled={model.mergeBusy}><Icon name="close" size={19}/></button></div>
      <p>Keep <strong>{keeper.title}</strong> and archive {merged.map(block => block.title).join(', ')}. Check the complete draft before applying.</p>
      <div role="region" aria-label="Proposed changes" style={{ maxHeight: 300, overflow: 'auto', padding: 12, background: 'var(--sk-surface-soft)', color: 'var(--sk-text)', borderRadius: 8 }}>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
          {diff.prefix.length > 0 && <span>{diff.prefix.join('\n')}{'\n'}</span>}
          {diff.before.length > 0 && <del style={{ display: 'block', background: 'var(--sk-error-bg)', color: 'var(--sk-error)', textDecoration: 'none' }}>{diff.before.map(line => `− ${line}`).join('\n')}</del>}
          {diff.after.length > 0 && <ins style={{ display: 'block', background: 'var(--sk-mint)', color: 'var(--sk-ink)', textDecoration: 'none' }}>{diff.after.map(line => `+ ${line}`).join('\n')}</ins>}
          {diff.suffix.length > 0 && <span>{'\n'}{diff.suffix.join('\n')}</span>}
        </pre>
      </div>
      <details style={{ marginTop: 14 }}><summary>Review source documents ({merged.length})</summary>{merged.map(block =>
        <section key={block.id} style={{ marginTop: 12 }}><strong>{block.title}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' }}>{block.content}</pre></section>)}</details>
      <label style={{ display: 'block', marginTop: 14 }}>Complete merged Markdown
        <textarea aria-label="Complete merged Markdown" value={review.content} onChange={event => model.setMergeReview({ ...review, content: event.currentTarget.value })}
          style={{ display: 'block', width: '100%', minHeight: 180, marginTop: 6, fontFamily: 'monospace' }}/></label>
      {model.error && <p role="alert" style={{ color: 'var(--sk-error)' }}>{model.error}</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => model.setMergeReview(null)} disabled={model.mergeBusy}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => void model.applyMergeReview()} disabled={model.mergeBusy || !review.content.trim()}>{model.mergeBusy ? 'Applying merge…' : 'Apply merge'}</button></div>
    </section>
  </div>;
}

function NamedForm({ model }: { model: AppDialogModel }) {
  const { dialog, createNamed, draftName, setDraftName, busy, setDialog } = model;
  return <form onSubmit={createNamed} className="modal-form">
    <label>{dialog === 'workspace' ? 'Workspace name' : 'Canvas name'}<input autoFocus required value={draftName} onChange={event => setDraftName(event.target.value)} placeholder={dialog === 'workspace' ? 'e.g. Product team' : 'e.g. Launch plan'}/></label>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" disabled={busy}>Create</button></div>
  </form>;
}
