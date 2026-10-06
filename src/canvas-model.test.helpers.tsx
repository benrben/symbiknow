import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Edge, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { CanvasView } from './CanvasView';
import { nodeTypes } from './CanvasNodes';
import { FocusFittedBlock } from './CanvasViewRequests';
import { useCanvasModel, type CanvasModel } from './canvas-model';
import type { CanvasProps, FlowNode } from './canvas-types';

const originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
let flow: ReactFlowInstance<FlowNode, Edge> | null = null;
let width = 1000;
const observations = new Map<Element, ResizeObserverCallback>();
export function block(id: string, extra: Partial<CanvasBlock> = {}): CanvasBlock {
  return { id, title: 'Document ' + id, file: id + '.md', kind: 'markdown', content: '# Evidence ' + id, x: 10, y: 20, width: 320, height: 240, links: [], ...extra };
}
export function canvas(blocks: CanvasBlock[] = [block('a'), block('b', { x: 400 })], id = 'planning'): CanvasDocument {
  return { id, name: 'Canvas ' + id, workspaceId: 'team', blocks };
}
export function props(document = canvas()): CanvasProps {
  return { canvas: document, onUpdateBlock: vi.fn(async () => undefined), onDeleteBlock: vi.fn(async () => undefined), onSelectBlock: vi.fn() };
}
function FlowAccess() {
  const instance = useReactFlow<FlowNode, Edge>();
  const ready = useStore(state => Boolean(state.panZoom));
  const queued = useStore(state => state.fitViewQueued);
  const fitting = useStore(state => Boolean(state.fitViewResolver));
  const initialized = useStore(state => state.nodesInitialized);
  useEffect(() => {
    if (ready) flow = instance;
    return () => { if (flow === instance) flow = null; };
  }, [instance, ready]);
  return <output aria-label="Native fit readiness">{JSON.stringify({ queued, fitting, initialized })}</output>;
}
export type BoundaryProps = { canvasProps: CanvasProps; action?: (model: CanvasModel) => void | Promise<unknown>; view?: boolean | 'surface' | 'native' };
// A supported owner of the exported hook: its normal view is the actual CanvasView.
// The action is an integration control wired only to public model methods, never private refs/state.
export function ModelBoundary({ canvasProps, action, view = true }: BoundaryProps) {
  const model = useCanvasModel(canvasProps);
  return <>
    <button onClick={() => { void action?.(model); }}>Run public action</button>
    <output aria-label="Model state">{JSON.stringify({
      zoom: model.zoom, selected: model.selectedIds, group: model.drillGroup, parent: model.mapParent,
      pinned: model.mapPinned, hops: model.focusHops, pull: model.pullActive, message: model.message,
      nodes: model.flowNodes.map(node => ({ id: node.id, position: node.position, selected: node.selected, highlighted: node.type === 'document' && node.data.highlighted }))
    })}</output>
    {view === true && <CanvasView model={model} />}
    {view === true && <FlowAccess />}
    {view === 'surface' && <section ref={model.surface} aria-label="Pending canvas renderer" />}
    {view === 'native' && <section ref={model.surface} aria-label="Embedded canvas">
      <ReactFlow<FlowNode, Edge> nodes={model.flowNodes} edges={model.edges} nodeTypes={nodeTypes}
        onInit={instance => { model.flowInstance.current = instance; }} onMove={model.moved} onMoveEnd={model.moveEnded}
        onNodesChange={model.changeNodes} minZoom={.005} maxZoom={2.5}>
        {!model.focusSelect && model.focusRequest && <FocusFittedBlock block={model.blocks.find(block => block.id === model.focusRequest?.blockId)}
          sequence={model.focusRequest.sequence} maxZoom={model.focusZoom} surface={model.surface}/>}
      </ReactFlow><FlowAccess />
    </section>}
  </>;
}
export function mount(options: BoundaryProps) {
  const ui = render(<ReactFlowProvider><ModelBoundary {...options} /></ReactFlowProvider>);
  return { ...ui, change(next: BoundaryProps) { ui.rerender(<ReactFlowProvider><ModelBoundary {...next} /></ReactFlowProvider>); } };
}
export function run() { fireEvent.click(screen.getByRole('button', { name: 'Run public action' })); }
export function state(): { zoom: number; selected: string[]; group: string; parent: string; pinned: boolean; hops: number; pull: boolean; message: string; nodes: { id: string; position: { x: number; y: number }; selected?: boolean; highlighted: boolean }[] } {
  return JSON.parse(screen.getByLabelText('Model state').textContent ?? '{}');
}
export function instance() {
  if (!flow) throw new Error('Native flow is not ready');
  return flow;
}
export async function camera(viewport: Viewport) {
  await waitFor(() => expect(instance()).toBeTruthy());
  await act(async () => { await instance().setViewport(viewport, { duration: 0 }); });
}
export function resize(nextWidth: number) {
  width = nextWidth;
  act(() => {
    for (const [target, callback] of observations) callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], {} as ResizeObserver);
  });
}
export function installCanvasBrowser() {
  beforeEach(() => {
    width = 1000;
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: function (this: SVGElement) { return new DOMRect(0, 0, (this.textContent?.length ?? 0) * 7, 14); } });
    vi.stubGlobal('DOMMatrixReadOnly', class {
      readonly m22: number;
      constructor(transform: string) {
        const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
        const scale = /scale\(([^)]+)\)/.exec(transform);
        this.m22 = matrix ? Number(matrix[1].split(',')[3]) : scale ? Number(scale[1].split(',').at(-1)) : 1;
      }
    });
    vi.stubGlobal('ResizeObserver', class {
      private targets = new Set<Element>();
      constructor(private callback: ResizeObserverCallback) { }
      observe(target: Element) {
        this.targets.add(target);
        observations.set(target, this.callback);
        queueMicrotask(() => { if (this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver); });
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        observations.delete(target);
      }
      disconnect() {
        for (const target of this.targets) observations.delete(target);
        this.targets.clear();
      }
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.style.width.endsWith('px') ? Number.parseFloat(this.style.width) : width; });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.style.height.endsWith('px') ? Number.parseFloat(this.style.height) : 800; });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const element = this as HTMLElement;
      return new DOMRect(0, 0, element.style?.width.endsWith('px') ? Number.parseFloat(element.style.width) : width, element.style?.height.endsWith('px') ? Number.parseFloat(element.style.height) : 800);
    });
  });
  afterEach(() => {
    cleanup();
    flow = null;
    observations.clear();
    if (originalBBox) Object.defineProperty(SVGElement.prototype, 'getBBox', originalBBox); else Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });
}
