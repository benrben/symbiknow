import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Viewport } from '@xyflow/react';
import type { AnswerCanvasTurn, AnswerCanvasViewFocus, AnswerSource, CanvasViewFocus, ResearchLayout } from '../shared/answer-canvas';
import type { BlockKind, CanvasBlock, CanvasDocument } from '../shared/types';
import { api } from './api';
import { uploadedSource } from '../shared/file-transfer';
import { Canvas, type BlockPosition } from './Canvas';
import { BlockContent } from './Loaders';
import { MarkdownEditor, ViewToggle, type EditorMode } from './MarkdownEditor';
import { editedResearchGraph, exportEditedResearchMarkdown, patchResearchBlock, researchCanvasDocument,
  type ResearchCanvasEdits } from './research-edits';
import type { ResearchBlock } from './research-canvas';
import type { Theme } from './theme';
import './answer-canvas.css';

type Props = {
  turns: AnswerCanvasTurn[];
  layout: ResearchLayout;
  theme: Theme;
  edits: ResearchCanvasEdits;
  canUndo: boolean;
  historyCount: number;
  hasSavedCopy: boolean;
  actionRequest?: { kind: 'add' | 'search' | 'groups' | 'upload'; sequence: number; files?: File[] };
  onEditsChange: (edits: ResearchCanvasEdits) => void;
  onUndo: () => void;
  onLayoutChange: (layout: ResearchLayout) => void;
  onSave: (layout: ResearchLayout) => Promise<{ id: string; name: string }>;
  onOpenSavedCanvas: (canvasId: string, name: string) => void;
  onClose: () => void;
  onOpenSource: (source: AnswerSource) => void;
  onRecheck: () => void;
  onAskSelection?: (blocks: CanvasBlock[]) => void;
  onViewFocusChange?: (focus: AnswerCanvasViewFocus) => void;
};

type Draft = { id?: string; title: string; content: string; kind: BlockKind };
const sourceKey = (source: AnswerSource) => source.canvasId + ':' + source.blockId;
const layoutNames: Record<ResearchLayout, string> = { roadmap: 'Roadmap', kanban: 'Kanban', architecture: 'Architecture', mindmap: 'Mind map' };
const newId = () => 'user:' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
const roomForBlock = (blocks: ResearchBlock[], anchor?: ResearchBlock, width = 400, height = 290) => {
  const x = anchor ? anchor.x + (anchor.width ?? 400) + 120 : 80;
  let y = anchor?.y ?? 80;
  while (blocks.some(block => x < block.x + (block.width ?? 400) + 80 && x + width + 80 > block.x
    && y < block.y + (block.height ?? 290) + 80 && y + height + 80 > block.y)) y += Math.max(height + 100, 390);
  return { x, y };
};

export function AnswerCanvas({ turns, layout, theme, edits, canUndo, historyCount, hasSavedCopy, actionRequest, onEditsChange, onUndo, onLayoutChange,
  onSave, onOpenSavedCanvas, onClose, onOpenSource, onRecheck, onAskSelection, onViewFocusChange }: Props) {
  const graph = useMemo(() => editedResearchGraph(turns, layout, edits), [turns, layout, edits]);
  const canvas = useMemo(() => researchCanvasDocument(turns, layout, edits), [turns, layout, edits]);
  const sources = useMemo(() => [...new Map(turns.flatMap(turn => turn.sources).map(source => [sourceKey(source), source])).values()], [turns]);
  const sourceLabels = useMemo(() => Object.fromEntries(sources.map(source => [sourceKey(source), source.title])), [sources]);
  const latest = turns.at(-1);
  const manuallyAdded = new Set(edits.added.map(block => block.id));
  const latestBlocks = graph.blocks.filter(block => block.turnId === latest?.id && !manuallyAdded.has(block.id));
  const first = latestBlocks.find(block => !graph.edges.some(edge => edge.target === block.id && latestBlocks.some(item => item.id === edge.source)))
    ?? latestBlocks[0];
  const story = first ? [first, ...latestBlocks.filter(block => block.id !== first.id)] : [];
  const [focusRequest, setFocusRequest] = useState<{ blockId: string; sequence: number }>();
  const [focusedTurnId, setFocusedTurnId] = useState<number | null>(latest?.id ?? null);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const seenAction = useRef(actionRequest?.sequence ?? 0);
  const [viewportRequest, setViewportRequest] = useState<Viewport & { sequence: number }>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('source');
  const [readerId, setReaderId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [duplicateId, setDuplicateId] = useState('');
  const [freshness, setFreshness] = useState<'current' | 'changed' | 'unavailable'>('current');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const focusedKey = useRef('');
  const focusState = useRef<AnswerCanvasViewFocus>({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
  const sourceFingerprint = sources.map(source => sourceKey(source) + ':' + (source.contentHash ?? '')).join('|');

  useEffect(() => {
    if (!first) return;
    const key = String(latest?.id) + ':' + first.id;
    if (focusedKey.current === key) return;
    focusedKey.current = key;
    setFocusRequest(current => ({ blockId: first.id, sequence: (current?.sequence ?? 0) + 1 }));
    setFocusedTurnId(latest?.id ?? null);
  }, [first?.id, latest?.id]);

  useEffect(() => {
    const tracked = sources.filter(source => source.contentHash);
    if (!tracked.length) return;
    let active = true;
    const check = async () => {
      try {
        const canvases = await Promise.all([...new Set(tracked.map(source => source.canvasId))]
          .map(id => api<CanvasDocument>('/canvases/' + encodeURIComponent(id))));
        if (!active) return;
        const documents = new Map(canvases.map(item => [item.id, item]));
        setFreshness(tracked.some(source => documents.get(source.canvasId)?.blocks.find(block => block.id === source.blockId)
          ?.contentHash !== source.contentHash) ? 'changed' : 'current');
      } catch { if (active) setFreshness('unavailable'); }
    };
    void check();
    const timer = window.setInterval(() => void check(), 8000);
    return () => { active = false; window.clearInterval(timer); };
  }, [sourceFingerprint]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (draft) setDraft(null);
      else if (readerId) setReaderId('');
      else if (historyOpen) setHistoryOpen(false);
      else if (duplicateId) setDuplicateId('');
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, readerId, historyOpen, duplicateId, onClose]);

  const change = (next: ResearchCanvasEdits) => { onEditsChange(next); setSaved(null); };
  const focus = (block: ResearchBlock) => {
    setFocusedTurnId(block.turnId);
    setFocusRequest(current => ({ blockId: block.id, sequence: (current?.sequence ?? 0) + 1 }));
  };
  const focusTurn = (turnId: number) => {
    const block = graph.blocks.find(item => item.turnId === turnId);
    if (block) focus(block);
  };
  const updateBlock = async (id: string, patch: Partial<CanvasBlock>) => { change(patchResearchBlock(edits, graph, id, patch)); };
  const moveBlocks = async (positions: BlockPosition[]) => {
    let next = edits;
    for (const position of positions) next = patchResearchBlock(next, graph, position.blockId,
      { x: position.x, y: position.y, ...(position.group !== undefined ? { group: position.group } : {}) });
    change(next);
  };
  const deleteBlock = async (id: string) => { change({ ...edits, deleted: [...edits.deleted, id] }); };
  const reportFocus = (next: AnswerCanvasViewFocus) => { focusState.current = next; onViewFocusChange?.(next); };
  const viewChanged = (viewport: Viewport, visibleIds: string[], focusView: CanvasViewFocus) => {
    const visible = graph.blocks.filter(block => visibleIds.includes(block.id));
    reportFocus({ ...focusState.current,
      level: focusView.level === 'overview' || viewport.zoom < .45 ? 'big-picture' : viewport.zoom < .9 ? 'answers' : 'sources',
      visibleAnswerIds: [...new Set(visible.map(block => block.turnId))], visibleBlockIds: visibleIds,
      visibleSourceKeys: [...new Set(visible.flatMap(block => block.sources.map(sourceKey)))],
    });
  };
  const selectionChanged = (blocks: CanvasBlock[]) => {
    const chosen = graph.blocks.find(block => block.id === blocks[0]?.id);
    reportFocus({ ...focusState.current, selectedBlockId: chosen?.id, selectedAnswerId: chosen?.turnId,
      selectedSourceKey: undefined });
  };
  const openSourceLink = (canvasId: string, blockId: string) => {
    const source = sources.find(item => item.canvasId === canvasId && item.blockId === blockId);
    if (source) onOpenSource(source);
  };
  const addBlock = () => { setEditorMode('source'); setDraft({ title: '', content: '# New note\n\n', kind: 'markdown' }); };
  useEffect(() => {
    if (!actionRequest || actionRequest.sequence === seenAction.current) return;
    seenAction.current = actionRequest.sequence;
    if (actionRequest.kind === 'add') { addBlock(); return; }
    if (actionRequest.kind === 'search') { searchInput.current?.focus(); return; }
    if (actionRequest.kind === 'groups') {
      setViewportRequest(current => ({ x: 24, y: 68, zoom: .28, sequence: (current?.sequence ?? 0) + 1 }));
      return;
    }
    if (actionRequest.kind !== 'upload' || !actionRequest.files?.length) return;
    const files = actionRequest.files;
    void Promise.all(files.map(async file => uploadedSource(file.name, await file.text()))).then(documents => {
      const bottom = Math.max(0, ...graph.blocks.map(block => block.y + (block.height ?? 290)));
      const added: ResearchBlock[] = documents.map((document, index) => ({
        id: newId(), turnId: latest?.id ?? 0, type: 'text', title: document.title, content: document.content,
        kind: document.kind, sources: [], markdown: '', x: 80 + (index % 2) * 430,
        y: bottom + 60 + Math.floor(index / 2) * 330, width: 400, height: 290,
      }));
      change({ ...edits, added: [...edits.added, ...added] });
      if (added[0]) window.setTimeout(() => focus(added[0]), 0);
    }).catch(error => setSaveError(error instanceof Error ? error.message : 'Could not add the selected files.'));
  }, [actionRequest?.sequence]);
  const editBlock = (block: CanvasBlock) => { setEditorMode('source'); setDraft({
    id: block.id, title: block.title, content: block.content, kind: block.kind,
  }); };
  const saveDraft = (event: FormEvent) => {
    event.preventDefault();
    if (!draft?.title.trim()) return;
    if (draft.id) {
      void updateBlock(draft.id, { title: draft.title.trim(), content: draft.content, kind: draft.kind });
      setDraft(null);
      return;
    }
    const anchor = graph.blocks.at(-1);
    const block: ResearchBlock = { id: newId(), turnId: latest?.id ?? 0, type: 'text', title: draft.title.trim(),
      content: draft.content, kind: draft.kind, sources: [], markdown: '', ...roomForBlock(graph.blocks, anchor),
      width: 400, height: 290 };
    change({ ...edits, added: [...edits.added, block] });
    setDraft(null);
    window.setTimeout(() => focus(block), 0);
  };
  const duplicateBlock = (block: ResearchBlock) => {
    const copy = { ...block, id: newId(), title: block.title + ' copy',
      ...roomForBlock(graph.blocks, block, block.width ?? 400, block.height ?? 290) };
    change({ ...edits, added: [...edits.added, copy] });
    setDuplicateId('');
    window.setTimeout(() => focus(copy), 0);
  };
  const matches = search.trim() ? graph.blocks.filter(block => (block.title + ' ' + block.content).toLocaleLowerCase()
    .includes(search.trim().toLocaleLowerCase())) : [];
  const candidate = graph.blocks.find(block => block.id === duplicateId);
  const titleWords = candidate?.title.toLocaleLowerCase().split(/\W+/u).filter(word => word.length > 3) ?? [];
  const similar = candidate ? graph.blocks.filter(block => block.id !== candidate.id && (
    block.content.trim() === candidate.content.trim() || titleWords.filter(word => block.title.toLocaleLowerCase().includes(word)).length >= 2)) : [];

  const exportMarkdown = () => {
    const blob = new Blob([exportEditedResearchMarkdown(turns, layout, edits)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'research-canvas.md';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const save = async () => {
    if (saving) return;
    setSaving(true); setSaveError('');
    try { setSaved(await onSave(layout)); }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Saving the research canvas failed.'); }
    finally { setSaving(false); }
  };
  const readerIndex = canvas.blocks.findIndex(block => block.id === readerId);
  const reader = canvas.blocks[readerIndex];
  const latestWorking = latest?.status === 'working' && !latest.patch;

  return <section className="answer-canvas" aria-label="Research canvas">
    <header className="answer-canvas__bar">
      <div className="answer-canvas__heading"><span className="answer-canvas__eyebrow">SESSION RESEARCH CANVAS</span>
        <h2>{turns[0]?.query ?? 'Research'}</h2>
        <p>{graph.blocks.length} document{graph.blocks.length === 1 ? '' : 's'} · {sources.length} cited source{sources.length === 1 ? '' : 's'} · Changes stay in this session until you save</p></div>
      <div className="answer-canvas__bar-actions">
        <button type="button" onClick={() => { onUndo(); setSaved(null); }} disabled={!canUndo}>Undo</button>
        <details className="answer-canvas__more"><summary>View & export</summary><div>
          <label className="answer-canvas__layout">Layout <select aria-label="Research layout" value={layout}
            onChange={event => onLayoutChange(event.target.value as ResearchLayout)}>
            {(Object.keys(layoutNames) as ResearchLayout[]).map(value => <option value={value} key={value}>{layoutNames[value]}</option>)}</select></label>
          <button type="button" onClick={exportMarkdown}>Export Markdown</button>
          <button type="button" onClick={() => setHistoryOpen(true)}>Session history</button>
        </div></details>
        <button type="button" onClick={() => void save()} disabled={saving || !graph.blocks.length}>{saving ? 'Saving…' : hasSavedCopy ? 'Save new copy' : 'Save canvas'}</button>
        <button type="button" onClick={onClose} aria-label="Return to main canvas">← Main graph</button>
      </div>
    </header>
    <nav className="answer-canvas__turn-nav" aria-label="Research questions"><span>RESEARCH PATH</span>
      {turns.map((turn, index) => <button key={turn.id} type="button" aria-current={focusedTurnId === turn.id ? 'step' : undefined}
        aria-label={'Question ' + (index + 1) + ': ' + turn.query} onClick={() => focusTurn(turn.id)}>
        <b>{String(index + 1).padStart(2, '0')}</b><span>{turn.query}</span>
        <small>{graph.blocks.filter(block => block.turnId === turn.id).length} blocks</small>
      </button>)}</nav>
    {story.length > 0 && <nav className="answer-canvas__story" aria-label="Latest answer structure"><span>READ THIS ANSWER</span>
      {story.map((block, index) => <button key={block.id} type="button" onClick={() => focus(block)}
        aria-label={'Step ' + (index + 1) + ': ' + block.title}><b>{index + 1}</b><span>{block.title}</span></button>)}</nav>}
    <div className="answer-canvas__tools">
      <label>Find on this canvas<input ref={searchInput} aria-label="Find in research canvas" value={search} onChange={event => setSearch(event.target.value)}
        placeholder="Search answers and notes…"/></label>
      {search && <span>{matches.length} match{matches.length === 1 ? '' : 'es'}</span>}
      <span className="answer-canvas__tools-tip">Drag cards · connect handles · select for details · double-click to edit</span>
    </div>
    {search && <div className="answer-canvas__matches" role="group" aria-label="Research search results">
      {matches.length ? matches.map(block => <button key={block.id} type="button" onClick={() => focus(block)}>{block.title}</button>)
        : <span>No matching blocks</span>}</div>}
    {latestWorking && <div className="answer-canvas__staging" role="status"><strong>Jev is selecting evidence and drawing the next answer…</strong>
      {latest.sources.map(source => <button key={sourceKey(source)} type="button" onClick={() => onOpenSource(source)}>{source.title} ↗</button>)}</div>}
    {saveError && <div className="answer-canvas__freshness" role="alert">{saveError}</div>}
    {saved && <div className="answer-canvas__saved" role="status">Saved as {saved.name}.
      <button type="button" onClick={() => onOpenSavedCanvas(saved.id, saved.name)}>Open saved canvas ↗</button></div>}
    {freshness === 'changed' && <div className="answer-canvas__freshness" role="status">A cited source changed.
      <button type="button" onClick={onRecheck}>Recheck the latest documents</button></div>}
    {freshness === 'unavailable' && <div className="answer-canvas__freshness" role="status">Source freshness could not be checked right now.</div>}
    <div className="answer-canvas__workspace"><Canvas canvas={canvas} theme={theme} focusZoom={1} focusSelect={false} crossLinkLabels={sourceLabels}
      onUpdateBlock={updateBlock} onDeleteBlock={deleteBlock} onMoveBlocks={moveBlocks} onSelectBlock={editBlock}
      onReadBlock={block => setReaderId(block.id)} onHistoryBlock={() => setHistoryOpen(true)}
      onOpenCrossLink={openSourceLink} onFindDuplicates={setDuplicateId} onSummarizeSelection={onAskSelection}
      focusRequest={focusRequest} viewportRequest={viewportRequest} searchQuery={search} searchMatchIds={matches.map(block => block.id)}
      onSelectionChange={selectionChanged} onViewportChange={viewChanged}/></div>
    {draft && <div className="overlay modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setDraft(null); }}>
      <div className="modal editor-modal block-modal" role="dialog" aria-modal="true" aria-label="Block editor">
        <div className="modal-heading"><div><span className="eyebrow">SESSION RESEARCH</span><h2>{draft.id ? 'Edit block' : 'New block'}</h2></div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setDraft(null)}>×</button></div>
        <form className="modal-form" onSubmit={saveDraft}>
          <div className="form-row"><label>Title<input required value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
            <label>Loader<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as BlockKind })}>
              <option value="markdown">Markdown</option><option value="slides">Slides</option><option value="mdx">MDX components</option>
              <option value="website">Full website</option>
            </select></label></div>
          <div className="editor-view-bar"><span>{editorMode === 'preview' ? 'Live preview' : editorMode === 'split' ? 'Source and live preview' : 'Document content'}</span>
            <ViewToggle mode={editorMode} onChange={setEditorMode}/></div>
          <div className={'editor-workspace editor-workspace--' + editorMode}>
            {editorMode !== 'preview' && <MarkdownEditor label="Markdown source" value={draft.content}
              onChange={content => setDraft({ ...draft, content })} onToggleView={() => setEditorMode(current => current === 'preview' ? 'source' : 'preview')}/>}
            {editorMode !== 'source' && <div className="editor-preview" role="region" aria-label="Document preview"><BlockContent
              block={{ id: draft.id ?? 'draft', title: draft.title, file: 'research/draft.md', kind: draft.kind, content: draft.content,
                x: 0, y: 0, width: 400, height: 290, links: [] }} canvasId={canvas.id}
              onUpdateBlock={async (_, patch) => {
                if (patch.content !== undefined) setDraft(current => current ? { ...current, content: patch.content! } : current);
              }} onError={setSaveError}/></div>}
          </div>
          <div className="editor-footnote">This edit stays in the research session. Save the canvas to keep it in the workspace.</div>
          <div className="modal-actions">{draft.id && <button type="button" className="danger-button"
            onClick={() => { void deleteBlock(draft.id!); setDraft(null); }}>Delete</button>}
            <span className="actions-spacer"/><button type="button" className="secondary-button" onClick={() => setDraft(null)}>Cancel</button>
            <button className="primary-button">Save block</button></div>
        </form>
      </div></div>}
    {reader && <div className="page-reader" role="dialog" aria-modal="true" aria-label={reader.title + ' full page'}>
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
        <div className="page-reader__actions"><button className="primary-button" onClick={() => { setReaderId(''); editBlock(reader); }}>Edit document</button></div>
      </header>
      <main className="page-reader__scroll"><div className="page-reader__document"><div className="page-reader__eyebrow">{reader.kind} · {reader.file}</div>
        <h1>{reader.title}</h1><div className="page-reader__content"><BlockContent block={reader} canvasId={canvas.id}
          onUpdateBlock={updateBlock} onError={setSaveError} fullPage/></div>
        {reader.crossLinks?.length ? <aside className="page-reader__related" aria-label="Related on other canvases"><h2>Cited sources</h2>
          {reader.crossLinks.map(link => <button key={link.canvasId + ':' + link.blockId} className="secondary-button"
            onClick={() => openSourceLink(link.canvasId, link.blockId)}>{sourceLabels[link.canvasId + ':' + link.blockId]} ↗</button>)}</aside> : null}
      </div></main></div>}
    {historyOpen && <div className="answer-canvas__small-dialog" role="dialog" aria-modal="true" aria-label="Session history">
      <h2>Session history</h2><p>{historyCount ? historyCount + ' manual action' + (historyCount === 1 ? '' : 's') + ' in this session. Undo them one at a time.' : 'No manual changes yet.'}</p>
      <button type="button" disabled={!canUndo} onClick={() => { onUndo(); setSaved(null); }}>Undo last action</button>
      <button type="button" onClick={() => setHistoryOpen(false)}>Close</button></div>}
    {candidate && <div className="answer-canvas__small-dialog" role="dialog" aria-modal="true" aria-label="Find duplicates">
      <h2>Similar blocks</h2><p>{similar.length ? 'Review possible duplicates in this research session.' : 'No similar blocks found in this session.'}</p>
      {similar.map(block => <button key={block.id} type="button" onClick={() => { setDuplicateId(''); focus(block); }}>{block.title}</button>)}
      <button type="button" onClick={() => duplicateBlock(candidate)}>Duplicate this block</button>
      <button type="button" onClick={() => setDuplicateId('')}>Close</button></div>}
  </section>;
}
