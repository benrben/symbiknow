// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Edge, ReactFlowInstance, ReactFlowProps } from '@xyflow/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { CanvasStore } from '../server/storage';
import { createApiServer } from '../server/index';
import { atomicJson } from '../server/storage-files';
import { Canvas } from './Canvas';
import type { FlowNode, GroupNodeData } from './canvas-types';
import { api } from './api';
import { makeSupergroups, type RootGroup } from './canvas-hierarchy';

function root(name: string, count = 1, tone = 0): RootGroup { return { group: 'custom:' + name, title: 'Group ' + name.toUpperCase(), count, tone }; }
function block(id: string, extra: Partial<CanvasBlock> = {}): CanvasBlock {
  return { id, title: 'Document ' + id, file: id + '.md', kind: 'markdown', content: '# ' + id, x: 10, y: 20, width: 320, height: 240, links: [], ...extra };
}
const equalRoots = 'abcdefghi'.split('').map((name, index) => root(name, 1, index));
const equalGroups = [
  { id: 'super:0', title: 'Group A', rootGroups: ['custom:a', 'custom:c', 'custom:e', 'custom:g', 'custom:i'], count: 5, topTitles: ['Group A', 'Group C', 'Group E', 'Group G', 'Group I'], tone: 0 },
  { id: 'super:1', title: 'Group B', rootGroups: ['custom:b', 'custom:d', 'custom:f', 'custom:h'], count: 4, topTitles: ['Group B', 'Group D', 'Group F', 'Group H'], tone: 1 },
];

describe('public hierarchy ordering, connectivity and defaults', () => {
  it.each([0, 1, 8])('keeps %s root groups at the direct map level', count => {
    expect(makeSupergroups(equalRoots.slice(0, count), [block('unregistered', { links: ['missing'] })])).toEqual([]);
  });
  it('creates stable communities at nine roots with exact seed, balancing, member and display tie breaks', () => {
    expect(makeSupergroups(equalRoots, [])).toEqual(equalGroups);
    expect(makeSupergroups([...equalRoots].reverse(), [])).toEqual(equalGroups);
    expect(makeSupergroups(equalRoots.map(value => ({ ...value, count: 0 })), [])).toEqual(equalGroups.map(value => ({ ...value, count: 0 })));
  });
  it('counts directed and repeated links, ignores self, dangling and outside-root links, and handles nested memberships', () => {
    const documents = equalRoots.map(({ group }) => block(group.slice(7), { group: group + '/notes/deeper', links: group === 'custom:a' ? ['b', 'b', 'c', 'missing', 'a', 'outside'] : group === 'custom:b' ? ['a', 'c'] : [] }));
    documents.push(block('outside', { group: 'custom:outside/child', links: ['a', 'missing'] }));
    expect(makeSupergroups(equalRoots, documents)).toEqual([
      { id: 'super:0', title: 'Group A', rootGroups: ['custom:a', 'custom:b', 'custom:c', 'custom:g', 'custom:i'], count: 5, topTitles: ['Group A', 'Group B', 'Group C', 'Group G', 'Group I'], tone: 0 },
      { id: 'super:1', title: 'Group D', rootGroups: ['custom:d', 'custom:e', 'custom:f', 'custom:h'], count: 4, topTitles: ['Group D', 'Group E', 'Group F', 'Group H'], tone: 3 },
    ]);
  });
  it('preserves community and highlight ordering when link direction, document order and root order reverse', () => {
    const forward = equalRoots.map(({ group }) => block(group.slice(7), { group: group + '/notes', links: group === 'custom:a' ? ['b'] : group === 'custom:b' ? ['c'] : [] }));
    const reverse = equalRoots.map(({ group }) => block(group.slice(7), { group: group + '/notes', links: group === 'custom:b' ? ['a'] : group === 'custom:c' ? ['b'] : [] }));
    const expected = [
      { id: 'super:0', title: 'Group B', rootGroups: ['custom:a', 'custom:b', 'custom:c', 'custom:g', 'custom:i'], count: 5, topTitles: ['Group B', 'Group A', 'Group C', 'Group G', 'Group I'], tone: 1 },
      { id: 'super:1', title: 'Group D', rootGroups: ['custom:d', 'custom:e', 'custom:f', 'custom:h'], count: 4, topTitles: ['Group D', 'Group E', 'Group F', 'Group H'], tone: 3 },
    ];
    expect(makeSupergroups(equalRoots, forward)).toEqual(expected);
    expect(makeSupergroups([...equalRoots].reverse(), reverse.reverse())).toEqual(expected);
  });
  it.each([undefined, ''])('assigns a document without a named group (%j) to Ungrouped and normalizes legacy reading lanes', group => {
    const roots = [{ group: '__ungrouped', title: 'Ungrouped', count: 1, tone: 7 }, { group: 'lane:work', title: 'Active work', count: 1, tone: 1 }, ...equalRoots.slice(0, 7)];
    const documents = [block('plain', { group, links: ['legacy'] }), block('legacy', { group: 'work', links: ['plain'] })];
    expect(makeSupergroups(roots, documents)).toEqual([
      { id: 'super:0', title: 'Ungrouped', rootGroups: ['__ungrouped', 'custom:c', 'custom:e', 'custom:g', 'lane:work'], count: 5, topTitles: ['Ungrouped', 'Active work', 'Group C', 'Group E', 'Group G'], tone: 7 },
      { id: 'super:1', title: 'Group A', rootGroups: ['custom:a', 'custom:b', 'custom:d', 'custom:f'], count: 4, topTitles: ['Group A', 'Group B', 'Group D', 'Group F'], tone: 0 },
    ]);
  });
  it('sorts communities by total document count and selects title and tone by count before affinity', () => {
    const roots = equalRoots.map((value, index) => ({ ...value, count: index + 1, title: index === 8 ? 'Engineering frontend' : value.title }));
    expect(makeSupergroups(roots, [])).toEqual([
      { id: 'super:0', title: 'Group H', rootGroups: ['custom:a', 'custom:c', 'custom:e', 'custom:g', 'custom:h'], count: 24, topTitles: ['Group H', 'Group G', 'Group E', 'Group C', 'Group A'], tone: 7 },
      { id: 'super:1', title: 'Frontend', rootGroups: ['custom:b', 'custom:d', 'custom:f', 'custom:i'], count: 21, topTitles: ['Engineering frontend', 'Group F', 'Group D', 'Group B'], tone: 8 },
    ]);
  });
  it('keeps two dense communities intact and enforces the six-root cap', () => {
    const roots = 'abcdefghijkl'.split('').map((name, index) => root(name, 1, index));
    const documents = roots.map((value, index) => block(value.group.slice(7), { group: value.group + '/notes', links: roots.filter((_, other) => other !== index && Math.floor(other / 6) === Math.floor(index / 6)).map(other => other.group.slice(7)) }));
    expect(makeSupergroups(roots, documents)).toEqual([
      { id: 'super:0', title: 'Group A', rootGroups: ['custom:a', 'custom:b', 'custom:c', 'custom:d', 'custom:e', 'custom:f'], count: 6, topTitles: ['Group A', 'Group B', 'Group C', 'Group D', 'Group E', 'Group F'], tone: 0 },
      { id: 'super:1', title: 'Group G', rootGroups: ['custom:g', 'custom:h', 'custom:i', 'custom:j', 'custom:k', 'custom:l'], count: 6, topTitles: ['Group G', 'Group H', 'Group I', 'Group J', 'Group K', 'Group L'], tone: 6 },
    ]);
  });
  it.each([13, 37])('places all %s disconnected roots exactly once without changing its inputs', count => {
    const roots = Array.from({ length: count }, (_, index) => root(String(index).padStart(2, '0'), index % 3, index % 8));
    const documents = roots.map(value => block(value.group, { group: value.group }));
    const originalRoots = structuredClone(roots);
    const originalDocuments = structuredClone(documents);
    const result = makeSupergroups(roots, documents);
    expect(result).toHaveLength(Math.ceil(count / 6));
    expect(result.map(value => value.id)).toEqual(Array.from({ length: Math.ceil(count / 6) }, (_, index) => 'super:' + index));
    expect(result.every(value => value.rootGroups.length <= 6)).toBe(true);
    expect(result.flatMap(value => value.rootGroups).sort()).toEqual(roots.map(value => value.group).sort());
    expect(result.reduce((sum, value) => sum + value.count, 0)).toBe(roots.reduce((sum, value) => sum + value.count, 0));
    expect(roots).toEqual(originalRoots);
    expect(documents).toEqual(originalDocuments);
    expect(makeSupergroups([...roots].reverse(), [...documents].reverse())).toEqual(result);
  });
});

type FlowProps = ReactFlowProps<FlowNode, Edge>;
const flow = vi.hoisted(() => ({ current: null as FlowProps | null, instance: null as ReactFlowInstance<FlowNode, Edge> | null }));
// Keep the installed renderer and event handlers; observe only its public inputs and instance.
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
const nativeFetch = globalThis.fetch;
const originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
const originalUrl = window.location.href;
const servers: { server: Server; root: string }[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
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
afterEach(async () => {
  cleanup();
  window.history.replaceState(null, '', originalUrl);
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
function currentFlow(): FlowProps {
  if (!flow.current) throw new Error('Canvas flow is not mounted');
  return flow.current;
}
function instance(): ReactFlowInstance<FlowNode, Edge> {
  if (!flow.instance) throw new Error('Canvas flow instance is not ready');
  return flow.instance;
}
function groupElement(group: string): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-canvas-group="' + group + '"]');
  if (!element) throw new Error('Group is not visible: ' + group);
  return element;
}
function mapSummary(node: FlowNode) {
  const data = node.data as GroupNodeData;
  return { id: node.id, group: data.group, title: data.title, count: data.count, tone: data.tone, topTitles: data.topTitles };
}
async function openGroup(group: string) {
  await waitFor(() => expect(groupElement(group)).toBeTruthy());
  fireEvent.click(within(groupElement(group)).getAllByRole('button')[0]);
}
async function overview() {
  await waitFor(() => expect(instance()).toBeTruthy());
  await act(async () => { await instance().setViewport({ x: 24, y: 68, zoom: .28 }, { duration: 0 }); });
  await waitFor(() => expect(document.querySelector('.canvas-surface')?.classList.contains('canvas-surface--overview')).toBe(true));
}

describe('hierarchy through the actual Canvas and stored documents', () => {
  let fixture: { root: string; canvasId: string; notes: CanvasBlock; benchmark: CanvasBlock; original: CanvasDocument };
  beforeEach(async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-hierarchy-public-'));
    const store = new CanvasStore(root);
    await store.init();
    const canvas = await store.createCanvas('acme-team', { name: 'Hierarchy persistence' });
    const notes = await store.createBlock(canvas.id, { title: 'Research notes', kind: 'markdown', content: 'Original research note', group: 'custom:research/notes', x: 10, y: 20 });
    const benchmark = await store.createBlock(canvas.id, { title: 'Research benchmark', kind: 'markdown', content: 'Benchmark evidence', group: 'custom:research/benchmarks', x: 420, y: 20 });
    // These unrelated community members are restored files, not writes exercised by the test.
    const extras = Array.from({ length: 8 }, (_, index) => ({ id: 'extra-' + index, title: 'Extra ' + index,
      file: `docs/extra-${index}.md`, kind: 'markdown', width: notes.width, height: notes.height, links: [],
      group: 'custom:extra_' + index, x: 900 + index * 400, y: 20 }));
    await Promise.all(extras.map((extra, index) => writeFile(path.join(root, extra.file), 'Evidence ' + index)));
    const canvasFile = path.join(root, 'canvases', canvas.id + '.json');
    const restored = JSON.parse(await readFile(canvasFile, 'utf8'));
    await atomicJson(canvasFile, { ...restored, blocks: [...restored.blocks, ...extras] });
    const original = await store.getCanvas(canvas.id);
    const server = await createApiServer({ dataDir: root });
    servers.push({ server, root });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const base = 'http://127.0.0.1:' + address.port;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => nativeFetch(base + String(input), init));
    fixture = { root, canvasId: canvas.id, notes, benchmark, original };
  });
  it('opens supergroups, nested groups and documents from disk and retains communities after real link persistence and reload', async () => {
    const { root, canvasId, notes, benchmark, original } = fixture;
    function StoredCanvas({ initial }: { initial: CanvasDocument }) {
      const [document, setDocument] = useState(initial);
      async function refresh() { setDocument(await api<CanvasDocument>('/canvases/' + canvasId)); }
      async function update(id: string, patch: Partial<CanvasBlock>) {
        await api('/canvases/' + canvasId + '/blocks/' + id, { method: 'PUT', body: JSON.stringify(patch) });
        await refresh();
      }
      return <Canvas canvas={document} onUpdateBlock={update} onDeleteBlock={async id => {
        await api('/canvases/' + canvasId + '/blocks/' + id, { method: 'DELETE' });
        await refresh();
      }} onSelectBlock={value => window.history.replaceState(null, '', '?document=' + value.id)} />;
    }
    const ui = render(<StoredCanvas initial={original} />);
    await overview();
    const topNodes = currentFlow().nodes?.filter(value => value.type === 'groupFrame') ?? [];
    expect(topNodes).toHaveLength(2);
    expect(topNodes.every(value => value.id.startsWith('group:super:'))).toBe(true);
    const researchSuper = topNodes.find(value => (value.data as { topTitles?: string[] }).topTitles?.includes('Research'));
    if (!researchSuper) throw new Error('Research supergroup is missing');
    const originalCommunities = topNodes.map(mapSummary);
    await openGroup(String(researchSuper.data.group));
    await screen.findByRole('button', { name: /Supergroup:/ });
    await openGroup('custom:research');
    await waitFor(() => expect(within(groupElement('custom:research/notes')).getByText('Notes')).toBeTruthy());
    expect(currentFlow().nodes?.map(value => value.id)).toContain('group:custom:research/benchmarks');
    await openGroup('custom:research/notes');
    await waitFor(() => expect(instance().getZoom()).toBe(1));
    await screen.findByRole('button', { name: 'Read Research notes full page' });
    fireEvent.click(screen.getByRole('button', { name: 'Read Research notes full page' }));
    expect(window.location.search).toBe('?document=' + notes.id);
    expect(currentFlow().nodes?.filter(value => value.type === 'document').map(value => value.id)).toEqual([notes.id]);
    await act(async () => currentFlow().onConnect?.({ source: notes.id, target: benchmark.id, sourceHandle: null, targetHandle: null }));
    await waitFor(async () => expect((await new CanvasStore(root).getCanvas(canvasId)).blocks.find(value => value.id === notes.id)?.links).toEqual([benchmark.id]));
    const reloaded = await new CanvasStore(root).getCanvas(canvasId);
    expect(reloaded.blocks.map(value => value.id)).toEqual(original.blocks.map(value => value.id));
    expect(reloaded.blocks.find(value => value.id === notes.id)).toMatchObject({ content: 'Original research note', group: 'custom:research/notes', links: [benchmark.id] });
    expect(await readFile(path.join(root, 'canvases', canvasId + '.json'), 'utf8')).toContain(benchmark.id);
    ui.unmount();
    render(<StoredCanvas initial={reloaded} />);
    await overview();
    expect(currentFlow().nodes?.filter(value => value.type === 'groupFrame').map(mapSummary)).toEqual(originalCommunities);
    await openGroup(String(researchSuper.data.group));
    await openGroup('custom:research');
    expect(currentFlow().edges?.map(value => value.id)).toContain('group-edge:custom:research/notes->custom:research/benchmarks');
  });
});
