import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { FileText, Info } from 'lucide-react';
import type { CanvasBlock } from '../shared/types';
import { groupLabel, normalizedGroup } from '../shared/groups';
import { BlockContent } from './Loaders';

export interface CanvasInspectorProps {
  blocks: CanvasBlock[];
  selected: CanvasBlock[];
  canvasId: string;
  onUpdateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void>;
  onReadBlock: (block: CanvasBlock) => void;
  onFocusBlock: (blockId: string) => void;
  onSummarizeSelection?: (blocks: CanvasBlock[]) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onResize: (axis: 'width' | 'height', size: number) => void;
}

function excerpt(block: CanvasBlock): string {
  return block.content.replace(/[#>*_`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'No text preview';
}

export function CanvasInspector({ blocks, selected, canvasId, onUpdateBlock, onReadBlock, onFocusBlock, onSummarizeSelection, onError, onClose, onResize }: CanvasInspectorProps) {
  const [group, setGroup] = useState('');
  const [tag, setTag] = useState('');
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<'preview' | 'details'>('preview');
  const drag = useRef<{ axis: 'width' | 'height'; pointerId: number; start: number; size: number } | null>(null);
  if (!selected.length) return null;
  const first = selected[0];
  const selectedIds = new Set(selected.map(block => block.id));
  const inbound = blocks.filter(block => block.links.includes(first.id));
  const outbound = first.links.map(id => blocks.find(block => block.id === id)).filter((block): block is CanvasBlock => Boolean(block));
  const commonTags = (first.tags ?? []).filter(value => selected.every(block => block.tags?.includes(value)));

  function resize(axis: 'width' | 'height', requested: number, element: HTMLElement) {
    const surface = element.closest('.canvas-surface');
    const available = axis === 'width' ? surface?.getBoundingClientRect().width : surface?.getBoundingClientRect().height;
    const minimum = axis === 'width' ? 280 : 190;
    const maximum = Math.max(minimum, (available || (axis === 'width' ? window.innerWidth : window.innerHeight)) - (axis === 'width' ? 260 : 120));
    onResize(axis, Math.round(Math.min(maximum, Math.max(minimum, requested))));
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const axis = window.matchMedia?.('(max-width: 700px)').matches || window.innerWidth <= 700 ? 'height' : 'width';
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    drag.current = { axis, pointerId: event.pointerId, start: axis === 'width' ? event.clientX : event.clientY,
      size: axis === 'width' ? panel.getBoundingClientRect().width || 344 : panel.getBoundingClientRect().height || 260 };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const distance = current.axis === 'width' ? current.start - event.clientX : current.start - event.clientY;
    resize(current.axis, current.size + distance, event.currentTarget);
  }

  function stopResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function updateAll(patch: (block: CanvasBlock) => Partial<CanvasBlock>) {
    try {
      await Promise.all(selected.map(block => onUpdateBlock(block.id, patch(block))));
    } catch (error) {
      onError(error instanceof Error ? `Could not update selection: ${error.message}` : 'Could not update selection.');
    }
  }

  function applyGroup() {
    const value = group.trim();
    if (!value) return;
    const key = value.includes(':') ? value : `custom:${value.toLowerCase().replace(/[^a-z0-9/_-]+/g, '_')}`;
    void updateAll(() => ({ group: key }));
    setGroup('');
  }

  function applyTag() {
    const value = tag.trim();
    if (!value) return;
    void updateAll(block => ({ tags: [...new Set([...(block.tags ?? []), value])] }));
    setTag('');
  }

  function connectTarget() {
    if (!target) return;
    void updateAll(block => ({ links: block.id === target ? block.links : [...new Set([...block.links, target])] }));
    setTarget('');
  }

  function connectTogether() {
    if (selected.length < 2) return;
    void updateAll(block => ({ links: [...new Set([...block.links, ...selected.filter(other => other.id !== block.id).map(other => other.id)])] }));
  }

  return <aside className="canvas-inspector" aria-label="Selection inspector">
    <div className="canvas-inspector__resize" role="separator" tabIndex={0} aria-label="Resize document panel"
      onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize}
      onKeyDown={event => {
        const axis = window.matchMedia?.('(max-width: 700px)').matches || window.innerWidth <= 700 ? 'height' : 'width';
        const delta = axis === 'width' ? event.key === 'ArrowLeft' ? 32 : event.key === 'ArrowRight' ? -32 : 0
          : event.key === 'ArrowUp' ? 32 : event.key === 'ArrowDown' ? -32 : 0;
        if (!delta) return;
        event.preventDefault();
        const size = axis === 'width' ? event.currentTarget.parentElement?.getBoundingClientRect().width || 344 : event.currentTarget.parentElement?.getBoundingClientRect().height || 260;
        resize(axis, size + delta, event.currentTarget);
      }}/>
    <header className="canvas-inspector__header"><strong>{selected.length === 1 ? first.title : `${selected.length} documents selected`}</strong><button type="button" onClick={onClose} aria-label="Close inspector">×</button></header>
    {selected.length === 1 && <div className="canvas-inspector__tabs" role="tablist" aria-label="Document panel view">
      <button type="button" role="tab" id="canvas-inspector-preview-tab" aria-controls="canvas-inspector-preview" aria-label="Preview" title="Document preview" aria-selected={mode === 'preview'} onClick={() => setMode('preview')}><FileText size={18} strokeWidth={1.8}/></button>
      <button type="button" role="tab" id="canvas-inspector-details-tab" aria-controls="canvas-inspector-details" aria-label="Details" title="Document details" aria-selected={mode === 'details'} onClick={() => setMode('details')}><Info size={18} strokeWidth={1.8}/></button>
    </div>}
    {selected.length === 1 && mode === 'preview' ? <section className="canvas-inspector__document" role="tabpanel" id="canvas-inspector-preview" aria-labelledby="canvas-inspector-preview-tab">
      <div className="canvas-inspector__document-body"><BlockContent block={first} canvasId={canvasId} onUpdateBlock={onUpdateBlock} onError={onError}/></div>
      <footer><button type="button" onClick={() => onReadBlock(first)}>Open full document ↗</button></footer>
    </section> : <section className="canvas-inspector__details" role={selected.length === 1 ? 'tabpanel' : undefined} id={selected.length === 1 ? 'canvas-inspector-details' : undefined} aria-labelledby={selected.length === 1 ? 'canvas-inspector-details-tab' : undefined}>
    {selected.length === 1 ? <>
      <p className="canvas-inspector__meta">{first.file} · {first.kind} · {first.group ? groupLabel(normalizedGroup(first.group) ?? first.group) : 'Ungrouped'}</p>
      <button type="button" onClick={() => onReadBlock(first)}>Open full document</button>
      <h3>Links out</h3>{outbound.length ? outbound.map(block => <button type="button" key={block.id} onClick={() => onFocusBlock(block.id)}>{block.title}</button>) : <p>None</p>}
      <h3>Links in</h3>{inbound.length ? inbound.map(block => <button type="button" key={block.id} onClick={() => onFocusBlock(block.id)}>{block.title}</button>) : <p>None</p>}
    </> : <>
      <ul className="canvas-inspector__selected">{selected.map(block => <li key={block.id}>{block.title}</li>)}</ul>
      <h3>Combined summary</h3>
      <ul className="canvas-inspector__summary">{selected.map(block => <li key={block.id}><strong>{block.title}:</strong> {excerpt(block)}</li>)}</ul>
      <p>Shared tags: {commonTags.length ? commonTags.join(', ') : 'none'}</p>
      {onSummarizeSelection && <button type="button" onClick={() => onSummarizeSelection(selected)}>AI: summarize these</button>}
      <button type="button" onClick={connectTogether}>Connect selected together</button>
    </>}
    <div className="canvas-inspector__actions">
      <label>Group<input aria-label="Group selected documents" value={group} onChange={event => setGroup(event.target.value)} placeholder="Research/Benchmarks"/></label><button type="button" onClick={applyGroup}>Set group</button>
      <label>Tag<input aria-label="Tag selected documents" value={tag} onChange={event => setTag(event.target.value)} placeholder="important"/></label><button type="button" onClick={applyTag}>Add tag</button>
      <label>Connect to<select aria-label="Connection target" value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose document</option>{blocks.filter(block => !selectedIds.has(block.id)).map(block => <option key={block.id} value={block.id}>{block.title}</option>)}</select></label><button type="button" onClick={connectTarget} disabled={!target}>Connect selected</button>
    </div>
    </section>}
  </aside>;
}
