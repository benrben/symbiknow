import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import type { CanvasBlock, SearchHit } from '../shared/types';
import { Icon } from './AppIcon';
import type { SearchAction } from './canvas-search-types';
import { searchCanvasName } from './canvas-search-model';
import { useDocumentContent } from './useDocumentContent';
import { rehypeMarkdownDirection } from './markdown-direction';

type PreviewProps = {
  hit: SearchHit;
  request: (hit: SearchHit, action: SearchAction) => void;
  evidenceEnabled: boolean;
};

function previewSummary(hit: SearchHit): CanvasBlock {
  return {
    id: hit.blockId, title: hit.title, kind: hit.kind, file: '', content: '', contentLoaded: false,
    x: 0, y: 0, width: 0, height: 0, links: [],
  };
}

function presentationBody(block: CanvasBlock): string {
  const body = block.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const heading = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body);
  if (!heading) return body;
  const headingTitle = heading[1].replace(/\s+/g, ' ').trim();
  const documentTitle = block.title.replace(/\s+/g, ' ').trim();
  if (headingTitle !== documentTitle && !(documentTitle.startsWith('Atlas: ') && headingTitle === documentTitle.slice(7))) return body;
  return body.slice(heading[0].length);
}

function PreviewBody({ block }: { block: CanvasBlock }) {
  if (block.kind !== 'markdown') return <pre className="canvas-search__preview-source">{block.content}</pre>;
  return <div className="loader-markdown canvas-search__preview-markdown" dir="auto">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeMarkdownDirection]}>{presentationBody(block)}</ReactMarkdown>
  </div>;
}

function PreviewDetails({ hit, block }: { hit: SearchHit; block?: CanvasBlock }) {
  return <dl className="canvas-search__preview-details">
    <dt>Canvas</dt><dd>{searchCanvasName(hit)}</dd>
    <dt>Type</dt><dd>{hit.kind}</dd>
    {block?.file && <><dt>File</dt><dd>{block.file}</dd></>}
    <dt>Match</dt><dd>{hit.matchIn === 'title' ? 'Title match' : 'Body match'}</dd>
    {hit.evidence && <><dt>Source context</dt><dd>{hit.evidence.passageKind === 'exact' ? 'Exact passage' : 'Approximate context'}</dd></>}
  </dl>;
}

function PreviewPaper({ content }: { content: ReturnType<typeof useDocumentContent> }) {
  return <article className="canvas-search__preview-paper">
    {content.error ? <p role="alert">Could not load document. <button type="button" onClick={content.retry}>Retry</button></p>
      : !content.block ? <p role="status">Loading document preview…</p>
        : <><h3 dir="auto">{content.block.title}</h3><PreviewBody block={content.block}/></>}
  </article>;
}

export function CanvasSearchPreview({ hit, request, evidenceEnabled }: PreviewProps) {
  const summary = useMemo(() => previewSummary(hit), [hit]);
  const content = useDocumentContent(summary, hit.canvasId);
  const [tab, setTab] = useState<'preview' | 'details'>('preview');
  const block = content.block;
  const openAction = evidenceEnabled && hit.evidence ? 'evidence' : 'reveal';
  return <section className="canvas-search__preview" aria-label={`Preview of ${hit.title}`}>
    <header className="canvas-search__preview-header">
      <span className="canvas-search__preview-icon" aria-hidden="true"><Icon name="file" size={24}/></span>
      <div><h2>{hit.title}</h2><p>in {searchCanvasName(hit)} · {hit.kind}</p></div>
      <button type="button" className="canvas-search__preview-open" onClick={() => request(hit, openAction)}>{openAction === 'evidence' ? 'Open document' : 'Show on canvas'}</button>
    </header>
    <div className="canvas-search__preview-tabs" role="group" aria-label="Document preview views">
      <button type="button" aria-pressed={tab === 'preview'} onClick={() => setTab('preview')}>Preview</button>
      <button type="button" aria-pressed={tab === 'details'} onClick={() => setTab('details')}>Details</button>
    </div>
    <div className="canvas-search__preview-scroll">
      {tab === 'details' ? <PreviewDetails hit={hit} block={block}/> : <PreviewPaper content={content}/>}
    </div>
  </section>;
}
