import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppModel } from './App';
import { Icon } from './AppIcon';
import { BlockContent } from './Loaders';
import { SettingsPage } from './SettingsPage';
import { MarkdownEditor, ViewToggle, type EditorMode } from './MarkdownEditor';
import { VersionPanel } from './VersionPanel';
import { readingSequence } from './reading';
import { browserActor } from './api';
import { blockPath, renamedBlockDraft, updatedBlockDraft, type BlockDraft, type Dialog } from './app-model-helpers';
import type { BlockKind, CanvasBlock } from '../shared/types';

export function ModalOverlay({ model }: { model: AppModel }) {
  const { dialog, busy, setDialog } = model;
  return <div className="overlay modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setDialog(null); }}>
    <div className={'modal ' + (dialog === 'settings' ? 'settings-modal' : dialog === 'block' ? 'editor-modal block-modal' : dialog === 'versions' ? 'editor-modal' : '')} role="dialog" aria-modal="true" aria-label={modalLabel(dialog)}>
      <ModalHeading model={model}/>
      <ModalContent model={model}/>
    </div>
  </div>;
}

function modalLabel(dialog: Dialog) {
  if (dialog === 'settings') return 'Settings';
  if (dialog === 'block') return 'Block editor';
  if (dialog === 'versions') return 'History and branches';
  return 'Create new';
}

function ModalContent({ model }: { model: AppModel }) {
  if (model.dialog === 'settings') return <SettingsPage settings={model.settings} busy={model.busy} onSave={model.saveSettings} onCancel={() => model.setDialog(null)} onSettings={model.setSettings}/>;
  if (model.dialog === 'block') return <BlockForm model={model}/>;
  if (model.dialog === 'versions') {
    const block = model.canvas?.blocks.find(item => item.id === model.versionBlockId);
    return block ? <VersionPanel canvasId={model.canvasId} block={block} onChanged={model.refreshAfterVersionChange}/> : null;
  }
  return <NamedForm model={model}/>;
}

function modalHeading(dialog: Dialog, draft: BlockDraft) {
  if (dialog === 'settings') return { eyebrow: 'WORKSPACE SETTINGS', title: 'Connections and agents' };
  if (dialog === 'block') return { eyebrow: 'MARKDOWN FILE', title: draft.id ? 'Edit block' : 'New block' };
  if (dialog === 'versions') return { eyebrow: 'DOCUMENT HISTORY', title: 'File revisions and branches' };
  return { eyebrow: 'CREATE NEW', title: dialog === 'workspace' ? 'New workspace' : 'New canvas' };
}

function ModalHeading({ model }: { model: AppModel }) {
  const { eyebrow, title } = modalHeading(model.dialog, model.draftBlock);
  return <div className="modal-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={() => model.setDialog(null)}><Icon name="close" size={19}/></button></div>;
}

function BlockForm({ model }: { model: AppModel }) {
  const { saveBlock, draftBlock, setDraftBlock, importEditedFile, deleteBlock, busy, setDialog, canvasId, draftLock, takeOverLock } = model;
  const [view, setView] = useState<EditorMode>('source');
  const [importing, setImporting] = useState(false);
  const toggle = () => setView(current => current === 'preview' ? 'source' : 'preview');
  async function loadEditedFile(file: File) {
    setImporting(true);
    try { await importEditedFile(file); }
    finally { setImporting(false); }
  }
  const lockUntil = draftLock ? new Date(draftLock.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return <form onSubmit={saveBlock} className="modal-form">
    <div className="form-row"><label>Title<input required value={draftBlock.title} onChange={event => setDraftBlock(current => renamedBlockDraft(current, event.target.value))}/></label><label>Loader<select value={draftBlock.kind} onChange={event => { const kind = event.target.value as BlockKind; setDraftBlock(current => updatedBlockDraft(current, kind)); }}><option value="markdown">Markdown</option><option value="slides">Slides</option><option value="website">Full website</option><option value="mdx">MDX components</option></select></label></div>
    {draftLock && draftBlock.id && <div className="editor-lock" role="status"><span><strong>{draftLock.owner}</strong> is editing this file until {lockUntil}{draftLock.note ? ` — ${draftLock.note}` : ''}. Saving now will be refused.</span>
      <button type="button" className="secondary-button" onClick={() => void takeOverLock(draftBlock.id!)}>Take over</button></div>}
    {draftBlock.id && <div className="editor-file-actions"><a className="secondary-button" href={`/api${blockPath(canvasId, draftBlock.id)}/download`}>Download .md</a><label className="secondary-button">Upload edited file<input type="file" accept=".md,.mdx,.html,text/markdown,text/html" hidden onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void loadEditedFile(file); event.currentTarget.value = ''; }}/></label></div>}
    <div className="editor-view-bar"><span>{view === 'preview' ? 'Live preview' : view === 'split' ? 'Source and live preview' : 'Document content'} <span className="editor-shortcut"><kbd>⌘</kbd><kbd>E</kbd> to switch</span></span><ViewToggle mode={view} onChange={setView}/></div>
    <div className={`editor-workspace editor-workspace--${view}`}>
      {view !== 'preview' && <MarkdownEditor label="Markdown source" value={draftBlock.content} onChange={content => setDraftBlock(current => ({ ...current, content }))} onToggleView={toggle}/>}
      {view !== 'source' && <BlockDraftPreview model={model}/>}
    </div>
    <div className="editor-footnote">Each block is saved as its own Markdown file with its own Git history. Website blocks use frontmatter to select a generator and source folder.</div>
    <div className="modal-actions">{draftBlock.id && <button type="button" className="danger-button" onClick={() => void deleteBlock()} disabled={busy}><Icon name="trash" size={16}/> Delete</button>}<span className="actions-spacer"/><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" disabled={busy || importing}>{importing ? 'Loading file…' : 'Save block'}</button></div>
  </form>;
}

function BlockDraftPreview({ model }: { model: AppModel }) {
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

export function FullPageReader({ model }: { model: AppModel }) {
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
  return <div className="page-reader" role="dialog" aria-modal="true" aria-label={`${block.title} full page`}>
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
        <button className="secondary-button" onClick={() => { model.closeReader(); model.openVersionHistory(block); }}>File history</button>
        <a className="secondary-button" href={`/api${blockPath(model.canvasId, block.id)}/download`}>Download .md</a>
        <button className="primary-button" onClick={() => { model.closeReader(); model.openBlock(block); }}>Edit document</button>
      </div>
    </header>
    <main className="page-reader__scroll" ref={scroller}><div className="page-reader__document">
      <div className="page-reader__eyebrow">{block.kind} · {block.file}{block.lock && block.lock.owner !== browserActor ? ` · ${block.lock.owner} is editing` : ''}</div>
      <h1>{block.title}</h1>
      <div className="page-reader__content"><BlockContent block={block} canvasId={model.canvasId} onUpdateBlock={model.updateBlock} onError={model.setError} fullPage/></div>
      {Boolean(block.crossLinks?.length) && <aside className="page-reader__related" aria-label="Related on other canvases" style={{ borderTop: '1px solid #e2e8f1', marginTop: 24, paddingTop: 18 }}>
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

export function MergeReviewDialog({ model }: { model: AppModel }) {
  const review = model.mergeReview;
  if (!review) return null;
  const [keeper, ...merged] = review.blocks;
  const diff = mergeDiff(keeper.content, review.content);
  return <div className="overlay modal-overlay">
    <section className="modal editor-modal" role="dialog" aria-modal="true" aria-label="Review merge draft" style={{ padding: 24 }}>
      <div className="modal-heading" style={{ padding: 0, marginBottom: 16 }}><div><span className="eyebrow">MERGE PREVIEW</span><h2>Review merge draft</h2></div>
        <button type="button" className="icon-button" aria-label="Close merge review" onClick={() => model.setMergeReview(null)} disabled={model.mergeBusy}><Icon name="close" size={19}/></button></div>
      <p>Keep <strong>{keeper.title}</strong> and archive {merged.map(block => block.title).join(', ')}. Check the complete draft before applying.</p>
      <div role="region" aria-label="Proposed changes" style={{ maxHeight: 300, overflow: 'auto', padding: 12, background: '#f6f8fc', borderRadius: 8 }}>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
          {diff.prefix.length > 0 && <span>{diff.prefix.join('\n')}{'\n'}</span>}
          {diff.before.length > 0 && <del style={{ display: 'block', background: '#ffe6e6', color: '#8b2630', textDecoration: 'none' }}>{diff.before.map(line => `− ${line}`).join('\n')}</del>}
          {diff.after.length > 0 && <ins style={{ display: 'block', background: '#e1f6e9', color: '#1e623b', textDecoration: 'none' }}>{diff.after.map(line => `+ ${line}`).join('\n')}</ins>}
          {diff.suffix.length > 0 && <span>{'\n'}{diff.suffix.join('\n')}</span>}
        </pre>
      </div>
      <details style={{ marginTop: 14 }}><summary>Review source documents ({merged.length})</summary>{merged.map(block =>
        <section key={block.id} style={{ marginTop: 12 }}><strong>{block.title}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' }}>{block.content}</pre></section>)}</details>
      <label style={{ display: 'block', marginTop: 14 }}>Complete merged Markdown
        <textarea aria-label="Complete merged Markdown" value={review.content} onChange={event => model.setMergeReview({ ...review, content: event.currentTarget.value })}
          style={{ display: 'block', width: '100%', minHeight: 180, marginTop: 6, fontFamily: 'monospace' }}/></label>
      {model.error && <p role="alert" style={{ color: '#a42b38' }}>{model.error}</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => model.setMergeReview(null)} disabled={model.mergeBusy}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => void model.applyMergeReview()} disabled={model.mergeBusy || !review.content.trim()}>{model.mergeBusy ? 'Applying merge…' : 'Apply merge'}</button></div>
    </section>
  </div>;
}

function NamedForm({ model }: { model: AppModel }) {
  const { dialog, createNamed, draftName, setDraftName, busy, setDialog } = model;
  return <form onSubmit={createNamed} className="modal-form">
    <label>{dialog === 'workspace' ? 'Workspace name' : 'Canvas name'}<input autoFocus required value={draftName} onChange={event => setDraftName(event.target.value)} placeholder={dialog === 'workspace' ? 'e.g. Product team' : 'e.g. Launch plan'}/></label>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" disabled={busy}>Create</button></div>
  </form>;
}
