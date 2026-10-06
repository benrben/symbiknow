// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Edge, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { Canvas } from './Canvas';
import { nodeTypes } from './CanvasNodes';
import type { CanvasNode, CanvasProps, FlowNode, GroupNode } from './canvas-types';
import { useCanvasState } from './canvas-state';
import { useCanvasGraph } from './canvas-graph';
import { useCanvasViewport, zoomBandFor } from './canvas-viewport';
import { useCanvasJourney } from './useCanvasJourney';

function block(id: string, extra: Partial<CanvasBlock> = {}): CanvasBlock { return { id, title: 'Document ' + id, file: id + '.md', kind: 'markdown', content: '# Evidence ' + id, x: 10, y: 20, width: 320, height: 240, links: [], ...extra }; }
function canvas(blocks: CanvasBlock[] = [block('a', { group: 'custom:launch/notes' })], id = 'planning'): CanvasDocument { return { id, name: 'Canvas ' + id, workspaceId: 'team', blocks }; }
function props(document = canvas(), callback: CanvasProps['onViewportChange'] = vi.fn()): CanvasProps {
  return { canvas: document, onUpdateBlock: vi.fn(async () => undefined), onDeleteBlock: vi.fn(async () => undefined), onSelectBlock: vi.fn(), onViewportChange: callback };
}
function documentNode(value: CanvasBlock, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: value.id, type: 'document', position: { x: value.x, y: value.y }, width: value.width, height: value.height,
    data: { block: value, canvasId: 'planning', highlighted: false, onUpdateBlock: vi.fn(async () => undefined), onOpenBlock: vi.fn(), onReadBlock: vi.fn(), onHistoryBlock: vi.fn(), onOpenCrossLink: vi.fn(), onFindDuplicates: vi.fn(), onAnalyzeBlock: vi.fn(), onResize: vi.fn(), onError: vi.fn() }, ...extra
  };
}
function groupNode(group: string, x = 0, y = 0, extra: Partial<GroupNode> = {}): GroupNode {
  return {
    id: 'group:' + group, type: 'groupFrame', position: { x, y }, width: 100, height: 100,
    data: { group, title: group, count: 1, tone: 0, width: 100, height: 100, depth: 0, collapsed: false, overview: true, topTitles: [], onDrill: vi.fn(), onCollapse: vi.fn(), onHover: vi.fn() }, ...extra
  };
}
const originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
const originalUrl = window.location.href;
let flow: ReactFlowInstance<FlowNode, Edge> | null = null;
function FlowAccess() {
  const instance = useReactFlow<FlowNode, Edge>();
  const ready = useStore(state => Boolean(state.panZoom));
  useEffect(() => {
    if (ready) flow = instance;
    return () => { if (flow === instance) flow = null; };
  }, [instance, ready]);
  return null;
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: function (this: SVGElement) { return new DOMRect(0, 0, (this.textContent?.length ?? 0) * 7, 14); } });
  vi.stubGlobal('DOMMatrixReadOnly', class {
    readonly m22: number; constructor(transform: string) {
      const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
      const scale = /scale\(([^)]+)\)/.exec(transform);
      this.m22 = matrix ? Number(matrix[1].split(',')[3]) : scale ? Number(scale[1].split(',').at(-1)) : 1;
    }
  });
  vi.stubGlobal('ResizeObserver', class {
    private targets = new Set<Element>(); constructor(private callback: ResizeObserverCallback) { }
    observe(target: Element) {
      this.targets.add(target);
      queueMicrotask(() => { if (this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver); });
    }
    unobserve(target: Element) { this.targets.delete(target); } disconnect() { this.targets.clear(); }
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.style.width.endsWith('px') ? Number.parseFloat(this.style.width) : 1000; });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.style.height.endsWith('px') ? Number.parseFloat(this.style.height) : 800; });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const element = this as HTMLElement;
    return new DOMRect(0, 0, element.style?.width.endsWith('px') ? Number.parseFloat(element.style.width) : 1000, element.style?.height.endsWith('px') ? Number.parseFloat(element.style.height) : 800);
  });
});
afterEach(() => {
  cleanup();
  flow = null;
  window.history.replaceState(null, '', originalUrl);
  if (originalBBox) Object.defineProperty(SVGElement.prototype, 'getBBox', originalBBox); else Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});
type Configuration = { pinned?: boolean; enteringFiles?: boolean; parent?: string; supergroup?: string; hovered?: string; intent?: 'in' | 'out'; target?: string; drill?: string; board?: boolean };
type BoundaryProps = { canvasProps: CanvasProps; nodes: FlowNode[]; viewport?: Viewport; configuration?: Configuration; measured?: boolean; surface?: boolean; native?: boolean; bounds?: { width: number; height: number } };
// Mount the exported hook with the actual canvas state/graph and renderer. Compatibility
// consumers may supply partially measured nodes or a temporarily absent measuring surface.
function ViewportBoundary({ canvasProps, nodes, viewport = { x: 0, y: 0, zoom: 1 }, configuration = {}, measured = true, surface = true, native = true, bounds = { width: 1000, height: 800 } }: BoundaryProps) {
  const state = useCanvasState(canvasProps);
  const graph = useCanvasGraph(canvasProps, state);
  const [opened, setOpened] = useState('');
  const [, redraw] = useState(0);
  const handlers = useCanvasViewport(state, graph, canvasProps, nodes, setOpened);
  function configure() {
    state.setMapPinned(Boolean(configuration.pinned));
    state.setMapParent(configuration.parent ?? '');
    state.setActiveSupergroup(configuration.supergroup ?? '');
    state.setHoveredGroup(configuration.hovered ?? null);
    state.setDrillGroup(configuration.drill ?? '');
    state.setShowDrillBoard(Boolean(configuration.board));
    state.enteringFiles.current = Boolean(configuration.enteringFiles);
    state.zoomIntent.current = configuration.intent ?? null;
    state.zoomTarget.current = configuration.target ?? null;
    redraw(value => value + 1);
  }
  const snapshot = {
    zoom: state.zoom, band: state.zoomBand.current, pinned: state.mapPinned, parent: state.mapParent, supergroup: state.activeSupergroup,
    drill: state.drillGroup, board: state.showDrillBoard, enteringFiles: state.enteringFiles.current, intent: state.zoomIntent.current, target: state.zoomTarget.current,
    remembered: [...state.rememberedViewports.current]
  };
  return <>
    <button onClick={configure}>Configure viewport</button>
    <button onClick={() => {
      handlers.moved(null, viewport);
      redraw(value => value + 1);
    }}>Move viewport</button>
    <button onClick={() => {
      handlers.moveEnded(null, viewport);
      redraw(value => value + 1);
    }}>Publish viewport</button>
    <output aria-label="Viewport state">{JSON.stringify(snapshot)}</output><output aria-label="Opened group">{opened}</output>
    <section aria-label="Viewport surface" ref={surface ? state.surface : undefined}>
      <div className={measured ? 'canvas-flow-stage' : 'unmeasured-stage'} style={{ width: bounds.width, height: bounds.height }}>
        {native && <ReactFlow<FlowNode, Edge> nodes={nodes} edges={[]} nodeTypes={nodeTypes} minZoom={.005} maxZoom={2.5}
          onInit={instance => { state.flowInstance.current = instance; }} onMove={handlers.moved} onMoveEnd={handlers.moveEnded}><FlowAccess /></ReactFlow>}
      </div>
    </section>
  </>;
}
function boundary(options: BoundaryProps) { return render(<ReactFlowProvider><ViewportBoundary {...options} /></ReactFlowProvider>); }
function configure() { fireEvent.click(screen.getByRole('button', { name: 'Configure viewport' })); }
function publish() { fireEvent.click(screen.getByRole('button', { name: 'Publish viewport' })); }
function move() { fireEvent.click(screen.getByRole('button', { name: 'Move viewport' })); }
function snapshot(): { zoom: number; band: string; pinned: boolean; parent: string; supergroup: string; enteringFiles: boolean; drill: string; board: boolean; intent: string | null; target: string | null; remembered: [string, Viewport][] } { return JSON.parse(screen.getByLabelText('Viewport state').textContent ?? '{}'); }
function opened() { return screen.getByLabelText('Opened group').textContent; }
function instance() {
  if (!flow) throw new Error('Native flow is not ready');
  return flow;
}
async function setViewport(viewport: Viewport) {
  await waitFor(() => expect(instance()).toBeTruthy());
  await act(async () => { await instance().setViewport(viewport, { duration: 0 }); });
}

describe('public viewport boundaries and camera ownership', () => {
  it.each([[.005, 'overview'], [.339999, 'overview'], [.34, 'titles'], [.749999, 'titles'], [.75, 'full'], [2.5, 'full']] as const)('classifies zoom %s as %s', (zoom, band) => { expect(zoomBandFor(zoom)).toBe(band); });
  it('updates styles on every move but updates the zoom state only across a band boundary, then publishes the final position', () => {
    const changed = vi.fn();
    const current = props(canvas(), changed);
    const options = { canvasProps: current, nodes: [], native: false, viewport: { x: 10, y: 20, zoom: .6 } };
    const ui = boundary(options);
    move();
    expect(snapshot()).toMatchObject({ zoom: .6, band: 'titles' });
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...options} viewport={{ x: 12, y: 23, zoom: .5 }} /></ReactFlowProvider>);
    move();
    expect(snapshot().zoom).toBe(.6);
    expect(screen.getByRole('region', { name: 'Viewport surface' }).style.getPropertyValue('--canvas-label-scale')).toBe('2');
    publish();
    expect(snapshot().zoom).toBe(.5);
    expect(changed).toHaveBeenLastCalledWith({ x: 12, y: 23, zoom: .5 }, [], expect.objectContaining({ visibleGroups: ['custom:launch', 'custom:launch/notes'] }));
  });
  it('keeps file transitions from repinning early, clears transition ownership at full zoom, and resets drill/board/intents on entering the overview', () => {
    const current = props();
    const options = { canvasProps: current, nodes: [], native: false, configuration: { enteringFiles: true, drill: 'custom:launch', board: true, intent: 'in' as const, target: 'custom:launch' } };
    const ui = boundary({ ...options, viewport: { x: 0, y: 0, zoom: .2 } });
    configure();
    move();
    expect(snapshot()).toMatchObject({ pinned: false, enteringFiles: true, drill: 'custom:launch', board: true });
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...options} viewport={{ x: 0, y: 0, zoom: .75 }} /></ReactFlowProvider>);
    move();
    expect(snapshot().enteringFiles).toBe(false);
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...options} viewport={{ x: 0, y: 0, zoom: .2 }} /></ReactFlowProvider>);
    move();
    expect(snapshot()).toMatchObject({ pinned: true, enteringFiles: false, drill: '', board: false, intent: null, target: null });
    expect(screen.getByRole('region', { name: 'Viewport surface' }).style.getPropertyValue('--canvas-label-scale')).toBe(String(1 / .28));
    expect(screen.getByRole('region', { name: 'Viewport surface' }).style.getPropertyValue('--canvas-map-summary-opacity')).toBe(String((.2 - .1) / .12));
  });
  it('enters the overview when only the final movement callback arrives, resetting drill and board state', () => {
    boundary({
      canvasProps: props(), nodes: [], native: false, viewport: { x: 24, y: 68, zoom: .2 },
      configuration: { drill: 'custom:launch', board: true, intent: 'in', target: 'custom:launch' }
    });
    configure();
    publish();
    expect(snapshot()).toMatchObject({ zoom: .2, band: 'overview', pinned: true, drill: '', board: false, intent: null, target: null });
  });
  it.each([
    { name: 'intended before hovered', config: { target: 'custom:first', hovered: 'custom:second' }, expected: 'custom:first' },
    { name: 'hovered when target disappeared', config: { target: 'custom:missing', hovered: 'custom:second' }, expected: 'custom:second' },
    { name: 'nearest when neither target matches', config: { target: 'custom:missing', hovered: 'custom:missing' }, expected: 'custom:second' },
  ])('opens the $name map group using current bounds', ({ config, expected }) => {
    const nodes = [groupNode('custom:first', 0, 0), groupNode('custom:second', 900, 650), groupNode('custom:last', 2000, 2000), documentNode(block('doc'))];
    boundary({ canvasProps: props(), nodes, native: false, viewport: { x: 0, y: 0, zoom: .5 }, configuration: { pinned: true, intent: 'in', ...config } });
    configure();
    publish();
    expect(opened()).toBe(expected);
    expect(snapshot()).toMatchObject({ intent: null, target: null });
  });
  it('uses the default bounds and group dimensions when measurement is unavailable, retaining the first equally near group', () => {
    const nodes = [groupNode('custom:first', 0, 0, { width: undefined, height: undefined }), groupNode('custom:second', 900, 650, { width: undefined, height: undefined })];
    boundary({ canvasProps: props(), nodes, native: false, measured: false, viewport: { x: 0, y: 0, zoom: .5 }, configuration: { pinned: true, intent: 'in' } });
    configure();
    publish();
    expect(opened()).toBe('custom:second');
  });
  it('retains the first group in an exact distance tie and tolerates no rendered groups or an empty map', () => {
    const current = props();
    const options = { canvasProps: current, native: false, viewport: { x: 0, y: 0, zoom: .5 }, configuration: { pinned: true, intent: 'in' as const } };
    const ui = boundary({ ...options, nodes: [groupNode('custom:first', 900, 650), groupNode('custom:second', 900, 650)] });
    configure();
    publish();
    expect(opened()).toBe('custom:first');
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...options} nodes={[]} /></ReactFlowProvider>);
    configure();
    publish();
    expect(opened()).toBe('custom:first');
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...options} canvasProps={props(canvas([]))} nodes={[]} /></ReactFlowProvider>);
    configure();
    publish();
    expect(opened()).toBe('custom:first');
  });
  it.each([
    { parent: 'custom:launch/notes/deeper', supergroup: 'super:0', expectedParent: 'custom:launch/notes', expectedSuper: 'super:0' },
    { parent: 'custom:launch', supergroup: 'super:0', expectedParent: '', expectedSuper: 'super:0' },
    { parent: '', supergroup: 'super:0', expectedParent: '', expectedSuper: '' },
    { parent: '', supergroup: '', expectedParent: '', expectedSuper: '' },
  ])('steps out at the .21 boundary from $parent/$supergroup', ({ parent, supergroup, expectedParent, expectedSuper }) => {
    boundary({ canvasProps: props(), nodes: [], native: false, viewport: { x: 0, y: 0, zoom: .21 }, configuration: { pinned: true, intent: 'out', parent, supergroup } });
    configure();
    publish();
    expect(snapshot()).toMatchObject({ parent: expectedParent, supergroup: expectedSuper });
  });
  it('does not step out above .21 or enter a group below .5 or without an inward intent', () => {
    const current = props();
    const options = { canvasProps: current, nodes: [groupNode('custom:launch')], native: false, configuration: { pinned: true, parent: 'custom:launch', intent: 'out' as const } };
    const ui = boundary({ ...options, viewport: { x: 0, y: 0, zoom: .210001 } });
    configure();
    publish();
    expect(snapshot().parent).toBe('custom:launch');
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...options} viewport={{ x: 0, y: 0, zoom: .499999 }} configuration={{ pinned: true, intent: 'in' }} /></ReactFlowProvider>);
    configure();
    publish();
    expect(opened()).toBe('');
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...options} viewport={{ x: 0, y: 0, zoom: .5 }} configuration={{ pinned: true }} /></ReactFlowProvider>);
    configure();
    publish();
    expect(opened()).toBe('');
  });
});

describe('public viewport visibility and durable callbacks', () => {
  it('reports ordered documents with strict edge intersections and caps visible IDs at sixteen', () => {
    const changed = vi.fn();
    const documents = Array.from({ length: 20 }, (_, index) => documentNode(block('visible-' + index, { x: index * 10, y: 10, width: 50, height: 50 })));
    const excluded = [documentNode(block('right', { x: 1000 })), documentNode(block('left', { x: -320 })), documentNode(block('below', { y: 800 })), documentNode(block('above', { y: -240 }))];
    boundary({ canvasProps: props(canvas(), changed), nodes: [...excluded, ...documents], native: false });
    publish();
    expect(changed).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 }, documents.slice(0, 16).map(value => value.id), expect.any(Object));
  });
  it('uses measured dimensions before node dimensions and block fallback dimensions for each axis', () => {
    const changed = vi.fn();
    const nodes = [
      documentNode(block('measured-visible', { x: -50, y: -50, width: 40, height: 40 }), { measured: { width: 100, height: 100 } }),
      documentNode(block('measured-hidden', { x: -50, y: -50 }), { measured: { width: 20, height: 20 } }),
      documentNode(block('node-visible', { x: -50, y: -50, width: 40, height: 40 }), { width: 100, height: 100 }),
      documentNode(block('fallback-visible', { x: -50, y: -50 }), { width: undefined, height: undefined }),
      documentNode(block('fallback-hidden', { x: -50, y: -50, width: 40, height: 40 }), { width: undefined, height: undefined }),
    ];
    boundary({ canvasProps: props(canvas(), changed), nodes, native: false });
    publish();
    expect(changed.mock.calls.at(-1)?.[1]).toEqual(['measured-visible', 'node-visible', 'fallback-visible']);
  });
  it('expands supergroup roots, strips file prefixes, removes duplicates in order, and ignores a stale supergroup ID', () => {
    const changed = vi.fn();
    const document = canvas('abcdefghi'.split('').map(name => block(name, { group: 'custom:' + name })));
    boundary({ canvasProps: props(document, changed), nodes: [groupNode('super:1'), groupNode('super:missing'), groupNode('super:0'), groupNode('files:custom:a')], native: false });
    publish();
    expect(changed.mock.calls.at(-1)?.[2].visibleGroups).toEqual(['custom:b', 'custom:d', 'custom:f', 'custom:h', 'custom:a', 'custom:c', 'custom:e', 'custom:g', 'custom:i']);
  });
  it('caps visible groups at sixteen, supplies missing group dimensions, and falls back to current view groups when none intersect', () => {
    const changed = vi.fn();
    const document = canvas();
    const nodes = Array.from({ length: 20 }, (_, index) => groupNode('custom:' + index, -10, -10, { width: undefined, height: undefined }));
    const options = { canvasProps: props(document, changed), nodes, native: false };
    const ui = boundary(options);
    publish();
    expect(changed.mock.calls.at(-1)?.[2].visibleGroups).toEqual(nodes.slice(0, 16).map(value => value.data.group));
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...options} viewport={{ x: -10000, y: -10000, zoom: 1 }} /></ReactFlowProvider>);
    publish();
    expect(changed.mock.calls.at(-1)?.[2].visibleGroups).toEqual(['custom:launch', 'custom:launch/notes']);
  });
  it.each([false, true])('publishes no visible documents and view-group fallback with absent measuring stage (surface=%s)', surface => {
    const changed = vi.fn();
    boundary({ canvasProps: props(canvas(), changed), nodes: [documentNode(block('a')), groupNode('custom:other')], native: false, measured: false, surface });
    publish();
    expect(changed).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 }, [], expect.objectContaining({ visibleGroups: ['custom:launch', 'custom:launch/notes'] }));
    move();
  });
  it('publishes only the latest callback and remembers at most eight canvases, refreshing a reused entry before eviction', () => {
    const first = vi.fn();
    const second = vi.fn();
    let current = { canvasProps: props(canvas(), first), nodes: [], native: false, viewport: { x: 10, y: 20, zoom: .8 } };
    const ui = boundary(current);
    publish();
    expect(first).toHaveBeenCalledOnce();
    current = { ...current, canvasProps: props(canvas(), second) };
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...current} /></ReactFlowProvider>);
    publish();
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    for (let index = 0; index < 8; index++) {
      ui.rerender(<ReactFlowProvider><ViewportBoundary {...current} canvasProps={props(canvas([], 'other-' + index), second)} /></ReactFlowProvider>);
      publish();
    }
    expect(snapshot().remembered.map(([id]) => id)).toEqual(Array.from({ length: 8 }, (_, index) => 'other-' + index));
    ui.rerender(<ReactFlowProvider><ViewportBoundary {...current} canvasProps={props(canvas([], 'other-0'), second)} /></ReactFlowProvider>);
    publish();
    expect(snapshot().remembered.map(([id]) => id)).toEqual(['other-1', 'other-2', 'other-3', 'other-4', 'other-5', 'other-6', 'other-7', 'other-0']);
  });
});

describe('viewport gestures through the installed renderer', () => {
  it('applies an explicit camera request to an empty canvas without waiting for nonexistent node measurements', async () => {
    const changed = vi.fn();
    render(<ReactFlowProvider><Canvas {...props(canvas([]), changed)} viewportRequest={{ x: 42, y: -21, zoom: .6, sequence: 1 }} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 42, y: -21, zoom: .6 }));
    expect(changed).toHaveBeenLastCalledWith({ x: 42, y: -21, zoom: .6 }, [], expect.objectContaining({ visibleGroups: [] }));
  });
  it('centers an existing group through the public canvas request after the initial native fit', async () => {
    const document = canvas([block('a', { group: 'custom:launch' }), block('b', { group: 'custom:launch', x: 400 })]);
    const changed = vi.fn();
    const current = props(document, changed);
    const ui = render(<ReactFlowProvider><Canvas {...current} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    ui.rerender(<ReactFlowProvider><Canvas {...current} groupFocusRequest={{ canvasId: document.id, group: 'custom:launch', sequence: 1 }} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getZoom()).toBe(1));
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(instance().getViewport(), ['a', 'b'], expect.objectContaining({ level: 'documents', activeGroup: 'custom:launch' })));
  });
  it('waits for a requested document to arrive and centers it with the default minimum zoom', async () => {
    const changed = vi.fn();
    const request = { blockId: 'later', sequence: 1 };
    const current = props(canvas([]), changed);
    const ui = render(<ReactFlowProvider><Canvas {...current} focusRequest={request} /><FlowAccess /></ReactFlowProvider>);
    await setViewport({ x: 0, y: 0, zoom: .5 });
    const document = canvas([block('later', { x: 700, y: 300 })]);
    ui.rerender(<ReactFlowProvider><Canvas {...current} canvas={document} focusRequest={request} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: -360, y: -20, zoom: 1 }));
    expect(screen.getByTestId('rf__node-later')).toHaveProperty('className', expect.stringContaining('selected'));
    expect(changed).toHaveBeenLastCalledWith({ x: -360, y: -20, zoom: 1 }, ['later'], expect.objectContaining({ level: 'documents' }));
  });
  it('preserves an already larger zoom when focusing and responds to a repeated request with a new sequence', async () => {
    const document = canvas([block('a'), block('b', { x: 400, y: 240 })]);
    const changed = vi.fn();
    const current = props(document, changed);
    const ui = render(<ReactFlowProvider><Canvas {...current} /><FlowAccess /></ReactFlowProvider>);
    await setViewport({ x: 0, y: 0, zoom: 1.2 });
    ui.rerender(<ReactFlowProvider><Canvas {...current} focusRequest={{ blockId: 'a', sequence: 1 }} focusZoom={1} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 296, y: 232, zoom: 1.2 }));
    ui.rerender(<ReactFlowProvider><Canvas {...current} focusRequest={{ blockId: 'b', sequence: 2 }} focusZoom={1} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: -172, y: -32, zoom: 1.2 }));
    expect(changed).toHaveBeenLastCalledWith({ x: -172, y: -32, zoom: 1.2 }, ['a', 'b'], expect.any(Object));
  });
  it('clears the actual selection when navigating canvases and restores each remembered native viewport', async () => {
    const first = canvas([block('a'), block('b', { x: 400 })], 'first');
    const second = canvas([block('c', { x: 100, y: 100 })], 'second');
    const selected = vi.fn();
    const changed = vi.fn();
    const current = { ...props(first, changed), onSelectionChange: selected };
    const ui = render(<ReactFlowProvider><Canvas {...current} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    await setViewport({ x: 125, y: -35, zoom: .8 });
    fireEvent.click(screen.getByTestId('rf__node-a'));
    await waitFor(() => expect(selected).toHaveBeenLastCalledWith([first.blocks[0]]));
    await setViewport({ x: 125, y: -35, zoom: .8 });
    ui.rerender(<ReactFlowProvider><Canvas {...current} canvas={second} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(selected).toHaveBeenLastCalledWith([]));
    await waitFor(() => {
      const bounds = instance().getNodesBounds(instance().getNodes());
      expect(instance().getViewport()).toEqual({ x: 500 - bounds.x - bounds.width / 2, y: 400 - bounds.y - bounds.height / 2, zoom: 1 });
    });
    expect(screen.queryByTestId('rf__node-a')).toBeNull();
    await setViewport({ x: -50, y: 60, zoom: .9 });
    ui.rerender(<ReactFlowProvider><Canvas {...current} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 125, y: -35, zoom: .8 }));
    expect(screen.getByTestId('rf__node-a').className).not.toContain('selected');
    expect(changed).toHaveBeenLastCalledWith({ x: 125, y: -35, zoom: .8 }, ['a', 'b'], expect.any(Object));
    ui.rerender(<ReactFlowProvider><Canvas {...current} canvas={second} /><FlowAccess /></ReactFlowProvider>);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: -50, y: 60, zoom: .9 }));
    expect(changed).toHaveBeenLastCalledWith({ x: -50, y: 60, zoom: .9 }, ['c'], expect.any(Object));
  });
  it.each([false, true])('persists the actual Canvas viewport in a bookmark and restores it after a real journey/storage remount (settled=%s)', async settled => {
    const document = canvas([block('a', { group: 'custom:launch' }), block('b', { group: 'custom:launch', x: 400 })]);
    const changed = vi.fn();
    function BookmarkedCanvas() {
      const journey = useCanvasJourney();
      const [request, setRequest] = useState<(Viewport & { sequence: number })>();
      useEffect(() => { journey.visit({ canvasId: document.id, canvasName: document.name }); }, []);
      return <>
        <button onClick={() => journey.addBookmark('Launch view', { canvasId: document.id, canvasName: document.name, viewport: journey.current?.viewport })}>Bookmark current view</button>
        {journey.bookmarks.map(bookmark => <button key={bookmark.id} onClick={() => { if (bookmark.viewport) setRequest(previous => ({ ...bookmark.viewport!, sequence: (previous?.sequence ?? 0) + 1 })); }}>Restore {bookmark.name}</button>)}
        <output aria-label="Journey viewport">{JSON.stringify(journey.current?.viewport)}</output>
        <Canvas {...props(document, (viewport, ids, focus) => {
          changed(viewport, ids, focus);
          journey.updateViewport(document.id, viewport);
        })} viewportRequest={request} />
        <FlowAccess />
      </>;
    }
    const ui = render(<ReactFlowProvider><BookmarkedCanvas /></ReactFlowProvider>);
    await setViewport({ x: 125, y: -35, zoom: .8 });
    await waitFor(() => expect(JSON.parse(screen.getByLabelText('Journey viewport').textContent ?? '{}')).toEqual({ x: 125, y: -35, zoom: .8 }));
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark current view' }));
    const saved = JSON.parse(localStorage.getItem('symbiknow:bookmarks') ?? '[]') as { name: string; viewport: Viewport }[];
    expect(saved[0]).toMatchObject({ name: 'Launch view', viewport: { x: 125, y: -35, zoom: .8 } });
    ui.unmount();
    render(<ReactFlowProvider><BookmarkedCanvas /></ReactFlowProvider>);
    if (settled) await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Launch view' }));
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 125, y: -35, zoom: .8 }));
    expect(changed).toHaveBeenLastCalledWith({ x: 125, y: -35, zoom: .8 }, ['a', 'b'], expect.objectContaining({ level: 'documents', visibleGroups: ['custom:launch'] }));
  });
});
