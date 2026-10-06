// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from 'codemirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ReactNode, ComponentType } from 'react';
import type { Connection, Edge, NodeChange, Viewport } from '@xyflow/react';
import type { AnswerCanvasTurn, AnswerSource, ResearchCanvasBlock } from '../shared/answer-canvas';
import type { FlowNode } from './canvas-types';
import type { CanvasDocument, WorkspaceSummary } from '../shared/types';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import { AnswerCanvas } from './AnswerCanvas';
import { useAnswerCanvas } from './useAnswerCanvas';
import { useAppState } from './app-state';
import { useResearchSession } from './app-research';
import { emptyResearchEdits, type ResearchCanvasEdits } from './research-edits';

type FlowProps = {
  nodes: FlowNode[]; children: ReactNode; nodeTypes: Record<string, ComponentType<never>>;
  onInit: (instance: unknown) => void; onNodeClick: (event: unknown, node: FlowNode) => void;
  onNodeDoubleClick: (event: unknown, node: FlowNode) => void; onNodesChange: (changes: NodeChange[]) => void;
  onNodeDragStop: (event: unknown, node: FlowNode) => void; onSelectionChange: (selection: { nodes: FlowNode[] }) => void;
  onMoveEnd: (event: unknown, viewport: Viewport) => void; onMove: (event: unknown, viewport: Viewport) => void;
  onConnect: (connection: Connection) => void; onEdgesDelete: (edges: Edge[]) => void;
};
const flow = vi.hoisted(() => ({ current: null as FlowProps | null, center: vi.fn(async () => true), viewport: vi.fn(), fit: vi.fn(async () => true), zoom: vi.fn(async () => true) }));
const nativeFetch = globalThis.fetch;
const servers: { server: Server; root: string }[] = [];
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  // This editing fixture completes renderer fits immediately. Both store APIs
  // expose that same ready state; the native camera suite exercises queued fits.
  const storeState = () => ({ width: window.innerWidth, height: window.innerHeight,
    panZoom: {}, nodes: flow.current?.nodes ?? [], fitViewQueued: false, transform: [0, 0, 1] });
  return {
    MarkerType: { ArrowClosed: 'arrowclosed' }, Position: { Left: 'left', Right: 'right' },
    useNodesState: (initial: FlowNode[]) => {
      const [nodes, setNodes] = React.useState(initial);
      const change = (changes: NodeChange[]) => setNodes(current => current.map(node => {
        const position = changes.find(item => 'id' in item && item.id === node.id && item.type === 'position');
        return position?.type === 'position' && position.position ? { ...node, position: position.position } : node;
      }));
      return [nodes, setNodes, change];
    },
    useStore: (select: (state: ReturnType<typeof storeState>) => unknown) => select(storeState()),
    useStoreApi: () => ({ getState: storeState, subscribe: () => () => undefined }),
    useReactFlow: () => ({ setCenter: flow.center, setViewport: flow.viewport, getZoom: () => 1 }),
    ReactFlow: (props: FlowProps) => {
      flow.current = props;
      React.useEffect(() => props.onInit({ fitView: flow.fit, getZoom: () => 1, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: flow.viewport, zoomTo: flow.zoom }), []);
      return <div data-testid="flow">{props.nodes.map(node => {
        const Node = props.nodeTypes[node.type!] as ComponentType<{ data: FlowNode['data']; selected: boolean }>;
        return <div key={node.id} data-testid={'node-' + node.id} onClick={event => props.onNodeClick(event, node)} onDoubleClick={event => props.onNodeDoubleClick(event, node)}><Node data={node.data} selected={false} /></div>;
      })}{props.children}</div>;
    },
    NodeResizer: () => null, Handle: () => null, Background: () => null, Controls: () => null, MiniMap: () => null,
  };
});

const source: AnswerSource = { canvasId: 'planning', canvasName: 'Planning', blockId: 'qa', title: 'QA report', excerpt: 'Two tests failed.', relevance: 1 };
const turn: AnswerCanvasTurn = {
  id: 1, query: 'What blocks launch?', answer: '', status: 'complete', sources: [source], patch: {
    query: 'What blocks launch?', blocks: [
      { id: 'risk', type: 'text', title: 'Launch risks', content: 'Two tests failed.', sourceIds: ['planning:qa'] },
      { id: 'next', type: 'task', title: 'Next actions', content: '- [ ] Re-run QA', sourceIds: [] },
    ], edges: [{ from: 'risk', to: 'next', label: 'unblocks' }],
  }
};
function props(overrides: Partial<Parameters<typeof AnswerCanvas>[0]> = {}) {
  return {
    turns: [turn], layout: 'mindmap' as const, theme: 'light' as const, edits: emptyResearchEdits(), canUndo: false, historyCount: 0, hasSavedCopy: false,
    onEditsChange: vi.fn<(edits: ResearchCanvasEdits) => void>(), onUndo: vi.fn(), onLayoutChange: vi.fn(), onSave: vi.fn(async () => ({ id: 'saved', name: 'Saved research' })), onOpenSavedCanvas: vi.fn(), onClose: vi.fn(), onOpenSource: vi.fn(), onRecheck: vi.fn(), ...overrides
  };
}
function held<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function upload(name: string, read: () => Promise<string>) { const file = new File([''], name); Object.defineProperty(file, 'text', { value: read }); return file; }
function Harness({ current }: { current: ReturnType<typeof props> }) {
  const [edits, setEdits] = useState<ResearchCanvasEdits>(current.edits);
  return <AnswerCanvas {...current} edits={edits} onEditsChange={next => { current.onEditsChange(next); setEdits(next); }} />;
}
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'planning', blocks: [{ id: 'qa', contentHash: 'new' }] })));
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
});
afterEach(async () => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); flow.current = null; flow.center.mockClear(); flow.viewport.mockClear(); flow.fit.mockClear();
  for (const { server, root } of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); }
});

describe('research canvas asynchronous ownership', () => {
  it('keeps a note created while an uploaded file is being read', async () => {
    const reading = held<string>(); const current = props(); const view = render(<Harness current={current} />);
    view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'upload', sequence: 1, files: [upload('evidence.md', () => reading.promise)] } }} />);
    view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'add', sequence: 2 } }} />); fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Manual context' } }); fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
    expect(await screen.findByRole('button', { name: 'Edit Manual context' })).toBeTruthy(); await act(async () => reading.resolve('# Uploaded evidence\n\nEvidence text'));
    expect(screen.getByRole('button', { name: 'Edit Manual context' })).toBeTruthy(); expect(screen.getByRole('button', { name: 'Edit evidence' })).toBeTruthy(); expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].added).toHaveLength(2);
  });

  it('does not show a stale completed-save receipt after the current canvas is edited during the save', async () => {
    const saving = held<{ id: string; name: string }>(); const current = props({ onSave: vi.fn(() => saving.promise) }); const view = render(<Harness current={current} />); fireEvent.click(screen.getByRole('button', { name: 'Save canvas' }));
    view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'add', sequence: 1 } }} />); fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Unsaved addition' } }); fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
    await act(async () => saving.resolve({ id: 'old-snapshot', name: 'Earlier snapshot' })); expect(screen.queryByText('Saved as Earlier snapshot.')).toBeNull(); expect(screen.getByRole('button', { name: 'Edit Unsaved addition' })).toBeTruthy();
  });

  it('clears an old freshness warning when the current session has no tracked source hashes', async () => {
    const current = props({ turns: [{ ...turn, sources: [{ ...source, contentHash: 'old' }] }] }); const view = render(<AnswerCanvas {...current} />); await screen.findByText('A cited source changed.');
    view.rerender(<AnswerCanvas {...current} turns={[turn]} />); await waitFor(() => expect(screen.queryByText('A cited source changed.')).toBeNull()); expect(screen.queryByText('Source freshness could not be checked right now.')).toBeNull();
  });

  it('does not apply a held upload after the research canvas is closed', async () => {
    const reading = held<string>(); const current = props(); const view = render(<AnswerCanvas {...current} />);
    view.rerender(<AnswerCanvas {...current} actionRequest={{ kind: 'upload', sequence: 1, files: [upload('late.md', () => reading.promise)] }} />); view.unmount(); await act(async () => reading.resolve('Late upload'));
    expect(current.onEditsChange).not.toHaveBeenCalled();
  });
});

describe('research canvas public editing and navigation', () => {
  it('keeps research documents visible without groups when zooming out', () => {
    render(<AnswerCanvas {...props()} />);
    expect(flow.current!.nodes.every(node => node.type === 'document')).toBe(true);
    act(() => {
      flow.current!.onMove(null, { x: 0, y: 0, zoom: .1 });
      flow.current!.onMoveEnd(null, { x: 0, y: 0, zoom: .1 });
    });
    expect(flow.current!.nodes).toHaveLength(2);
    expect(flow.current!.nodes.every(node => node.type === 'document')).toBe(true);
    expect(screen.queryByLabelText('Return to canvas group overview')).toBeNull();
    expect(screen.queryByText('Ungrouped')).toBeNull();
    act(() => flow.current!.onSelectionChange({ nodes: flow.current!.nodes }));
    expect(screen.queryByLabelText('Group selected documents')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect selected together' })).toBeTruthy();
  });

  it('renders an empty session, disables saving, and describes empty history before returning to the main canvas', () => {
    const current = props({ turns: [] }); render(<AnswerCanvas {...current} />); expect(screen.getByRole('heading', { name: 'Research' })).toBeTruthy(); expect(screen.getByText(/0 documents · 0 cited sources/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save canvas' }) as HTMLButtonElement).disabled).toBe(true); expect(screen.queryByRole('navigation', { name: 'Latest answer structure' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Session history' })); expect(screen.getByText('No manual changes yet.')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'a' }); expect(current.onClose).not.toHaveBeenCalled(); fireEvent.keyDown(window, { key: 'Escape' }); expect(current.onClose).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole('button', { name: 'Return to main canvas' })); expect(current.onClose).toHaveBeenCalledTimes(2);
  });

  it('focuses search and groups once per action request and finds, focuses, and clears search results', async () => {
    const current = props(); const view = render(<AnswerCanvas {...current} actionRequest={{ kind: 'search', sequence: 7 }} />); const input = screen.getByRole('textbox', { name: 'Find in research canvas' }); expect(document.activeElement).not.toBe(input);
    view.rerender(<AnswerCanvas {...current} actionRequest={{ kind: 'search', sequence: 8 }} />); expect(document.activeElement).toBe(input); input.blur(); view.rerender(<AnswerCanvas {...current} actionRequest={{ kind: 'search', sequence: 8 }} />); expect(document.activeElement).not.toBe(input);
    fireEvent.change(input, { target: { value: 'RISKS' } }); expect(screen.getByText('1 match')).toBeTruthy(); fireEvent.click(within(screen.getByRole('group', { name: 'Research search results' })).getByRole('button', { name: 'Launch risks' }));
    fireEvent.change(input, { target: { value: ' ' } }); expect(screen.getByText('No matching blocks')).toBeTruthy(); fireEvent.change(input, { target: { value: 'QA' } }); expect(screen.getByText('1 match')).toBeTruthy(); fireEvent.change(input, { target: { value: '' } }); expect(screen.queryByRole('group', { name: 'Research search results' })).toBeNull();
    view.rerender(<AnswerCanvas {...current} actionRequest={{ kind: 'groups', sequence: 9 }} />); await waitFor(() => expect(flow.viewport).toHaveBeenCalledWith({ x: 24, y: 68, zoom: .28 }, { duration: 300 }));
    view.rerender(<AnswerCanvas {...current} actionRequest={{ kind: 'groups', sequence: 10 }} />); expect(flow.viewport).toHaveBeenCalledTimes(2);
  });

  it('keeps question focus and the answer outline distinct from manually added notes and working turns', () => {
    const earlier = { ...turn, id: 0, query: 'Earlier question' }; const working = { ...turn, id: 2, query: 'Selecting evidence', status: 'working' as const, patch: undefined }; const current = props({ turns: [earlier, turn, working] }); const view = render(<AnswerCanvas {...current} />);
    expect(screen.getByText('Preparing sources and drawing the next answer…')).toBeTruthy(); fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'QA report ↗' })); expect(current.onOpenSource).toHaveBeenCalledWith(source);
    fireEvent.click(screen.getByRole('button', { name: 'Question 1: Earlier question' })); expect(screen.getByRole('button', { name: 'Question 1: Earlier question' }).getAttribute('aria-current')).toBe('step');
    fireEvent.click(screen.getByRole('button', { name: 'Question 3: Selecting evidence' })); expect(screen.getByRole('button', { name: 'Question 1: Earlier question' }).getAttribute('aria-current')).toBe('step');
    view.rerender(<AnswerCanvas {...current} turns={[earlier, turn]} />); fireEvent.click(screen.getByRole('button', { name: 'Step 2: Next actions' })); fireEvent.click(screen.getByRole('button', { name: 'Step 1: Launch risks' })); expect(screen.getByRole('button', { name: 'Question 2: What blocks launch?' }).getAttribute('aria-current')).toBe('step');
    const cyclic = { ...turn, patch: { ...turn.patch!, edges: [{ from: 'risk', to: 'next' }, { from: 'next', to: 'risk' }] } }; view.rerender(<AnswerCanvas {...current} turns={[cyclic]} />); expect(screen.getByText('Answer outline · 2 steps')).toBeTruthy();
  });

  it('creates a note in an empty session, validates blank titles, and supports all editor close controls', async () => {
    vi.stubGlobal('crypto', {}); const current = props({ turns: [] }); const view = render(<Harness current={current} />); const add = (sequence: number) => view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'add', sequence } }} />);
    add(1); fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: '  ' } }); fireEvent.click(screen.getByRole('button', { name: 'Save document' })); expect(screen.getByRole('dialog', { name: 'Document editor' })).toBeTruthy(); expect(current.onEditsChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: '  Manual note  ' } }); fireEvent.change(screen.getByRole('combobox', { name: 'Loader' }), { target: { value: 'website' } }); fireEvent.change(screen.getByRole('combobox', { name: 'Loader' }), { target: { value: 'markdown' } });
    const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))!; act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '# Context\n\nSaved local text' } })); fireEvent.click(screen.getByRole('button', { name: 'Save document' })); expect(await screen.findByRole('button', { name: 'Edit Manual note' })).toBeTruthy();
    expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].added[0]).toMatchObject({ turnId: 0, title: 'Manual note', content: '# Context\n\nSaved local text', x: 80, y: 80 }); expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].added[0].id).toMatch(/^user:/);
    add(2); fireEvent.click(screen.getByRole('button', { name: 'Close dialog' })); expect(screen.queryByRole('dialog')).toBeNull(); add(3); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); add(4); fireEvent.mouseDown(screen.getByRole('dialog')); expect(screen.getByRole('dialog')).toBeTruthy(); fireEvent.mouseDown(document.querySelector('.modal-overlay')!); expect(screen.queryByRole('dialog')).toBeNull(); add(5); fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(current.onClose).not.toHaveBeenCalled();
  });

  it('reads pages, follows citations, changes documents, edits checked content through live preview, and deletes a local block', async () => {
    const current = props(); render(<Harness current={current} />); fireEvent.click(screen.getByRole('button', { name: 'Read Launch risks full page' })); let reader = screen.getByRole('dialog', { name: 'Launch risks full page' }); expect((within(reader).getByRole('button', { name: 'Previous document' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(reader).getByRole('button', { name: 'QA report ↗' })); expect(current.onOpenSource).toHaveBeenCalledWith(source); fireEvent.click(within(reader).getByRole('button', { name: 'Next document' })); reader = screen.getByRole('dialog', { name: 'Next actions full page' }); expect((within(reader).getByRole('button', { name: 'Next document' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(reader).getByRole('checkbox')); await waitFor(() => expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].changed['1:next'].content).toContain('[x]'));
    fireEvent.click(within(reader).getByRole('button', { name: 'Previous document' })); reader = screen.getByRole('dialog', { name: 'Launch risks full page' }); fireEvent.change(within(reader).getByRole('combobox', { name: 'Jump to document' }), { target: { value: '1:next' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' })); const dialog = screen.getByRole('dialog', { name: 'Document editor' }); expect(screen.queryByRole('dialog', { name: 'Next actions full page' })).toBeNull(); fireEvent.click(within(dialog).getByRole('button', { name: 'Split' })); expect(screen.getByText('Source and live preview')).toBeTruthy(); fireEvent.click(within(screen.getByRole('region', { name: 'Document preview' })).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' })); expect(screen.getByText('Live preview')).toBeTruthy(); fireEvent.click(within(dialog).getByRole('button', { name: 'Source' })); const input = within(dialog).getByRole('textbox', { name: 'Markdown source' }); fireEvent.keyDown(input, { key: 'e', code: 'KeyE', ctrlKey: true }); expect(screen.getByText('Live preview')).toBeTruthy(); fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: '  Checked next actions  ' } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Save document' })); expect(await screen.findByRole('button', { name: 'Edit Checked next actions' })).toBeTruthy(); expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].changed['1:next']).toMatchObject({ title: 'Checked next actions', content: '- [ ] Re-run QA' });
    fireEvent.click(screen.getByRole('button', { name: 'Read Launch risks full page' })); fireEvent.click(screen.getByRole('button', { name: '← Back to canvas' })); fireEvent.click(screen.getByRole('button', { name: 'Read Launch risks full page' })); fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Checked next actions' })); fireEvent.click(within(screen.getByRole('dialog', { name: 'Document editor' })).getByRole('button', { name: 'Delete' })); expect(screen.queryByRole('button', { name: 'Edit Checked next actions' })).toBeNull(); expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].deleted).toContain('1:next');
  });

  it('describes one and several history actions, exposes Undo, and closes history before the main canvas on Escape', () => {
    const current = props({ canUndo: true, historyCount: 1 }); const view = render(<AnswerCanvas {...current} />); fireEvent.click(screen.getByRole('button', { name: 'History for Launch risks' })); expect(screen.getByText(/1 manual action in this session/)).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Undo last action' })); expect(current.onUndo).toHaveBeenCalledOnce();
    view.rerender(<AnswerCanvas {...current} historyCount={2} />); expect(screen.getByText(/2 manual actions in this session/)).toBeTruthy(); fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(current.onClose).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Undo' })); expect(current.onUndo).toHaveBeenCalledTimes(2);
  });

  it('finds and focuses similar content and titles, duplicates without overlapping cards, and closes duplicate review', async () => {
    const note = { id: 'manual', turnId: 1, type: 'text' as const, title: 'Launch risks review', content: 'Other context', markdown: '', sources: [], x: 520, y: 145 };
    const current = props({ edits: { ...emptyResearchEdits(), added: [note] } }); render(<Harness current={current} />); const open = () => { fireEvent.click(screen.getByRole('button', { name: 'Find similar research blocks for Launch risks' })); };
    open(); expect(screen.getByText('Review possible duplicates in this research session.')).toBeTruthy(); fireEvent.click(within(screen.getByRole('dialog', { name: 'Compare similar research blocks' })).getByRole('button', { name: 'Launch risks review' })); expect(screen.queryByRole('dialog')).toBeNull(); open(); fireEvent.click(screen.getByRole('button', { name: 'Duplicate this block' })); expect(await screen.findByRole('button', { name: 'Edit Launch risks copy' })).toBeTruthy(); const copy = vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].added.at(-1); expect(copy).toMatchObject({ title: 'Launch risks copy', x: 520, y: 535 });
    fireEvent.click(screen.getByRole('button', { name: 'Find similar research blocks for Next actions' })); expect(screen.getByText('No similar blocks found in this session.')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Close' })); open(); fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(current.onClose).not.toHaveBeenCalled();
  });
});

describe('research canvas save, export, uploads, and source checks', () => {
  it('uses the source excerpt when a saved evidence reference has an empty passage', () => {
    const evidence = { claim: 'A persisted claim', passage: '', passageKind: 'approximation' as const, canvasId: 'planning', documentId: 'qa', checkedAt: '2026-01-01T00:00:00Z', navigation: { kind: 'document' as const, canvasId: 'planning', blockId: 'qa' } };
    render(<AnswerCanvas {...props({ turns: [{ ...turn, sources: [{ ...source, evidence }] }] })} />); const quote = screen.getByRole('group', { name: 'Research source evidence' }).querySelector('blockquote'); expect(quote?.textContent).toBe(source.excerpt);
  });
  it.each([new Error('Save temporarily unavailable'), 'unexpected failure'])('retains local changes after a save error and retries to an openable saved copy: %s', async failure => {
    const onSave = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ id: 'saved', name: 'Saved research' }); const current = props({ onSave }); render(<AnswerCanvas {...current} />); fireEvent.click(screen.getByRole('button', { name: 'Save canvas' })); expect((await screen.findByRole('alert')).textContent).toBe(failure instanceof Error ? failure.message : 'Saving the research canvas failed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save canvas' })); await screen.findByText('Saved as Saved research.'); expect(screen.queryByRole('alert')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Open saved canvas ↗' })); expect(current.onOpenSavedCanvas).toHaveBeenCalledWith('saved', 'Saved research'); expect(onSave).toHaveBeenCalledTimes(2); expect(onSave).toHaveBeenLastCalledWith('mindmap');
  });

  it('changes layout, names subsequent save copies, and downloads the current edited Markdown with URL cleanup', async () => {
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:research'); const revoke = vi.fn(); vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; }); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { }); const current = props({ hasSavedCopy: true }); render(<AnswerCanvas {...current} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Research layout' }), { target: { value: 'architecture' } }); expect(current.onLayoutChange).toHaveBeenCalledWith('architecture'); fireEvent.click(screen.getByRole('button', { name: 'Save new copy' })); await screen.findByText('Saved as Saved research.');
    vi.useFakeTimers(); fireEvent.click(screen.getByRole('button', { name: 'Export Markdown' })); expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob); expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('research-canvas.md'); const blob = create.mock.calls[0]?.[0] as Blob; expect(blob.type).toBe('text/markdown;charset=utf-8'); act(() => vi.advanceTimersByTime(1000)); expect(revoke).toHaveBeenCalledWith('blob:research');
  });

  it.each([new Error('File read failed'), 'unknown read failure'])('reports file-read failures and permits an upload retry: %s', async failure => {
    const current = props(); const view = render(<Harness current={current} />); view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'upload', sequence: 1, files: [upload('bad.md', async () => { throw failure; })] } }} />);
    expect((await screen.findByRole('alert')).textContent).toBe(failure instanceof Error ? failure.message : 'Could not add the selected files.'); expect(current.onEditsChange).not.toHaveBeenCalled(); view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'upload', sequence: 2, files: [upload('fixed.md', async () => '# Corrected upload')] } }} />); expect(await screen.findByRole('button', { name: 'Edit fixed' })).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores empty upload actions and places multiple files below existing content', async () => {
    const current = props(); const view = render(<Harness current={current} />); view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'upload', sequence: 1 } }} />); view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'upload', sequence: 2, files: [] } }} />); expect(current.onEditsChange).not.toHaveBeenCalled();
    view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'upload', sequence: 3, files: ['one', 'two', 'three'].map(name => upload(name + '.md', async () => name)) } }} />); await screen.findByRole('button', { name: 'Edit three' }); expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].added.map(block => [block.x, block.y])).toEqual([[80, 495], [510, 495], [80, 825]]);
  });

  it('ignores an unsupported action request without changing the session', () => {
    const current = props(); const view = render(<AnswerCanvas {...current} />); const actionRequest = { kind: 'unsupported', sequence: 1 } as unknown as Parameters<typeof AnswerCanvas>[0]['actionRequest']; view.rerender(<AnswerCanvas {...current} actionRequest={actionRequest} />); expect(current.onEditsChange).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByText(/2 documents · 1 cited source/)).toBeTruthy();
  });

  it('shows exact and approximate evidence with revision/hash provenance with cited source counts', () => {
    const evidence = { claim: 'Checked claim', passage: 'Quoted passage', passageKind: 'exact' as const, canvasId: 'planning', documentId: 'qa', checkedAt: '2026-01-01T00:00:00Z', navigation: { kind: 'document' as const, canvasId: 'planning', blockId: 'qa' } };
    const sources = [{ ...source, evidence: { ...evidence, revision: 'abc123' } }, { ...source, blockId: 'other', title: 'Other evidence', evidence: { ...evidence, passageKind: 'approximation' as const, contentHash: 'hash-123' } }, { ...source, blockId: 'plain', title: 'Plain evidence', evidence }];
    const blocks = ['supported', 'unsupported', 'unverified'].map((status, index) => ({ id: String(index), type: 'text' as const, title: 'Claim ' + index, content: 'Answer claim', sourceIds: [], verification: { status: status as 'supported', checkedClaims: index, totalClaims: 3 } })); const current = props({ turns: [{ ...turn, sources, patch: { query: turn.query, blocks, edges: [] } }] }); render(<AnswerCanvas {...current} />);
    expect(screen.getByText(/Sources · 3 cited/)).toBeTruthy(); expect(screen.getByText(/Revision abc123/)).toBeTruthy(); expect(screen.getByText(/Hash hash-123/)).toBeTruthy(); expect(screen.getAllByText(/Exact passage/)).toHaveLength(2); expect(screen.getByText(/Approximate context/)).toBeTruthy(); fireEvent.click(screen.getAllByRole('button', { name: 'Read source ↗' })[0]); expect(current.onOpenSource).toHaveBeenCalledWith(sources[0]);
    expect(screen.queryByRole('region', { name: 'Research block verification' })).toBeNull();
  });

  it('reports unavailable freshness, retries on the polling interval, and offers rechecking changed sources', async () => {
    vi.useFakeTimers(); vi.mocked(fetch).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(Response.json({ id: 'planning', blocks: [{ id: 'qa', contentHash: 'old' }] })).mockResolvedValueOnce(Response.json({ id: 'planning', blocks: [] })); const current = props({ turns: [{ ...turn, sources: [{ ...source, contentHash: 'old' }] }] }); render(<AnswerCanvas {...current} />);
    await act(async () => { }); expect(screen.getByText('Source freshness could not be checked right now.')).toBeTruthy(); await act(async () => vi.advanceTimersByTimeAsync(8000)); expect(screen.queryByText('Source freshness could not be checked right now.')).toBeNull(); expect(screen.queryByText('A cited source changed.')).toBeNull(); await act(async () => vi.advanceTimersByTimeAsync(8000)); fireEvent.click(screen.getByRole('button', { name: 'Recheck the latest documents' })); expect(current.onRecheck).toHaveBeenCalledOnce();
  });

  it.each(['success', 'failure'] as const)('ignores freshness %s from a previous source fingerprint', async outcome => {
    const check = held<Response>(); vi.mocked(fetch).mockReturnValue(check.promise); const current = props({ turns: [{ ...turn, sources: [{ ...source, contentHash: 'old' }] }] }); const view = render(<AnswerCanvas {...current} />); view.rerender(<AnswerCanvas {...current} turns={[turn]} />); await act(async () => { if (outcome === 'success') check.resolve(Response.json({ id: 'planning', blocks: [] })); else check.reject(new Error('Late connection failure')); }); expect(screen.queryByText('A cited source changed.')).toBeNull(); expect(screen.queryByText('Source freshness could not be checked right now.')).toBeNull();
  });
});

describe('research canvas composed interaction boundaries', () => {
  it('publishes visible answers and citations at each zoom level and resets the selected answer after clearing selection', () => {
    const onViewFocusChange = vi.fn(); const current = props({ onViewFocusChange }); render(<AnswerCanvas {...current} />); const stage = document.querySelector('.canvas-flow-stage')!; vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 2000, 1500));
    act(() => flow.current!.onMoveEnd({}, { x: 0, y: 0, zoom: 1 })); expect(onViewFocusChange).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'sources', visibleAnswerIds: [1], visibleSourceKeys: ['planning:qa'], visibleBlockIds: ['1:risk', '1:next'] }));
    act(() => flow.current!.onMoveEnd({}, { x: 0, y: 0, zoom: .7 })); expect(onViewFocusChange).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'answers' })); act(() => flow.current!.onMoveEnd({}, { x: 0, y: 0, zoom: .4 })); expect(onViewFocusChange).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'big-picture' }));
    const nodes = flow.current!.nodes.filter(node => node.type === 'document'); act(() => flow.current!.onSelectionChange({ nodes: [nodes[0]] })); expect(onViewFocusChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedBlockId: '1:risk', selectedAnswerId: 1 })); act(() => flow.current!.onSelectionChange({ nodes: [] })); expect(onViewFocusChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedBlockId: undefined, selectedAnswerId: undefined }));
  });

  it('moves research documents independently without assigning groups', async () => {
    const current = props(); render(<Harness current={current} />);
    const node = flow.current!.nodes.find(node => node.id === '1:risk')!;
    act(() => flow.current!.onNodesChange([{ type: 'position', id: node.id, position: { x: 500, y: 300 } }]));
    act(() => flow.current!.onNodeDragStop({}, flow.current!.nodes.find(item => item.id === node.id)!));
    await waitFor(() => expect(current.onEditsChange).toHaveBeenCalled());
    expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)![0].changed).toEqual({ '1:risk': { x: 500, y: 300 } });
  });

  it('retains focus across a StrictMode effect restart and lets a new draft preview update task content', async () => {
    const current = props(); const view = render(<StrictMode><Harness current={current} /></StrictMode>); view.rerender(<StrictMode><Harness current={{ ...current, actionRequest: { kind: 'add', sequence: 1 } }} /></StrictMode>);
    const input = screen.getByRole('textbox', { name: 'Markdown source' }); const editor = EditorView.findFromDOM(input)!; act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '- [ ] New task' } }));
    act(() => { fireEvent.keyDown(input, { key: 'e', code: 'KeyE', ctrlKey: true }); fireEvent.keyDown(input, { key: 'e', code: 'KeyE', ctrlKey: true }); }); expect(screen.getByText('Document content')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Preview' })); fireEvent.click(within(screen.getByRole('region', { name: 'Document preview' })).getByRole('checkbox'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Previewed task' } }); fireEvent.click(screen.getByRole('button', { name: 'Save document' })); expect(await screen.findByRole('button', { name: 'Edit Previewed task' })).toBeTruthy(); expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].added.at(-1)?.content).toBe('- [x] New task');
  });

  it('ignores legacy verification records without showing source scores', () => {
    const verification = { status: 'unverified' } as ResearchCanvasBlock['verification']; render(<AnswerCanvas {...props({ turns: [{ ...turn, sources: [], patch: { query: turn.query, blocks: [{ ...turn.patch!.blocks[0], verification }], edges: [] } }] })} />); expect(screen.queryByText(/Unverified \(0\/0 claims checked\)/)).toBeNull();
  });

  it('adds an upload to an empty session and ignores a late read error after closing the canvas', async () => {
    const current = props({ turns: [] }); const view = render(<Harness current={current} />); view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'upload', sequence: 1, files: [upload('empty-session.md', async () => 'Note without an answer')] } }} />); await screen.findByRole('button', { name: 'Edit empty-session' }); expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].added[0].turnId).toBe(0);
    const reading = held<string>(); view.rerender(<Harness current={{ ...current, actionRequest: { kind: 'upload', sequence: 2, files: [upload('late.md', () => reading.promise)] } }} />); view.unmount(); const calls = vi.mocked(current.onEditsChange).mock.calls.length; await act(async () => reading.reject(new Error('Late read failure'))); expect(current.onEditsChange).toHaveBeenCalledTimes(calls);
  });

  it('handles a missing cited document and safely ignores stale loader patches and repeated model saves', async () => {
    const saving = held<{ id: string; name: string }>(); const current = props({ onSave: vi.fn(() => saving.promise) }); const { result } = renderHook(() => useAnswerCanvas(current));
    act(() => result.current.openSourceLink('absent', 'missing')); expect(current.onOpenSource).not.toHaveBeenCalled(); await act(async () => result.current.updateDraft('draft', { title: 'A metadata-only patch' })); act(() => result.current.addBlock()); await act(async () => result.current.updateDraft('draft', { content: 'Latest draft' })); expect(result.current.draft?.content).toBe('Latest draft'); act(() => result.current.setDraft(null)); await act(async () => result.current.updateDraft('draft', { content: 'Late loader content' })); expect(result.current.draft).toBeNull();
    await act(async () => result.current.moveBlocks([{ blockId: '1:risk', x: 250, y: 160, group: null }, { blockId: '1:next', x: 650, y: 160 }])); expect(vi.mocked(current.onEditsChange).mock.calls.at(-1)?.[0].changed).toMatchObject({ '1:risk': { x: 250, y: 160, group: null }, '1:next': { x: 650, y: 160 } });
    let pending!: Promise<void>; act(() => { pending = result.current.save(); }); await act(async () => result.current.save()); expect(current.onSave).toHaveBeenCalledOnce(); await act(async () => { saving.resolve({ id: 'saved', name: 'Saved research' }); await pending; }); expect(result.current.saving).toBe(false);
    act(() => result.current.viewChanged({ x: 0, y: 0, zoom: 1 }, ['1:risk'], { level: 'overview', visibleGroups: [] }));
  });
});

function PersistedSession({ canvas, workspaces, current }: { canvas: CanvasDocument; workspaces: WorkspaceSummary[]; current: ReturnType<typeof props> }) {
  const state = useAppState(); const actions = useResearchSession(state);
  useEffect(() => { state.setCanvas(canvas); state.setWorkspaces(workspaces); state.setAnswerTurns(current.turns); }, [canvas, workspaces]);
  return <AnswerCanvas {...current} turns={state.answerTurns} edits={state.researchState.edits} layout={state.researchLayout}
    canUndo={state.researchState.history.length > 0} historyCount={state.researchState.history.length} hasSavedCopy={state.researchSaveCount > 0}
    onEditsChange={actions.changeResearchEdits} onUndo={actions.undoResearchEdit} onLayoutChange={state.setResearchLayout} onSave={actions.saveResearchCanvas} />;
}

describe('research canvas real persistence and readback', () => {
  it('keeps failed saves recoverable, persists edited content and remapped links, and creates another independently readable copy', async () => {
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', ''); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', ''); const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-answer-canvas-'));
    const server = await createApiServer({ dataDir: root }); servers.push({ server, root }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing API address'); const base = 'http://127.0.0.1:' + address.port;
    let writes = 0; let failBlock = true; vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const route = String(input); if (options?.method === 'POST' && route.endsWith('/blocks')) { writes++; if (failBlock && writes === 2) { failBlock = false; return Response.json({ error: 'Document write temporarily unavailable' }, { status: 503 }); } }
      return nativeFetch(base + route, options);
    }));
    const store = new CanvasStore(root); const workspaces = await store.listWorkspaces(); const canvas = await store.getCanvas('product-roadmap'); const cited = canvas.blocks.find(block => block.id === 'roadmap-overview')!;
    const current = props({ turns: [{ ...turn, sources: [{ ...source, canvasId: canvas.id, canvasName: canvas.name, blockId: cited.id, title: cited.title }], patch: { ...turn.patch!, blocks: [{ ...turn.patch!.blocks[0], sourceIds: [canvas.id + ':' + cited.id] }, turn.patch!.blocks[1]] } }] });
    render(<PersistedSession current={current} canvas={canvas} workspaces={workspaces} />); fireEvent.click(await screen.findByRole('button', { name: 'Edit Launch risks' })); fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Reviewed launch risks' } }); fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save canvas' })); expect((await screen.findByRole('alert')).textContent).toBe('Document write temporarily unavailable'); expect(await store.listWorkspaces()).toEqual(workspaces); expect(screen.getByRole('button', { name: 'Edit Reviewed launch risks' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save canvas' })); await screen.findByText('Saved as Research — What blocks launch?.', {}, { timeout: 5000 }); const summaries = (await new CanvasStore(root).listWorkspaces()).flatMap(workspace => workspace.canvases); const created = summaries.find(item => item.name === 'Research — What blocks launch?')!; const saved = await new CanvasStore(root).getCanvas(created.id);
    const risk = saved.blocks.find(block => block.title === 'Reviewed launch risks')!; const next = saved.blocks.find(block => block.title === 'Next actions')!; expect(risk.content).toContain('# Reviewed launch risks'); expect(risk.content).toContain('## Sources'); expect(risk.links).toEqual([next.id]); expect(risk.crossLinks).toEqual([{ canvasId: canvas.id, blockId: cited.id, relation: 'related' }]); expect(saved.blocks).toHaveLength(2); expect((await store.getCanvas(canvas.id)).blocks.map(block => [block.id, block.content, block.x, block.y])).toEqual(canvas.blocks.map(block => [block.id, block.content, block.x, block.y]));
    fireEvent.click(screen.getByRole('button', { name: 'Save new copy' })); await screen.findByText('Saved as Research — What blocks launch? (2).', {}, { timeout: 5000 }); fireEvent.click(screen.getByRole('button', { name: 'Open saved canvas ↗' })); const second = (await store.listWorkspaces()).flatMap(workspace => workspace.canvases).find(item => item.name === 'Research — What blocks launch? (2)')!; expect(current.onOpenSavedCanvas).toHaveBeenCalledWith(second.id, second.name); expect(second.id).not.toBe(created.id); expect((await new CanvasStore(root).getCanvas(second.id)).blocks.map(block => [block.title, block.content])).toEqual(saved.blocks.map(block => [block.title, block.content]));
  }, 15000);
});
