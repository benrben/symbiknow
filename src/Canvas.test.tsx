// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { Connection, Edge } from '@xyflow/react';
import { Canvas } from './Canvas';

type RenderNode = { id: string; type: string; data: { block: CanvasBlock; title?: string; count?: number }; position: { x: number; y: number }; width?: number; height?: number };
type PositionChange = { type: 'position'; id: string; position?: { x: number; y: number }; dragging?: boolean };
type FlowProps = {
  nodes: RenderNode[];
  edges: Edge[];
  nodeTypes: Record<string, React.ComponentType<{ data: RenderNode['data']; selected: boolean }>>;
  children: React.ReactNode;
  onNodeDragStop: (event: unknown, node: RenderNode) => void;
  onNodesChange: (changes: PositionChange[]) => void;
  onNodeDoubleClick: (event: unknown, node: RenderNode) => void;
  onNodeClick: (event: unknown, node: RenderNode) => void;
  onSelectionChange: (selection: { nodes: RenderNode[] }) => void;
  onMove: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
  onMoveEnd: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
  onConnect: (connection: Connection) => void;
  onEdgesDelete: (edges: Edge[]) => void;
  onBeforeDelete: (selection: { nodes: RenderNode[]; edges: Edge[] }) => Promise<boolean>;
  onlyRenderVisibleElements?: boolean;
  panOnScroll?: boolean;
  zoomOnScroll?: boolean;
  onInit?: (instance: { fitView: typeof flow.fitView; getZoom: () => number; getViewport: () => { x: number; y: number; zoom: number }; setViewport: typeof flow.viewport; zoomTo: typeof flow.zoomTo }) => void;
};

const flow = vi.hoisted(() => ({ current: null as unknown, center: vi.fn(), viewport: vi.fn(), viewportValue: { x: 0, y: 0, zoom: 1 }, fitView: vi.fn(async () => true), zoomTo: vi.fn(async () => true), mounts: 0, commits: [] as string[][], previewRenders: new Map<string, number>() }));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Position: { Left: 'left', Right: 'right' },
    useNodesState: (initial: RenderNode[]) => {
      const [nodes, setNodes] = React.useState(initial);
      const apply = (changes: PositionChange[]) => setNodes(current => current.map(node => {
        const change = changes.find(item => item.id === node.id && item.position);
        return change ? { ...node, position: change.position! } : node;
      }));
      return [nodes, setNodes, apply];
    },
    useReactFlow: () => ({ setCenter: flow.center, setViewport: flow.viewport, getZoom: () => 1 }),
    useStore: () => true,
    ReactFlow: (props: FlowProps) => {
      React.useEffect(() => {
        flow.mounts++;
        props.onInit?.({ fitView: flow.fitView, getZoom: () => 1, getViewport: () => flow.viewportValue, setViewport: flow.viewport, zoomTo: flow.zoomTo });
      }, []);
      React.useEffect(() => { flow.commits.push(props.nodes.filter(node => node.type === 'document').map(node => node.id)); });
      flow.current = props;
      return React.createElement('div', { 'data-testid': 'flow' },
        props.nodes.map(node => React.createElement('div', {
          key: node.id,
          'data-testid': `node-${node.id}`,
          onDoubleClick: () => props.onNodeDoubleClick({}, node),
        }, React.createElement(props.nodeTypes[node.type], { data: node.data, selected: node.id === 'a' }))),
        props.children);
    },
    NodeResizer: (props: { onResizeEnd: (event: unknown, dimensions: { width: number; height: number }) => void }) =>
      React.createElement('button', { onClick: () => props.onResizeEnd({}, { width: 550, height: 330 }) }, 'Resize'),
    Handle: () => null,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    ViewportPortal: ({ children }: { children: React.ReactNode }) => React.createElement('div', { 'data-testid': 'group-portal' }, children),
  };
});

vi.mock('./Loaders', async () => {
  const React = await import('react');
  return {
    BlockContent: (props: { block: CanvasBlock; onError: (message: string) => void }) => {
      flow.previewRenders.set(props.block.id, (flow.previewRenders.get(props.block.id) ?? 0) + 1);
      return React.createElement('button', { onClick: () => props.onError('Preview failed') }, `Preview ${props.block.title}`);
    },
  };
});

function block(id: string, links: string[] = []): CanvasBlock {
  return { id, title: `Document ${id}`, file: `docs/${id}.md`, kind: 'markdown', content: `# ${id}`, x: 10, y: 20, width: 320, height: 240, links };
}

function canvas(blocks: CanvasBlock[]): CanvasDocument {
  return { id: 'planning', name: 'Planning', workspaceId: 'team', blocks };
}

function currentFlow(): FlowProps {
  if (!flow.current) throw new Error('React Flow was not mounted');
  return flow.current as FlowProps;
}

afterEach(() => {
  cleanup();
  flow.current = null;
  flow.center.mockClear();
  flow.viewport.mockClear();
  flow.fitView.mockClear();
  flow.zoomTo.mockClear();
  flow.viewportValue = { x: 0, y: 0, zoom: 1 };
  flow.mounts = 0;
  flow.commits = [];
  flow.previewRenders.clear();
});

describe('infinite canvas', () => {
  it('reuses React Flow while resetting viewport and selection when a canvas changes', async () => {
    const first = canvas([block('a')]);
    const second = { ...canvas([{ ...block('b'), x: 900 }]), id: 'design', name: 'Design' };
    const third = { ...canvas([block('c')]), id: 'roadmap', name: 'Roadmap' };
    const props = { onUpdateBlock: vi.fn(async () => undefined), onDeleteBlock: vi.fn(async () => undefined), onSelectBlock: vi.fn() };
    const view = render(<Canvas canvas={first} {...props}/>);
    await waitFor(() => expect(currentFlow().nodes.some(node => node.id === 'a')).toBe(true));
    act(() => currentFlow().onNodeClick({}, currentFlow().nodes.find(node => node.id === 'a')!));
    expect(screen.getByRole('button', { name: 'Close inspector' })).toBeTruthy();
    act(() => currentFlow().onMoveEnd({}, { x: -250, y: -80, zoom: 0.6 }));
    const commitsBeforeSwitch = flow.commits.length;
    view.rerender(<Canvas canvas={second} {...props}/>);
    await waitFor(() => expect(currentFlow().nodes.some(node => node.id === 'b')).toBe(true));
    expect(flow.commits.slice(commitsBeforeSwitch)[0]).toContain('b');
    expect(flow.commits.slice(commitsBeforeSwitch).every(ids => !ids.includes('a'))).toBe(true);
    expect(currentFlow().nodes.some(node => node.id === 'a')).toBe(false);
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledWith({ padding: 0.12, maxZoom: 1, duration: 0 }));
    expect(flow.mounts).toBe(1);
    expect(screen.queryByRole('button', { name: 'Close inspector' })).toBeNull();
    view.rerender(<Canvas canvas={third} viewportRequest={{ x: 42, y: 17, zoom: 0.8, sequence: 1 }} {...props}/>);
    await waitFor(() => expect(flow.viewport).toHaveBeenCalledWith({ x: 42, y: 17, zoom: 0.8 }, { duration: 300 }));
    expect(flow.fitView).toHaveBeenCalledTimes(1);
    expect(flow.mounts).toBe(1);
  });

  it('restores each canvas viewport on return without carrying selection across canvases', async () => {
    const first = canvas([block('a')]);
    const second = { ...canvas([block('b')]), id: 'design', name: 'Design' };
    const props = { onUpdateBlock: vi.fn(async () => undefined), onDeleteBlock: vi.fn(async () => undefined), onSelectBlock: vi.fn() };
    const view = render(<Canvas canvas={first} {...props}/>);
    await waitFor(() => expect(currentFlow().nodes.some(node => node.id === 'a')).toBe(true));
    const firstViewport = { x: -170, y: 40, zoom: 0.85 };
    flow.viewportValue = firstViewport;
    act(() => currentFlow().onMoveEnd({}, firstViewport));
    act(() => currentFlow().onNodeClick({}, currentFlow().nodes.find(node => node.id === 'a')!));
    expect(screen.getByRole('button', { name: 'Close inspector' })).toBeTruthy();
    view.rerender(<Canvas canvas={second} {...props}/>);
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1));
    const secondViewport = { x: 23, y: -70, zoom: 0.9 };
    flow.viewportValue = secondViewport;
    act(() => currentFlow().onMoveEnd({}, secondViewport));
    view.rerender(<Canvas canvas={first} {...props}/>);
    await waitFor(() => expect(flow.viewport).toHaveBeenCalledWith(firstViewport, { duration: 0 }));
    expect(flow.fitView).toHaveBeenCalledTimes(1);
    expect(flow.mounts).toBe(1);
    expect(screen.queryByRole('button', { name: 'Close inspector' })).toBeNull();
  });
  it('keeps 60 previews out of title mode and avoids rendering unchanged previews during a drag', async () => {
    const docs = Array.from({ length: 60 }, (_, index) => ({ ...block(`doc-${index}`), x: index * 400 }));
    const document = canvas(docs);
    const update = vi.fn(async () => undefined);
    const view = render(<Canvas canvas={document} onUpdateBlock={update} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(flow.previewRenders.size).toBe(60));
    expect(currentFlow().onlyRenderVisibleElements).toBe(true);
    const initial = [...flow.previewRenders.values()].reduce((total, count) => total + count, 0);
    const changedUpdate = vi.fn(async () => undefined);
    view.rerender(<Canvas canvas={document} onUpdateBlock={changedUpdate} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    expect([...flow.previewRenders.values()].reduce((total, count) => total + count, 0)).toBe(initial);
    act(() => currentFlow().onNodesChange([{ type: 'position', id: 'doc-0', position: { x: 40, y: 50 }, dragging: true }]));
    expect([...flow.previewRenders.values()].reduce((total, count) => total + count, 0)).toBe(initial);
    fireEvent.click(within(screen.getByTestId('node-doc-0')).getByText('Resize'));
    await waitFor(() => expect(changedUpdate).toHaveBeenCalledWith('doc-0', { width: 550, height: 330 }));
    expect(update).not.toHaveBeenCalled();
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.6 }));
    expect(screen.queryByText('Preview Document doc-0')).toBeNull();
    expect(screen.queryAllByText(/^Preview Document/)).toHaveLength(0);
    act(() => currentFlow().onMoveEnd({}, { x: 0, y: 0, zoom: 1 }));
    expect(screen.queryAllByText(/^Preview Document/)).toHaveLength(60);
  });
  it('draws saved groups as frames with links between groups, including older lane names', async () => {
    const first = { ...block('a', ['b']), group: 'overview' };
    const second = { ...block('b'), group: 'area:sales', x: 750 };
    render(<Canvas canvas={canvas([first, second])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(2));
    const frames = currentFlow().nodes.filter(node => node.type === 'groupFrame');
    expect(frames.map(node => [node.id, node.position.x, node.position.y])).toEqual([['group:lane:overview', -18, -45], ['group:area:sales', 722, -45]]);
    expect(screen.getByLabelText('Overview group, 1 documents')).toBeTruthy();
    expect(screen.getByLabelText('Sales group, 1 documents')).toBeTruthy();
    expect(currentFlow().edges.map(edge => [edge.source, edge.target, edge.label ?? null])).toEqual([
      ['group:lane:overview', 'group:area:sales', '1 link'], ['a', 'b', null],
    ]);
  });

  it('moves a whole group from its frame and saves every member position', async () => {
    const onMoveBlocks = vi.fn(async () => undefined);
    const members = [{ ...block('a'), group: 'area:sales' }, { ...block('b'), group: 'area:sales', y: 300 }, block('c')];
    render(<Canvas canvas={canvas(members)} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()} onMoveBlocks={onMoveBlocks}/>);
    await waitFor(() => expect(currentFlow().nodes.some(node => node.id === 'group:area:sales')).toBe(true));
    const frame = currentFlow().nodes.find(node => node.id === 'group:area:sales')!;
    act(() => currentFlow().onNodesChange([{ type: 'position', id: frame.id, position: { x: frame.position.x + 100, y: frame.position.y + 50 }, dragging: true }]));
    await waitFor(() => expect(currentFlow().nodes.find(node => node.id === 'a')?.position).toEqual({ x: 110, y: 70 }));
    expect(currentFlow().nodes.find(node => node.id === 'c')?.position).toEqual({ x: 10, y: 20 });
    act(() => currentFlow().onNodeDragStop({}, currentFlow().nodes.find(node => node.id === 'group:area:sales')!));
    expect(onMoveBlocks).toHaveBeenCalledWith([{ blockId: 'a', x: 110, y: 70 }, { blockId: 'b', x: 110, y: 350 }]);
  });

  it('moves a dropped card into another group and relabels it, or out of a group when dropped far away', async () => {
    const onUpdateBlock = vi.fn(async () => undefined);
    const docs = [{ ...block('a'), group: 'area:sales' }, { ...block('b'), group: 'area:frontend', x: 900 }, { ...block('c'), group: 'area:frontend', x: 900, y: 400 }];
    render(<Canvas canvas={canvas(docs)} onUpdateBlock={onUpdateBlock} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(3));
    const card = currentFlow().nodes.find(node => node.id === 'c')!;
    act(() => currentFlow().onNodeDragStop({}, { ...card, position: { x: 20, y: 40 } }));
    expect(onUpdateBlock).toHaveBeenCalledWith('c', { x: 20, y: 40, group: 'area:sales', workArea: 'sales' });
    const other = currentFlow().nodes.find(node => node.id === 'b')!;
    act(() => currentFlow().onNodeDragStop({}, { ...other, position: { x: 3000, y: 3000 } }));
    expect(onUpdateBlock).toHaveBeenCalledWith('b', { x: 3000, y: 3000, group: null });
    act(() => currentFlow().onNodeDragStop({}, { ...currentFlow().nodes.find(node => node.id === 'a')!, position: { x: 30, y: 30 } }));
    expect(onUpdateBlock).toHaveBeenLastCalledWith('a', { x: 30, y: 30 });
  });

  it('shows colored purpose and reviewer badges on document cards', async () => {
    render(<Canvas canvas={canvas([{ ...block('a'), purpose: 'guide', reviewer: 'Engineering' }])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    const first = await screen.findByTestId('node-a');
    expect(within(first).getByTitle('Purpose: guide')).toHaveProperty('className', 'canvas-card__purpose');
    expect(within(first).getByTitle('Purpose: guide')).toHaveProperty('dataset', expect.objectContaining({ purpose: 'guide' }));
    expect(within(first).getByTitle('Reviewer: Engineering')).toHaveProperty('className', 'canvas-card__reviewer');
  });

  it('shows a quality meter and opens cross-canvas portal chips from a card', async () => {
    const onOpenCrossLink = vi.fn();
    const linked = { ...block('a'), quality: { score: 0.76, at: '2026-09-26T12:00:00Z' }, crossLinks: [
      { canvasId: 'billing', blockId: 'client', relation: 'implements' as const },
      { canvasId: 'operations', blockId: 'runbook', relation: 'same_topic' as const },
    ] };
    render(<Canvas canvas={canvas([linked])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()} onOpenCrossLink={onOpenCrossLink} crossLinkLabels={{ 'billing:client': 'Billing · Billing client' }}/>);
    const card = await screen.findByTestId('node-a');
    const quality = within(card).getByRole('meter', { name: 'Quality for Document a' });
    expect(quality.getAttribute('value')).toBe('0.76');
    expect(within(card).getByTitle('Document quality: 76%')).toBeTruthy();
    expect(within(card).getByTitle('2 cross-canvas links').textContent).toBe('↗ 2');
    expect(within(card).getByText('↗ Other canvas: Billing · Billing client')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Open related document client on canvas billing' }));
    expect(onOpenCrossLink).toHaveBeenCalledWith('billing', 'client');
  });

  it('labels document edges with saved link relations', async () => {
    render(<Canvas canvas={canvas([{ ...block('a', ['b']), linkTypes: { b: 'decision_for' } }, block('b')])}
      onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().edges.find(edge => edge.id === 'a->b')?.label).toBe('decision for'));
  });

  it('renders Markdown cards and existing links, and opens a card from edit or double click', async () => {
    const onSelectBlock = vi.fn();
    render(<Canvas canvas={canvas([block('a', ['b', 'missing']), block('b')])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={onSelectBlock}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(2));
    expect(currentFlow().edges.map(edge => [edge.source, edge.target])).toEqual([['a', 'b']]);
    expect(screen.getByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Return to canvas group overview' }).textContent).toBe('Planning');
    const first = screen.getByTestId('node-a');
    expect(first.querySelector('.is-selected')).toBeTruthy();
    expect(within(first).getByText('docs/a.md')).toBeTruthy();
    fireEvent.click(within(first).getByRole('button', { name: 'Edit Document a' }));
    fireEvent.doubleClick(screen.getByTestId('node-b'));
    expect(onSelectBlock.mock.calls.map(call => call[0].id)).toEqual(['a', 'b']);
    fireEvent.doubleClick(within(first).getByRole('button', { name: 'Preview Document a' }));
    expect(onSelectBlock).toHaveBeenCalledTimes(2);
  });

  it('offers focused Jev analysis from each document card', async () => {
    const onAnalyzeBlock = vi.fn();
    render(<Canvas canvas={canvas([block('a')])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()}
      onSelectBlock={vi.fn()} onAnalyzeBlock={onAnalyzeBlock}/>);
    const card = await screen.findByTestId('node-a');
    const actions = within(card).getByRole('button', { name: 'Actions for Document a' });
    for (const [label, focus] of [['Find related documents', 'related'], ['Check for conflicts', 'conflicts'], ['Suggest labels', 'labels']] as const) {
      fireEvent.click(actions);
      fireEvent.click(within(card).getByRole('menuitem', { name: label }));
      expect(onAnalyzeBlock).toHaveBeenLastCalledWith('a', focus);
      expect(actions.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('persists card drag and resize, adds valid links, and groups deleted edges by source', async () => {
    const onUpdateBlock = vi.fn(async () => undefined);
    render(<Canvas canvas={canvas([block('a', ['b', 'c']), block('b'), block('c')])} onUpdateBlock={onUpdateBlock} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(3));

    act(() => currentFlow().onNodeDragStop({}, { ...currentFlow().nodes.find(node => node.id === 'a')!, position: { x: 130, y: -40 } }));
    fireEvent.click(within(screen.getByTestId('node-a')).getByRole('button', { name: 'Resize' }));
    await waitFor(() => expect(onUpdateBlock).toHaveBeenCalledWith('a', { width: 550, height: 330 }));
    expect(onUpdateBlock).toHaveBeenCalledWith('a', { x: 130, y: -40 });

    act(() => {
      currentFlow().onConnect({ source: '', target: 'a', sourceHandle: null, targetHandle: null });
      currentFlow().onConnect({ source: 'a', target: '', sourceHandle: null, targetHandle: null });
      currentFlow().onConnect({ source: 'a', target: 'a', sourceHandle: null, targetHandle: null });
      currentFlow().onConnect({ source: 'unknown', target: 'a', sourceHandle: null, targetHandle: null });
      currentFlow().onConnect({ source: 'a', target: 'b', sourceHandle: null, targetHandle: null });
      currentFlow().onConnect({ source: 'b', target: 'a', sourceHandle: null, targetHandle: null });
    });
    await waitFor(() => expect(onUpdateBlock).toHaveBeenCalledWith('b', { links: ['a'] }));
    expect(onUpdateBlock).toHaveBeenCalledTimes(3);

    act(() => currentFlow().onEdgesDelete([
      { id: 'a->b', source: 'a', target: 'b' },
      { id: 'a->c', source: 'a', target: 'c' },
      { id: 'unknown->a', source: 'unknown', target: 'a' },
    ]));
    await waitFor(() => expect(onUpdateBlock).toHaveBeenCalledWith('a', { links: [] }));
    expect(onUpdateBlock).toHaveBeenCalledTimes(4);
  });

  it('shows and dismisses save errors while preserving the canvas', async () => {
    const onUpdateBlock = vi.fn(async () => { throw new Error('Disk is full'); });
    render(<Canvas canvas={canvas([block('a', ['b']), block('b')])} onUpdateBlock={onUpdateBlock} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(2));
    act(() => currentFlow().onNodeDragStop({}, currentFlow().nodes.find(node => node.id === 'a')!));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save: Disk is full');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('node-a')).toBeTruthy();

    fireEvent.click(within(screen.getByTestId('node-a')).getByRole('button', { name: 'Preview Document a' }));
    expect(screen.getByRole('alert').textContent).toContain('Preview failed');

    act(() => currentFlow().onConnect({ source: 'b', target: 'a', sourceHandle: null, targetHandle: null }));
    await waitFor(() => expect(onUpdateBlock).toHaveBeenCalledWith('b', { links: ['a'] }));
    act(() => currentFlow().onEdgesDelete([{ id: 'a->b', source: 'a', target: 'b' }]));
    await waitFor(() => expect(onUpdateBlock).toHaveBeenCalledWith('a', { links: [] }));
  });

  it('shows a generic save error for an unexpected rejection', async () => {
    const onUpdateBlock = vi.fn(async () => { throw 'failed'; });
    render(<Canvas canvas={canvas([block('a')])} onUpdateBlock={onUpdateBlock} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(1));
    fireEvent.click(within(screen.getByTestId('node-a')).getByRole('button', { name: 'Resize' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save this change.');
  });

  it('persists selected documents before React Flow removes them', async () => {
    const onDeleteBlock = vi.fn(async (blockId: string) => { expect(['a', 'b']).toContain(blockId); });
    render(<Canvas canvas={canvas([block('a'), block('b')])} onUpdateBlock={vi.fn()} onDeleteBlock={onDeleteBlock} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(2));
    expect(await currentFlow().onBeforeDelete({ nodes: currentFlow().nodes, edges: [] })).toBe(false);
    expect(onDeleteBlock.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
    expect(screen.getByTestId('node-a')).toBeTruthy();
    expect(await currentFlow().onBeforeDelete({ nodes: [], edges: currentFlow().edges })).toBe(true);
  });

  it('keeps the selected document visible when deletion fails', async () => {
    const onDeleteBlock = vi.fn(async () => { throw new Error('Storage failed'); });
    render(<Canvas canvas={canvas([block('a')])} onUpdateBlock={vi.fn()} onDeleteBlock={onDeleteBlock} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(1));
    expect(await currentFlow().onBeforeDelete({ nodes: currentFlow().nodes, edges: [] })).toBe(false);
    expect(screen.getByTestId('node-a')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not delete: Storage failed');
  });

  it('reports an unexpected deletion failure without removing the document', async () => {
    const onDeleteBlock = vi.fn(async () => { throw 'failed'; });
    render(<Canvas canvas={canvas([block('a')])} onUpdateBlock={vi.fn()} onDeleteBlock={onDeleteBlock} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(1));
    expect(await currentFlow().onBeforeDelete({ nodes: currentFlow().nodes, edges: [] })).toBe(false);
    expect(screen.getByTestId('node-a')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not delete this document.');
  });

  it('shows readable groups at overview zoom and title-only cards at medium zoom', async () => {
    const docs = [{ ...block('a'), group: 'custom:research/benchmarks' }, { ...block('b'), group: 'custom:research/notes', x: 800 }];
    render(<Canvas canvas={canvas(docs)} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.some(node => node.id === 'group:custom:research')).toBe(true));
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.2 }));
    expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(0);
    expect(screen.getByText('Groups · 20%')).toBeTruthy();
    expect(currentFlow().panOnScroll).toBe(false);
    expect(currentFlow().zoomOnScroll).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show group list' }));
    const overview = screen.getByRole('navigation', { name: 'Group overview' });
    expect(within(overview).getByText('Document a')).toBeTruthy();
    expect(within(overview).getByText('Document b')).toBeTruthy();
    expect(overview.querySelector('.canvas-overview-board__previews i')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Mini-map groups' }).textContent).toContain('Research');
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.5 }));
    expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(0);
    expect(screen.getByText('Groups · 50%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show connections' }));
    fireEvent.click(screen.getByTestId('node-group:custom:research').querySelector('.canvas-group')!);
    fireEvent.click(screen.getByTestId('node-group:custom:research/benchmarks').querySelector('.canvas-group')!);
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.5 }));
    expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(1);
    expect(screen.getByTestId('node-a').querySelector('.is-title-only')).toBeTruthy();
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 1 }));
    expect(screen.getByTestId('node-a').querySelector('.is-title-only')).toBeNull();
  });

  it('opens a large canvas through supergroups, groups, subgroups, and files', async () => {
    const viewChanged = vi.fn();
    const docs = [
      { ...block('research-notes', ['research-benchmarks']), group: 'custom:research/notes' },
      { ...block('research-benchmarks'), group: 'custom:research/benchmarks', x: 450 },
      ...Array.from({ length: 8 }, (_, index) => ({ ...block(`extra-${index}`), group: `custom:extra_${index}`, x: 900 + index * 400 })),
    ];
    render(<Canvas canvas={canvas(docs)} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()} onViewportChange={viewChanged}/>);
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.2 }));
    const topLevel = currentFlow().nodes.filter(node => node.type === 'groupFrame');
    expect(topLevel).toHaveLength(2);
    expect(topLevel.every(node => node.id.startsWith('group:super:'))).toBe(true);
    const researchSuper = topLevel.find(node => (node.data as unknown as { topTitles: string[] }).topTitles.includes('Research'))!;
    fireEvent.wheel(screen.getByTestId(`node-${researchSuper.id}`).querySelector('.canvas-group')!, { deltaY: -180 });
    act(() => currentFlow().onMoveEnd({}, { x: 0, y: 0, zoom: 0.52 }));
    expect(screen.getByText('Groups · 52%')).toBeTruthy();
    expect(currentFlow().nodes.some(node => node.id === 'group:custom:research')).toBe(true);
    fireEvent.wheel(screen.getByTestId('node-group:custom:research').querySelector('.canvas-group')!, { deltaY: -180 });
    act(() => currentFlow().onMoveEnd({}, { x: 0, y: 0, zoom: 0.52 }));
    expect(screen.getByText('Subgroups · 52%')).toBeTruthy();
    expect(currentFlow().nodes.map(node => node.id)).toContain('group:custom:research/notes');
    expect(currentFlow().nodes.map(node => node.id)).toContain('group:custom:research/benchmarks');
    expect(currentFlow().edges.some(edge => edge.id === 'group-edge:custom:research/notes->custom:research/benchmarks')).toBe(true);
    fireEvent.wheel(screen.getByTestId('node-group:custom:research/notes').querySelector('.canvas-group')!, { deltaY: -180 });
    act(() => currentFlow().onMoveEnd({}, { x: 0, y: 0, zoom: 0.52 }));
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.8 }));
    act(() => currentFlow().onMoveEnd({}, { x: 0, y: 0, zoom: 0.8 }));
    expect(viewChanged).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 0.8 }, expect.any(Array),
      expect.objectContaining({ activeGroup: 'custom:research/notes' }));
    expect(currentFlow().nodes.some(node => node.id === 'research-notes')).toBe(true);
    expect(currentFlow().nodes.some(node => node.id === 'research-benchmarks')).toBe(false);
    expect(screen.getByRole('region', { name: 'Planning infinite canvas' }).querySelector('.canvas-breadcrumb')?.textContent).toContain('Notes');
    fireEvent.wheel(screen.getByTestId('flow'), { deltaY: 180 });
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.25 }));
    expect(currentFlow().nodes.some(node => node.id === 'group:custom:research/notes')).toBe(true);
    fireEvent.wheel(screen.getByTestId('flow'), { deltaY: 180 });
    act(() => currentFlow().onMoveEnd({}, { x: 0, y: 0, zoom: 0.16 }));
    expect(currentFlow().nodes.some(node => node.id === 'group:custom:research')).toBe(true);
    fireEvent.wheel(screen.getByTestId('flow'), { deltaY: 180 });
    act(() => currentFlow().onMoveEnd({}, { x: 0, y: 0, zoom: 0.16 }));
    expect(currentFlow().nodes.every(node => node.id.startsWith('group:super:'))).toBe(true);
  });

  it('highlights matching overview groups and dims groups without search matches', async () => {
    const docs = [{ ...block('a'), group: 'custom:research' }, { ...block('b'), group: 'custom:planning', x: 800 }];
    render(<Canvas canvas={canvas(docs)} searchQuery="api" searchMatchIds={['a']} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(2));
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Show group list' }));
    const board = screen.getByRole('navigation', { name: 'Group overview' });
    expect(within(board).getByRole('button', { name: /Research/ }).className).toContain('is-search-match');
    expect(within(board).getByRole('button', { name: /Planning/ }).className).toContain('is-search-dimmed');
  });

  it('shows cross-group connections on the canvas and highlights a group’s links on hover', async () => {
    const docs = [{ ...block('a', ['b']), group: 'custom:research' }, { ...block('b'), group: 'custom:planning', x: 800 }];
    render(<Canvas canvas={canvas(docs)} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.2 }));
    expect(screen.queryByRole('navigation', { name: 'Group overview' })).toBeNull();
    const connection = currentFlow().edges.find(edge => edge.id === 'group-edge:custom:research->custom:planning');
    expect(connection?.className).toBe('canvas-group-edge');
    expect(connection?.label).toBeUndefined();
    fireEvent.mouseEnter(screen.getByTestId('node-group:custom:research').querySelector('.canvas-group__heading')!);
    const focused = currentFlow().edges.find(edge => edge.id === connection?.id);
    expect(focused?.className).toContain('is-focused');
    expect(focused?.label).toBe('1 link');
    fireEvent.mouseLeave(screen.getByTestId('node-group:custom:research').querySelector('.canvas-group__heading')!);
    expect(currentFlow().edges.find(edge => edge.id === connection?.id)?.label).toBeUndefined();
  });

  it('collapses a nested group and drills into it with a breadcrumb', async () => {
    const docs = [{ ...block('a'), group: 'custom:research/benchmarks' }, { ...block('b'), group: 'custom:research/notes', x: 800 }];
    render(<Canvas canvas={canvas(docs)} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse Research' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Research' }));
    expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Expand Research' })).toBeTruthy();
    fireEvent.doubleClick(screen.getByTestId('node-group:custom:research'));
    fireEvent.doubleClick(screen.getByTestId('node-group:custom:research/benchmarks'));
    expect(screen.getByRole('region', { name: 'Planning infinite canvas' }).querySelector('.canvas-breadcrumb')?.textContent).toContain('Research');
    expect(currentFlow().nodes.some(node => node.id === 'b')).toBe(false);
    expect(currentFlow().nodes.some(node => node.id === 'a')).toBe(true);
  });

  it('opens a group document from the drill view in the inspector', async () => {
    render(<Canvas canvas={canvas([{ ...block('a'), group: 'custom:research' }, { ...block('b'), group: 'custom:research', x: 800 }])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Show group list' }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Group overview' })).getByRole('button', { name: /Research/ }));
    act(() => currentFlow().onMove({}, { x: 0, y: 0, zoom: 0.8 }));
    expect(currentFlow().nodes.some(node => node.type === 'document')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    const drill = screen.getByRole('region', { name: 'Research group documents' });
    fireEvent.click(within(drill).getByRole('button', { name: /Document a/ }));
    expect(screen.getByRole('button', { name: 'Close inspector' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Research group documents' })).toBeNull();
  });

  it('opens the document preview by default, keeps details available, and resizes the inspector', async () => {
    render(<Canvas canvas={canvas([block('a', ['b']), block('b')])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(2));
    act(() => currentFlow().onNodeClick({}, currentFlow().nodes.find(node => node.id === 'a')!));
    const inspector = screen.getByRole('complementary', { name: 'Selection inspector' });
    expect(within(inspector).getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
    expect(within(inspector).getByRole('tab', { name: 'Preview' }).textContent).toBe('');
    expect(within(inspector).getByRole('tabpanel').textContent).toContain('Preview Document a');
    fireEvent.click(within(inspector).getByRole('tab', { name: 'Details' }));
    expect(within(inspector).getByRole('tabpanel').textContent).toContain('Links out');
    expect(within(inspector).queryByRole('button', { name: 'Preview Document a' })).toBeNull();
    expect(within(inspector).getByRole('button', { name: 'Document b' })).toBeTruthy();
    fireEvent.keyDown(within(inspector).getByRole('separator', { name: 'Resize document panel' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('region', { name: 'Planning infinite canvas' }).getAttribute('style')).toContain('--canvas-inspector-width: 376px');
    act(() => currentFlow().onNodeClick({}, currentFlow().nodes.find(node => node.id === 'b')!));
    const nextInspector = screen.getByRole('complementary', { name: 'Selection inspector' });
    expect(within(nextInspector).getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
    expect(within(nextInspector).getByRole('tabpanel').textContent).toContain('Preview Document b');
  });

  it('focuses search and selected connections, then restores temporarily pulled neighbors', async () => {
    const docs = [block('a', ['b']), { ...block('b', ['c']), x: 600 }, { ...block('c'), x: 1200 }, { ...block('d'), x: 1800 }];
    render(<Canvas canvas={canvas(docs)} searchQuery="api" searchMatchIds={['b']} activeSearchId="b" onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(4));
    expect(screen.getByTestId('node-a').querySelector('.is-dimmed')).toBeTruthy();
    expect(screen.getByTestId('node-b').querySelector('.is-search-match')).toBeTruthy();
    act(() => currentFlow().onNodeClick({}, currentFlow().nodes.find(node => node.id === 'a')!));
    expect(screen.getByRole('button', { name: '+1 hop' }).getAttribute('aria-pressed')).toBe('true');
    expect(currentFlow().edges.map(edge => edge.id)).toEqual(['a->b']);
    fireEvent.click(screen.getByRole('button', { name: '+2 hops' }));
    expect(currentFlow().edges.map(edge => edge.id)).toEqual(['a->b', 'b->c']);
    fireEvent.click(screen.getByRole('button', { name: 'Pull neighbors close' }));
    expect(currentFlow().nodes.find(node => node.id === 'b')?.position.x).not.toBe(600);
    fireEvent.click(screen.getByRole('button', { name: 'Restore positions' }));
    expect(currentFlow().nodes.find(node => node.id === 'b')?.position.x).toBe(600);
  });

  it('previews a connection layout and applies it only after confirmation', async () => {
    const onMoveBlocks = vi.fn(async () => undefined);
    render(<Canvas canvas={canvas([block('a', ['b']), { ...block('b'), x: 0, y: 600 }])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()} onMoveBlocks={onMoveBlocks}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Arrange by connections' }));
    expect(onMoveBlocks).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel layout' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }));
    await waitFor(() => expect(onMoveBlocks).toHaveBeenCalledWith(expect.arrayContaining([{ blockId: 'a', x: 0, y: 0 }])));
  });

  it('uses the selection inspector for linked documents and bulk tagging', async () => {
    const onUpdateBlock = vi.fn(async () => undefined);
    const summarize = vi.fn();
    const docs = [{ ...block('a', ['b']), tags: ['shared'] }, { ...block('b'), tags: ['shared'] }, block('c')];
    render(<Canvas canvas={canvas(docs)} onUpdateBlock={onUpdateBlock} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()} onSummarizeSelection={summarize}/>);
    await waitFor(() => expect(currentFlow().nodes.filter(node => node.type === 'document')).toHaveLength(3));
    act(() => currentFlow().onSelectionChange({ nodes: currentFlow().nodes.filter(node => ['a', 'b'].includes(node.id)) }));
    const inspector = screen.getByLabelText('Selection inspector');
    expect(inspector.textContent).toContain('Combined summary');
    expect(inspector.textContent).toContain('Document a: a');
    expect(inspector.textContent).toContain('Shared tags: shared');
    expect(screen.getByRole('region', { name: 'Planning infinite canvas' }).className).toContain('canvas-surface--inspecting');
    expect(document.querySelector('.canvas-flow-stage')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'AI: summarize these' }));
    expect(summarize).toHaveBeenCalledWith(docs.slice(0, 2));
    fireEvent.change(screen.getByLabelText('Tag selected documents'), { target: { value: 'important' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    await waitFor(() => expect(onUpdateBlock).toHaveBeenCalledWith('a', { tags: ['shared', 'important'] }));
    expect(onUpdateBlock).toHaveBeenCalledWith('b', { tags: ['shared', 'important'] });
    fireEvent.change(screen.getByLabelText('Group selected documents'), { target: { value: 'Research/Benchmarks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set group' }));
    await waitFor(() => expect(onUpdateBlock).toHaveBeenCalledWith('a', { group: 'custom:research/benchmarks' }));
  });

  it('reports viewport movement and restores a bookmarked viewport', async () => {
    const changed = vi.fn();
    render(<Canvas canvas={canvas([block('a')])} onUpdateBlock={vi.fn()} onDeleteBlock={vi.fn()} onSelectBlock={vi.fn()} onViewportChange={changed} viewportRequest={{ x: 10, y: -20, zoom: 0.6, sequence: 1 }}/>);
    await waitFor(() => expect(flow.viewport).toHaveBeenCalledWith({ x: 10, y: -20, zoom: 0.6 }, { duration: 300 }));
    act(() => currentFlow().onMoveEnd({}, { x: 15, y: 20, zoom: 0.8 }));
    expect(changed).toHaveBeenCalledWith({ x: 15, y: 20, zoom: 0.8 }, expect.any(Array), expect.objectContaining({ level: 'documents' }));
  });
});
