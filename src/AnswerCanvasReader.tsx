import type { AnswerCanvasModel } from './useAnswerCanvas';
import { BlockContent } from './Loaders';

export function AnswerCanvasReader({ model }: { model: AnswerCanvasModel }) {
  const { reader, readerIndex, canvas, setReaderId, editBlock, updateBlock, setSaveError, sourceLabels, openSourceLink } = model;
  if (!reader) return null;
  return (
    <div className="page-reader" role="dialog" aria-modal="true" aria-label={reader.title + ' full page'}>
      <header className="page-reader__header"><button className="page-reader__back" onClick={() => setReaderId('')}>← Back to canvas</button>
        <span className="page-reader__location">{canvas.name} / {reader.title}</span>
        <nav className="page-reader__pager" aria-label="Documents on this canvas">
          <button className="icon-button" aria-label="Previous document" disabled={readerIndex <= 0}
            onClick={() => setReaderId(canvas.blocks[readerIndex - 1].id)}>‹</button>
          <select aria-label="Jump to document" value={reader.id} onChange={event => setReaderId(event.target.value)}>
            {canvas.blocks.map((block, index) => <option key={block.id} value={block.id}>{index + 1}. {block.title}</option>)}</select>
          <span className="page-reader__count">{readerIndex + 1} / {canvas.blocks.length}</span>
          <button className="icon-button" aria-label="Next document" disabled={readerIndex >= canvas.blocks.length - 1}
            onClick={() => setReaderId(canvas.blocks[readerIndex + 1].id)}>›</button>
        </nav>
        <div className="page-reader__actions"><button className="primary-button" onClick={() => {
          setReaderId('');
          editBlock(reader);
        }}>Edit document</button></div>
      </header>
      <main className="page-reader__scroll"><div className="page-reader__document"><div className="page-reader__eyebrow">{reader.kind} · {reader.file}</div>
        <h1>{reader.title}</h1><div className="page-reader__content"><BlockContent block={reader} canvasId={canvas.id}
          onUpdateBlock={updateBlock} onError={setSaveError} fullPage /></div>
        {reader.crossLinks?.length ? <aside className="page-reader__related" aria-label="Related on other canvases"><h2>Cited sources</h2>
          {reader.crossLinks.map(link => <button key={link.canvasId + ':' + link.blockId} className="secondary-button"
            onClick={() => openSourceLink(link.canvasId, link.blockId)}>{sourceLabels[link.canvasId + ':' + link.blockId]} ↗</button>)}</aside> : null}
      </div></main></div>
  );
}
