import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { AppDialogModel } from './app-dialog-contract';
import { Icon } from './AppIcon';
import { BlockContent } from './Loaders';
import { readingSequence } from './reading';
import { browserActor } from './api';
import { blockPath } from './app-model-helpers';
import type { CanvasBlock } from '../shared/types';
import { isEvidenceRange } from '../shared/evidence';
import { useDocumentContent } from './useDocumentContent';
import { useEscapeLayer } from './escape-layers';
import { JevDocumentReview } from './JevDocumentReview';

type ReaderProps = { model: AppDialogModel; block: CanvasBlock };
type ReaderNeighbors = { previous?: CanvasBlock; next?: CanvasBlock };

function useReadingSequence(model: AppDialogModel) {
  return useMemo(() => {
    const blocks = model.canvas?.blocks ?? [];
    return readingSequence(blocks);
  }, [model.canvas]);
}

const readerDirection: Record<string, 'next' | 'previous'> = { ArrowRight: 'next', ']': 'next', ArrowLeft: 'previous', '[': 'previous' };
function useReaderKeys(model: AppDialogModel, neighbors: ReaderNeighbors) {
  const { previous, next } = neighbors;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (model.dialog || event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const direction = readerDirection[event.key];
      if (!direction) return;
      const target = { previous, next }[direction];
      if (target) model.showReaderDocument(target.id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [model, next, previous]);
}

export function FullPageReader({ model }: { model: AppDialogModel }) {
  const sequence = useReadingSequence(model);
  const index = sequence.findIndex(item => item.id === model.readerId);
  const block = sequence[index];
  const neighbors = { previous: sequence[index - 1], next: sequence[index + 1] };
  const scroller = useRef<HTMLElement>(null);
  useEffect(() => { scroller.current?.scrollTo?.({ top: 0 }); }, [model.readerId]);
  useReaderKeys(model, neighbors);
  useEscapeLayer(Boolean(block), model.closeReader);
  if (!block) return null;
  return <ReaderPage model={model} block={block} sequence={sequence} index={index} neighbors={neighbors} scroller={scroller}/>;
}

function ReaderPage({ model, block: summary, sequence, index, neighbors, scroller }: ReaderProps & {
  sequence: CanvasBlock[]; index: number; neighbors: ReaderNeighbors; scroller: RefObject<HTMLElement | null>;
}) {
  const content = useDocumentContent(summary, model.canvasId);
  const block = content.block ?? summary;
  return <div className="page-reader" role="dialog" aria-modal={model.showChat ? 'false' : 'true'} aria-label={`${block.title} full page`}>
    <header className="page-reader__header">
      <button className="page-reader__back" onClick={model.closeReader} autoFocus>← Back to canvas</button>
      <span className="page-reader__location">{model.canvas?.name} <span>/</span> {block.title}</span>
      <ReaderPager model={model} block={block} sequence={sequence} index={index} {...neighbors}/>
      <ReaderActions model={model} block={block}/>
    </header>
    <main className="page-reader__scroll" ref={scroller}><div className="page-reader__document">
      <div className="page-reader__eyebrow">{block.kind} · {block.file}<ReaderLock block={block}/></div>
      <h1>{block.title}</h1>
      {model.canvas && <JevDocumentReview key={`${model.canvasId}:${block.id}`} workspaceId={model.canvas.workspaceId}
        canvasId={model.canvasId} blockId={block.id} contentHash={block.contentHash} groupLabels={model.canvas.groupLabels}
        onGroupChanged={model.refreshAfterVersionChange}/>}
      <ReaderContent model={model} content={content}/>
      <ReaderRelated model={model} block={block}/><ReaderFooter model={model} {...neighbors}/>
    </div></main>
  </div>;
}

function ReaderContent({ model, content }: { model: AppDialogModel; content: ReturnType<typeof useDocumentContent> }) {
  if (content.error) return <div className="loader-error" role="alert">{content.error} <button type="button" onClick={content.retry}>Retry loading document</button></div>;
  if (!content.block) return <div className="loader-loading" role="status">Loading document…</div>;
  return <><ReaderSourceContext model={model} block={content.block}/>
    <div className="page-reader__content"><BlockContent block={content.block} canvasId={model.canvasId} onUpdateBlock={model.updateBlock} onError={model.setError} fullPage/></div></>;
}

function ReaderPager({ model, block, sequence, index, previous, next }: ReaderProps & ReaderNeighbors & { sequence: CanvasBlock[]; index: number }) {
  return <nav className="page-reader__pager" aria-label="Documents on this canvas">
    <button className="icon-button" aria-label="Previous document" title={previous ? `Previous: ${previous.title}` : 'First document'} disabled={!previous} onClick={() => previous && model.showReaderDocument(previous.id)}>‹</button>
    <select aria-label="Jump to document" value={block.id} onChange={event => model.showReaderDocument(event.target.value)}>
      {sequence.map((item, position) => <option key={item.id} value={item.id}>{position + 1}. {item.title}</option>)}</select>
    <span className="page-reader__count">{index + 1} / {sequence.length}</span>
    <button className="icon-button" aria-label="Next document" title={next ? `Next: ${next.title}` : 'Last document'} disabled={!next} onClick={() => next && model.showReaderDocument(next.id)}>›</button>
  </nav>;
}

function ReaderActions({ model, block }: ReaderProps) {
  return <div className="page-reader__actions">
    <button className="secondary-button document-assistant-trigger" onClick={model.openDocumentAssistant}><Icon name="spark" size={15}/> Ask Symbi</button>
    <button className="secondary-button" onClick={() => model.openVersionHistory(block)}>File history</button>
    <a className="secondary-button" href={`/api${blockPath(model.canvasId, block.id)}/download`}>Download .md</a>
    <button className="primary-button" disabled={block.contentLoaded === false} onClick={() => { model.closeReader(); model.openBlock(block); }}>Edit document</button>
  </div>;
}

function ReaderLock({ block }: { block: CanvasBlock }) {
  return block.lock && block.lock.owner !== browserActor ? ` · ${block.lock.owner} is editing` : '';
}

function sourceContext(model: AppDialogModel, block: CanvasBlock) {
  const source = model.sourceFocus;
  if (source?.blockId !== block.id || source.canvasId !== model.canvasId || !source.excerpt) return null;
  return source;
}

function sourceChanged(source: NonNullable<AppDialogModel['sourceFocus']>, block: CanvasBlock): boolean {
  return (['contentHash', 'incarnation', 'sourceGeneration', 'metadataRevision'] as const)
    .some(field => source[field] !== undefined && block[field] !== source[field]);
}

function passageMatches(source: NonNullable<AppDialogModel['sourceFocus']>, content: string): boolean {
  if (source.start === undefined && source.end === undefined) return content.includes(source.excerpt!);
  if (!isEvidenceRange(source.start, source.end, content.length)) return false;
  return content.slice(source.start, source.end) === source.excerpt;
}

function sourceNotice(source: NonNullable<AppDialogModel['sourceFocus']>, block: CanvasBlock) {
  if (sourceChanged(source, block)) return `This document changed since ${source.origin ?? 'Chat'} checked it. Review the current text before relying on the answer.`;
  return passageMatches(source, block.content) ? 'This passage appears in the current document.' : 'This excerpt is approximate context. Check the current document text below.';
}

function ReaderSourceContext({ model, block }: ReaderProps) {
  const source = sourceContext(model, block);
  if (!source) return null;
  const label = `Source context from ${source.origin ?? 'Chat'}`;
  return <aside className="page-reader__source-focus" aria-label={label}>
    <strong>{label}</strong><p>{source.excerpt}</p><small>{sourceNotice(source, block)}</small>
  </aside>;
}

function ReaderRelated({ model, block }: ReaderProps) {
  if (!block.crossLinks?.length) return null;
  return <aside className="page-reader__related" aria-label="Related on other canvases" style={{ borderTop: '1px solid var(--sk-border)', marginTop: 24, paddingTop: 18 }}>
    <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Related on other canvases</h2>
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {block.crossLinks.map(link => <ReaderRelatedLink key={`${link.canvasId}:${link.blockId}`} model={model} link={link}/>)}</ul>
  </aside>;
}

function ReaderRelatedLink({ model, link }: { model: AppDialogModel; link: NonNullable<CanvasBlock['crossLinks']>[number] }) {
  const label = model.crossLinkLabels?.[`${link.canvasId}:${link.blockId}`] ?? `${link.canvasId} · ${link.blockId}`;
  return <li><button type="button" className="secondary-button" aria-label={`Open ${label}`} onClick={() => model.openCrossLink(link.canvasId, link.blockId)}>
    ↗ {label}{link.relation ? <small style={{ display: 'block', fontSize: 10, textAlign: 'left' }}>{link.relation.replaceAll('_', ' ')}</small> : null}
  </button></li>;
}

function ReaderFooter({ model, previous, next }: { model: AppDialogModel } & ReaderNeighbors) {
  if (!previous && !next) return null;
  return <footer className="page-reader__footer">
    {previous ? <button onClick={() => model.showReaderDocument(previous.id)}><small>Previous</small><strong>‹ {previous.title}</strong></button> : <span/>}
    {next ? <button onClick={() => model.showReaderDocument(next.id)}><small>Next</small><strong>{next.title} ›</strong></button> : <span/>}
  </footer>;
}
