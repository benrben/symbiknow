// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, ReactFlowProps, ReactFlowInstance } from '@xyflow/react';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Canvas } from './Canvas';
import { api } from './api';
import { CanvasStore } from '../server/storage';
import { createApiServer } from '../server/index';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { CanvasProps, FlowNode, Frame } from './canvas-types';
import { blockGroup, contains, frameNodes, frames, groupEdges, groupLabelPatch, hierarchyEdges, makeNodes } from './canvas-flow-helpers';

type FlowProps = ReactFlowProps<FlowNode, Edge>;
const flow = vi.hoisted(() => ({ current: null as FlowProps | null, instance: null as ReactFlowInstance<FlowNode, Edge> | null }));
const originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
const nativeFetch = globalThis.fetch;
const servers: { server: Server; root: string }[] = [];
// Observe the installed ReactFlow's public input while keeping its renderer, state, and event handling intact.
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual, ReactFlow: (props: FlowProps) => {
      flow.current = props;
      return <actual.ReactFlow {...props} onInit={instance => {
        flow.instance = instance;
        props.onInit?.(instance);
      }} />;
    }
  };
});
function block(id: string, extra: Partial<CanvasBlock> = {}): CanvasBlock {
  return { id, title: 'Document ' + id, file: 'docs/' + id + '.md', kind: 'markdown', content: '# ' + id, x: 10, y: 20, width: 320, height: 240, links: [], ...extra };
}
function canvas(blocks: CanvasBlock[]): CanvasDocument { return { id: 'planning', name: 'Planning', workspaceId: 'team', blocks }; }
function current(): FlowProps {
  if (!flow.current) throw new Error('Canvas ReactFlow has not mounted');
  return flow.current;
}
function flowNode(id: string): FlowNode {
  const node = current().nodes?.find(item => item.id === id);
  if (!node) throw new Error('Missing node ' + id);
  return node;
}
async function enterFiles(group: string) {
  const frame = await waitFor(() => {
    const element = document.querySelector(`[data-canvas-group="${group}"]`);
    expect(element).toBeTruthy();
    return element!;
  });
  fireEvent.click(within(frame as HTMLElement).getAllByRole('button')[0]);
  await waitFor(() => expect(flow.instance?.getZoom()).toBeGreaterThan(.28));
  await moveZoom(1);
}
async function moveZoom(zoom: number) {
  await act(async () => { await flow.instance!.setViewport({ x: 0, y: 0, zoom }, { duration: 0 }); });
  await waitFor(() => expect(document.querySelector('.canvas-surface')?.classList.contains('canvas-surface--' + (zoom < .34 ? 'overview' : zoom < .75 ? 'titles' : 'full'))).toBe(true));
}
function rootProps(): Omit<CanvasProps, 'canvas'> { return { onUpdateBlock: vi.fn(async () => undefined), onDeleteBlock: vi.fn(async () => undefined), onSelectBlock: vi.fn() }; }
beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: function (this: SVGElement) { return new DOMRect(0, 0, (this.textContent?.length ?? 0) * 7, 14); } });
  localStorage.clear();
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
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
afterEach(async () => {
  cleanup();
  flow.current = null;
  flow.instance = null;
  if (originalBBox) Object.defineProperty(SVGElement.prototype, 'getBBox', originalBBox); else Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const { server, root } of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('Canvas flow through the installed ReactFlow', () => {
  it.each(['light', 'dark'] as const)('keeps document edges ordered, filters unknown links, and applies %s colors and relation labels', async theme => {
    const actions = rootProps();
    const document = canvas([block('a', { links: ['missing', 'b', 'c'], linkTypes: { b: 'decision_for' } }), block('b'), block('c')]);
    render(<Canvas canvas={document} {...actions} theme={theme} />);
    await enterFiles('__ungrouped');
    await screen.findByRole('button', { name: 'Read Document a full page' });
    expect(current().nodes?.filter(node => node.type === 'document').map(node => node.id)).toEqual(['a', 'b', 'c']);
    expect(current().edges?.map(edge => edge.id)).toEqual(['a->b', 'a->c']);
    const edge = current().edges![0];
    expect(edge.label).toBe('decision for');
    expect(edge.style).toMatchObject({ stroke: theme === 'dark' ? '#AABFBA' : '#52666A', strokeWidth: 2.5, opacity: .7 });
    expect(edge.labelBgStyle).toEqual({ fill: theme === 'dark' ? '#1C2E34' : '#FFFFFF' });
    expect(screen.getByText('decision for')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read Document a full page' }));
    expect(actions.onSelectBlock).toHaveBeenCalledWith(document.blocks[0]);
  });
  it('switches between full, title, and hierarchy group links with hover emphasis and plural counts', async () => {
    const docs = [block('a', { group: 'area:frontend', links: ['b', 'c'], linkTypes: { b: 'decision_for' } }), block('b', { group: 'area:frontend', y: 300, links: ['c'] }), block('c', { group: 'area:sales', x: 700 }), block('d', { group: 'purpose:guide', x: 1600, links: ['c'] })];
    const view = render(<Canvas canvas={canvas(docs)} {...rootProps()} theme="dark" />);
    await enterFiles('area:frontend');
    await screen.findByRole('button', { name: 'Collapse Frontend' });
    const full = current().edges!.find(edge => edge.id === 'group-edge:area:frontend->area:sales')!;
    expect(full.label).toBe('2 links');
    expect(full.style).toMatchObject({ stroke: '#7D9E9D', strokeWidth: 3, strokeDasharray: '7 7' });
    expect(full.labelStyle).toMatchObject({ fill: '#EAF1ED', fontSize: 11 });
    await moveZoom(.6);
    const titles = current().edges![0];
    expect(titles.style).toMatchObject({ strokeWidth: 6, strokeDasharray: '18 14' });
    expect(titles.labelStyle).toMatchObject({ fontSize: 34 });
    expect(titles.markerEnd).toMatchObject({ width: 14 });
    const sameGroupLink = current().edges!.find(edge => edge.id === 'a->b');
    expect(sameGroupLink).toMatchObject({ label: 'decision for', style: { strokeWidth: 4, opacity: .85 }, labelStyle: { fontSize: 18 } });
    await waitFor(() => expect(document.querySelector('.react-flow__edge.canvas-document-edge .react-flow__edge-path')).toBeTruthy());
    await moveZoom(.28);
    const hidden = current().edges![0];
    expect(hidden.label).toBeUndefined();
    expect(hidden.style).toMatchObject({ stroke: '#A7C7C0', opacity: .82, strokeWidth: 6 });
    await waitFor(() => expect(document.querySelector('.react-flow__edge.canvas-group-edge .react-flow__edge-path')).toBeTruthy());
    const front = document.querySelector('[data-canvas-group="area:frontend"]')!;
    expect(front.querySelector('.canvas-group__internal-links')?.textContent).toBe('↗ 1 link inside');
    fireEvent.mouseEnter(front);
    const emphasized = current().edges![0];
    expect(emphasized.className).toContain('is-focused');
    expect(emphasized.label).toBe('2 links');
    expect(emphasized.style).toMatchObject({ strokeWidth: 8, opacity: 1 });
    expect(current().edges?.find(edge => edge.source === 'group:purpose:guide')?.style).toMatchObject({ opacity: .2 });
    fireEvent.mouseLeave(front);
    view.rerender(<Canvas canvas={canvas(docs)} {...rootProps()} theme="light" />);
    expect(current().edges![0].style).toMatchObject({ stroke: '#557B79' });
    expect(current().edges![0].labelStyle).toMatchObject({ fill: '#43595A' });
  });
  it('collapses and expands a group while preserving member order and frame bounds', async () => {
    render(<Canvas canvas={canvas([block('a', { group: 'purpose:guide' }), block('b', { group: 'purpose:guide', y: 400 })])} {...rootProps()} />);
    await enterFiles('purpose:guide');
    const collapse = await screen.findByRole('button', { name: 'Collapse Guide' });
    const openFrame = flowNode('group:purpose:guide');
    expect(openFrame).toMatchObject({ width: 376, height: 713, draggable: true, selectable: false, connectable: false });
    fireEvent.click(collapse);
    expect(current().nodes?.filter(node => node.type === 'document')).toHaveLength(0);
    expect(flowNode('group:purpose:guide')).toMatchObject({ width: 380, height: 190, data: { collapsed: true, width: 380, height: 190 } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand Guide' }));
    expect(current().nodes?.filter(node => node.type === 'document').map(node => node.id)).toEqual(['a', 'b']);
  });
});

// Exported geometry/mode inputs include compatibility cases that the current Canvas does not emit.
describe('public canvas flow compatibility and geometry', () => {
  it('retains overview edge focus, directed counts, missing-target filtering, and root aggregation', () => {
    const docs = [block('a', { group: 'area:frontend/ui', links: ['b', 'b', 'missing', 'a'] }), block('b', { group: 'purpose:guide/api', links: ['c'] }), block('c'), block('hidden', { group: 'custom:outside' })];
    expect(groupEdges(docs, 'light', 'overview').map(edge => [edge.source, edge.target, edge.label, edge.style])).toEqual([
      ['group:area:frontend', 'group:purpose:guide', undefined, expect.objectContaining({ strokeWidth: 6, opacity: .82, strokeDasharray: undefined })],
      ['group:purpose:guide', 'group:__ungrouped', undefined, expect.objectContaining({ strokeWidth: 6, opacity: .82 })],
    ]);
    const focused = groupEdges(docs, 'dark', 'overview', 'area:frontend');
    expect(focused[0]).toMatchObject({ label: '2 links', className: 'canvas-group-edge is-focused', style: { strokeWidth: 8, opacity: 1 } });
    expect(focused[1].style).toMatchObject({ opacity: .2 });
    expect(groupEdges(docs, 'light', 'overview', 'purpose:guide')[1].label).toBe('1 link');
    expect(groupEdges(docs, 'light').map(edge => edge.label)).toEqual(['2 links', '1 link']);
    expect(hierarchyEdges([block('hidden', { links: ['a'] }), block('a')], 'light', value => value.id === 'a' ? 'area:frontend' : undefined, null)).toEqual([]);
    const hidden = hierarchyEdges(docs, 'light', value => value.id === 'hidden' ? undefined : value.id === 'a' ? 'area:frontend' : value.id === 'b' ? 'purpose:guide' : undefined, null);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].style).toMatchObject({ opacity: .82, strokeWidth: 6 });
    expect(hierarchyEdges(docs, 'dark', value => value.id === 'b' ? 'purpose:guide' : value.id === 'a' ? 'area:frontend' : undefined, 'purpose:guide')[0]).toMatchObject({ label: '2 links', style: { opacity: 1, strokeWidth: 8 } });
  });
  it('uses live dimensions, includes nested ancestors, and preserves ungrouped and legacy lane frames', () => {
    const docs = [block('nested', { group: 'area:frontend/ui', x: 100, y: 200 }), block('root', { group: 'area:frontend', x: 500, y: 0 }), block('plain'), block('legacy', { group: 'work' })];
    const list = frames(docs, new Map([['nested', { x: -10, y: -20, width: 100, height: 80 }]]));
    expect(list.map(frame => frame.group)).toEqual(['area:frontend', 'area:frontend/ui', '__ungrouped', 'lane:work']);
    expect(list[0]).toMatchObject({ x: -66, y: -133, width: 942, height: 429, members: ['nested', 'root'], topTitles: ['Document nested', 'Document root'], depth: 0 });
    expect(list[1]).toMatchObject({ x: -38, y: -85, width: 156, height: 173, depth: 1 });
    expect(list[2]).toMatchObject({ title: 'Ungrouped', tone: 7 });
    expect(blockGroup(docs[3])).toBe('lane:work');
    expect(blockGroup(docs[2])).toBeUndefined();
    const frame: Frame = list[1];
    expect(contains(frame, frame.x, frame.y)).toBe(true);
    expect(contains(frame, frame.x - 1, frame.y)).toBe(false);
    expect(contains(frame, frame.x + frame.width + 1, frame.y)).toBe(false);
    expect(contains(frame, frame.x, frame.y - 1)).toBe(false);
    expect(contains(frame, frame.x, frame.y + frame.height + 1)).toBe(false);
    expect(contains(frame, frame.x - 1, frame.y - 1, 1)).toBe(true);
    const drill = vi.fn();
    const collapse = vi.fn();
    const hover = vi.fn();
    const nodes = frameNodes(list, new Set(['area:frontend/ui']), true, drill, collapse, hover);
    expect(nodes[1]).toMatchObject({ draggable: false, className: 'canvas-group-node is-map-node', width: 380, height: 190, data: { width: 380, height: 190, collapsed: true } });
    nodes[1].data.onDrill(frame.group);
    nodes[1].data.onCollapse(frame.group);
    nodes[1].data.onHover(null);
    expect(drill).toHaveBeenCalledWith(frame.group);
    expect(collapse).toHaveBeenCalledWith(frame.group);
    expect(hover).toHaveBeenCalledWith(null);
    expect(groupLabelPatch(null)).toEqual({});
    expect(groupLabelPatch('custom:team')).toEqual({});
    expect(groupLabelPatch('area:other')).toEqual({});
    expect(groupLabelPatch('purpose:other')).toEqual({});
    expect(groupLabelPatch('work')).toEqual({});
    expect(groupLabelPatch('area:frontend/ui')).toEqual({ workArea: 'frontend' });
    expect(groupLabelPatch('purpose:guide/api')).toEqual({ purpose: 'guide' });
  });

  it('places every ancestor around its deeper subgroups without moving source documents or covering child headings', () => {
    const docs = [block('deep', { group: 'custom:release/delivery/checks', x: 100, y: 200 }),
      block('sibling', { group: 'custom:release/planning', x: 800, y: -50 }), block('direct', { group: 'custom:release', x: -200, y: 400 })];
    const positions = docs.map(document => ({ id: document.id, x: document.x, y: document.y }));
    const list = frames(docs, new Map());
    for (const child of list.filter(frame => frame.depth > 0)) {
      const parentKey = child.group.slice(0, child.group.lastIndexOf('/'));
      const parent = list.find(frame => frame.group === parentKey)!;
      expect(parent.x).toBeLessThan(child.x); expect(parent.y).toBeLessThan(child.y);
      expect(parent.x + parent.width).toBeGreaterThan(child.x + child.width);
      expect(parent.y + parent.height).toBeGreaterThan(child.y + child.height);
    }
    const nodes = frameNodes(list, new Set(), false, vi.fn(), vi.fn(), vi.fn());
    expect(nodes.find(node => node.id === 'group:custom:release')!.ariaLabel).toBe('Group: Release, 3 documents');
    expect(nodes.find(node => node.id === 'group:custom:release/planning')!.ariaLabel).toBe('Group: Planning, 1 document');
    expect(makeNodes('canvas', [docs[0]], vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())[0].ariaLabel).toBe('Document: Document deep');
    expect(nodes.find(node => node.id === 'group:custom:release')!.zIndex).toBeLessThan(nodes.find(node => node.id === 'group:custom:release/delivery/checks')!.zIndex!);
    expect(Math.max(...nodes.map(node => node.zIndex!))).toBeLessThan(0);
    expect(docs.map(document => ({ id: document.id, x: document.x, y: document.y }))).toEqual(positions);
  });
});

describe('Canvas group drag through native persistence', () => {
  it('persists purpose and work-area drops, group moves, and layout failure recovery across remount', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-flow-public-'));
    const store = new CanvasStore(root);
    await store.init();
    const created = await store.createCanvas('acme-team', { name: 'Flow persistence' });
    const source = await store.createBlock(created.id, { title: 'Source document', kind: 'markdown', content: 'Original source content', x: 10, y: 20, width: 320, height: 240, group: 'area:backend', workArea: 'backend', purpose: 'decision' });
    const front = await store.createBlock(created.id, { title: 'Frontend target', kind: 'markdown', content: 'Frontend content', x: 1000, y: 20, width: 320, height: 240, group: 'area:frontend' });
    const guide = await store.createBlock(created.id, { title: 'Guide target', kind: 'markdown', content: 'Guide content', x: 2000, y: 20, width: 320, height: 240, group: 'purpose:guide' });
    const original = await store.getCanvas(created.id);
    const server = await createApiServer({ dataDir: root });
    servers.push({ server, root });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const base = `http://127.0.0.1:${address.port}`;
    let failLayout = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).endsWith('/layout') && failLayout) {
        failLayout = false;
        return Response.json({ error: 'Layout unavailable' }, { status: 503 });
      }
      return nativeFetch(base + String(input), init);
    });
    function PersistentCanvas({ initial }: { initial: CanvasDocument }) {
      const [document, setDocument] = useState(initial);
      async function refresh() { setDocument(await api<CanvasDocument>('/canvases/' + created.id)); }
      async function update(id: string, patch: Partial<CanvasBlock>) {
        await api('/canvases/' + created.id + '/blocks/' + id, { method: 'PUT', body: JSON.stringify(patch) });
        await refresh();
      }
      async function move(positions: Parameters<NonNullable<CanvasProps['onMoveBlocks']>>[0]) {
        await api('/canvases/' + created.id + '/layout', { method: 'PUT', body: JSON.stringify({ positions }) });
        await refresh();
      }
      return <Canvas canvas={document} onUpdateBlock={update} onMoveBlocks={move} onDeleteBlock={async id => {
        await api('/canvases/' + created.id + '/blocks/' + id, { method: 'DELETE' });
        await refresh();
      }} onSelectBlock={value => window.history.replaceState(null, '', '?document=' + value.id)} />;
    }
    const view = render(<PersistentCanvas initial={original} />);
    await enterFiles('area:backend');
    await act(async () => current().onNodeDragStop?.(new MouseEvent('mouseup'), { ...flowNode(source.id), position: { x: 1020, y: 30 } }, current().nodes ?? []));
    await waitFor(async () => expect((await new CanvasStore(root).getCanvas(created.id)).blocks.find(value => value.id === source.id)).toMatchObject({ group: 'area:frontend', workArea: 'frontend', purpose: 'decision', x: 1020, y: 30 }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
    await enterFiles('area:frontend');
    await waitFor(() => expect(flowNode(source.id).data).toMatchObject({ block: { group: 'area:frontend' } }));
    await act(async () => current().onNodeDragStop?.(new MouseEvent('mouseup'), { ...flowNode(source.id), position: { x: 2020, y: 30 } }, current().nodes ?? []));
    await waitFor(async () => expect((await new CanvasStore(root).getCanvas(created.id)).blocks.find(value => value.id === source.id)).toMatchObject({ group: 'purpose:guide', purpose: 'guide', workArea: 'frontend', x: 2020, y: 30 }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
    await enterFiles('purpose:guide');
    await waitFor(() => expect(flowNode(source.id).data).toMatchObject({ block: { group: 'purpose:guide', purpose: 'guide', workArea: 'frontend' } }));
    const frame = flowNode('group:purpose:guide');
    act(() => current().onNodesChange?.([{ id: frame.id, type: 'position', position: { x: frame.position.x + 100, y: frame.position.y + 70 }, dragging: true }]));
    await act(async () => current().onNodeDragStop?.(new MouseEvent('mouseup'), flowNode(frame.id), current().nodes ?? []));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not move group: Layout unavailable');
    expect((await new CanvasStore(root).getCanvas(created.id)).blocks.find(value => value.id === guide.id)).toMatchObject({ x: 2000, y: 20 });
    await act(async () => current().onNodeDragStop?.(new MouseEvent('mouseup'), flowNode(frame.id), current().nodes ?? []));
    await waitFor(async () => expect((await new CanvasStore(root).getCanvas(created.id)).blocks.find(value => value.id === guide.id)).toMatchObject({ x: 2100, y: 90 }));
    expect(screen.queryByRole('alert')).toBeNull();
    const restarted = await new CanvasStore(root).getCanvas(created.id);
    expect(restarted.blocks.map(value => value.id)).toEqual(original.blocks.map(value => value.id));
    expect(restarted.blocks.find(value => value.id === source.id)).toMatchObject({ content: 'Original source content', purpose: 'guide', workArea: 'frontend', group: 'purpose:guide', x: 2120, y: 100 });
    expect(restarted.blocks.find(value => value.id === front.id)).toEqual(original.blocks.find(value => value.id === front.id));
    expect(await readFile(path.join(root, 'canvases', created.id + '.json'), 'utf8')).toContain('purpose:guide');
    view.unmount();
    render(<PersistentCanvas initial={restarted} />);
    await enterFiles('purpose:guide');
    expect(flowNode(source.id)).toMatchObject({ position: { x: 2120, y: 100 }, data: { block: { purpose: 'guide', workArea: 'frontend', content: 'Original source content' } } });
  });
});
