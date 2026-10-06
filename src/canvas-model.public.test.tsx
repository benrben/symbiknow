// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { block, camera, canvas, installCanvasBrowser, instance, mount, props, resize, run, state } from './canvas-model.test.helpers';

installCanvasBrowser();

describe('canvas model public focus and layout boundaries', () => {
  it('keeps fixed-size native measurements stable while applying real resizes and resize completion', async () => {
    const current = props();
    let measuredNodes: unknown;
    const ui = mount({ canvasProps: current, action: model => {
      measuredNodes = model.nodes;
      model.changeNodes(['a', 'b'].map(id => ({ type: 'dimensions', id, dimensions: { width: 320, height: 240 } })));
    } });
    await camera({ x: 0, y: 0, zoom: 1 });
    run();
    let unchangedNodes: unknown;
    ui.change({ canvasProps: current, action: model => { unchangedNodes = model.nodes; } });
    run();
    expect(unchangedNodes).toBe(measuredNodes);
    ui.change({ canvasProps: current, action: model => model.changeNodes([
      { type: 'dimensions', id: 'a', dimensions: { width: 480, height: 330 }, setAttributes: true, resizing: true },
    ]) });
    run();
    let resizedNode: unknown;
    ui.change({ canvasProps: current, action: model => { resizedNode = model.nodes.find(node => node.id === 'a'); } });
    run();
    expect(resizedNode).toMatchObject({ width: 480, height: 330, resizing: true });
    ui.change({ canvasProps: current, action: model => model.changeNodes([{ type: 'dimensions', id: 'a', dimensions: { width: 480, height: 330 }, resizing: false }]) });
    run();
    ui.change({ canvasProps: current, action: model => { resizedNode = model.nodes.find(node => node.id === 'a'); } });
    run();
    expect(resizedNode).toMatchObject({ resizing: false });
  });
  it('updates native overview columns at 900 and 520 pixels, keeping an unchanged resize stable', async () => {
    const document = canvas(['a', 'b', 'c'].map(id => block(id, { group: 'custom:' + id })));
    mount({ canvasProps: props(document) });
    fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
    await waitFor(() => expect(state().nodes[2].position).toEqual({ x: 2200, y: 0 }));
    resize(899);
    expect(state().nodes[2].position).toEqual({ x: 0, y: 740 });
    resize(520);
    expect(state().nodes[2].position).toEqual({ x: 0, y: 740 });
    resize(519);
    expect(state().nodes[1].position).toEqual({ x: 0, y: 740 });
    resize(900);
    expect(state().nodes[2].position).toEqual({ x: 2200, y: 0 });
    const before = state();
    resize(900);
    expect(state()).toEqual(before);
  });
  it('supports a temporarily absent surface and a browser without ResizeObserver before its renderer mounts', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const ui = mount({ canvasProps: props(), view: 'surface' });
    expect(screen.getByRole('region', { name: 'Pending canvas renderer' })).toBeTruthy();
    expect(state().nodes.filter(node => node.id === 'a')).toHaveLength(1);
    ui.unmount();
    mount({ canvasProps: props(), view: false });
    expect(state().selected).toEqual([]);
  });
  it('retains group focus before the canvas surface attaches and applies its reading camera when the renderer mounts', async () => {
    const current = props(canvas([block('a', { group: 'custom:delivery' }),
      block('b', { group: 'custom:delivery', x: 5000, y: 5000 }), block('other', { group: 'custom:other', x: 9000 })]));
    const ui = mount({ canvasProps: current, view: false, action: model => model.selectNodes({ nodes: model.flowNodes.filter(node => node.id === 'a') }) });
    run();
    expect(state().selected).toEqual(['a']);
    ui.change({ canvasProps: current, view: false, action: model => model.focusGroup('custom:delivery') });
    run();
    expect(state()).toMatchObject({ group: 'custom:delivery', pinned: false, selected: [] });
    let requested: { x: number; y: number; zoom: number; sequence: number } | undefined;
    ui.change({ canvasProps: current, view: false, action: model => { requested = model.pointRequest; } });
    run();
    expect(requested).toEqual({ x: 354, y: 140, zoom: .8, sequence: 2 });

    ui.change({ canvasProps: current });
    await waitFor(() => {
      const viewport = instance().getViewport();
      expect(viewport.zoom).toBeCloseTo(.8, 7);
      expect(viewport.x).toBeCloseTo(500 - 354 * .8, 5);
      expect(viewport.y).toBeCloseTo(400 - 140 * .8, 5);
    });
    expect(state()).toMatchObject({ group: 'custom:delivery', selected: [] });
    expect(current.onUpdateBlock).not.toHaveBeenCalled();
    expect(current.canvas.blocks.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: 'a', x: 10, y: 20 }, { id: 'b', x: 5000, y: 5000 }, { id: 'other', x: 9000, y: 20 },
    ]);
  });
  it('opens direct files from a nested hierarchy and accepts delayed, mismatched, stale and repeated group requests', async () => {
    const document = canvas([block('a', { group: 'custom:launch' }), block('b', { group: 'custom:launch/notes' })]);
    const current = props(document);
    const ui = mount({ canvasProps: current });
    fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
    ui.change({ canvasProps: current, action: model => model.openHierarchyGroup('custom:launch') });
    run();
    expect(state()).toMatchObject({ parent: 'custom:launch', group: '' });
    ui.change({ canvasProps: current, action: model => model.openHierarchyGroup('files:custom:launch') });
    run();
    await waitFor(() => expect(instance().getZoom()).toBe(.8));
    expect(state()).toMatchObject({ group: 'custom:launch', selected: [] });
    ui.change({ canvasProps: { ...current, groupFocusRequest: { canvasId: 'other', group: 'custom:launch/notes', sequence: 1 } } });
    expect(state().group).toBe('custom:launch');
    ui.change({ canvasProps: { ...current, groupFocusRequest: { canvasId: document.id, group: 'custom:missing', sequence: 1 } } });
    expect(state().group).toBe('custom:launch');
    const request = { canvasId: document.id, group: 'custom:launch/notes', sequence: 1 };
    ui.change({ canvasProps: { ...current, groupFocusRequest: request } });
    await waitFor(() => expect(state().group).toBe(request.group));
    ui.change({ canvasProps: { ...current, groupFocusRequest: request }, action: model => model.returnOverview() });
    run();
    ui.change({ canvasProps: { ...current, groupFocusRequest: { ...request } } });
    expect(state().group).toBe('');
  });
  it('keeps missing group focus harmless, handles Ungrouped requests, and ignores an obsolete file group after supergroups exist', async () => {
    const current = props();
    const ui = mount({ canvasProps: current, action: model => model.focusGroup('custom:missing') });
    run();
    expect(state().group).toBe('custom:missing');
    ui.change({ canvasProps: { ...current, groupFocusRequest: { canvasId: current.canvas.id, group: '__ungrouped', sequence: 1 } } });
    await waitFor(() => expect(state().group).toBe('__ungrouped'));
    const document = canvas('abcdefghi'.split('').map(id => block(id, { group: 'custom:' + id })), 'large');
    ui.change({ canvasProps: props(document), action: model => model.openHierarchyGroup('custom:removed') });
    run();
    expect(state().group).toBe('custom:removed');
  });
  it('focuses a document without selecting it, honors a smaller zoom, and does not reapply the same request after refreshed props', async () => {
    const selected = vi.fn();
    const current = { ...props(), focusSelect: false, focusZoom: .6, onSelectionChange: selected };
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    const focused = { ...current, focusRequest: { blockId: 'a', sequence: 1 } };
    ui.change({ canvasProps: focused });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 398, y: 316, zoom: .6 }));
    expect(state().selected).toEqual([]);
    expect(selected).not.toHaveBeenCalled();
    await camera({ x: 20, y: 30, zoom: .7 });
    ui.change({ canvasProps: { ...focused, canvas: { ...current.canvas, blocks: [...current.canvas.blocks] } } });
    expect(instance().getViewport()).toEqual({ x: 20, y: 30, zoom: .7 });
  });
  it('fits a large focused document to the real stage and uses the default zoom cap', async () => {
    const current = { ...props(canvas([block('large', { width: 2000, height: 1600 })])), focusSelect: false };
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 96, y: 68, zoom: .4 }));
    ui.change({ canvasProps: { ...current, focusRequest: { blockId: 'large', sequence: 1 } } });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 10.150000000000034, y: 2.3000000000000114, zoom: .485 }));
    expect(state().selected).toEqual([]);
  });
  it('applies the public fit request to the actual renderer at its intended maximum zoom', async () => {
    const current = props();
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    ui.change({ canvasProps: { ...current, fitRequest: 1 } });
    await waitFor(() => expect(instance().getZoom()).toBe(.75));
  });
  it('uses the default focus fit when a supported embedded renderer has no canvas measuring stage', async () => {
    const current = { ...props(), focusSelect: false };
    const ui = mount({ canvasProps: current, view: 'native' });
    await camera({ x: 15, y: 25, zoom: .5 });
    ui.change({ canvasProps: { ...current, focusRequest: { blockId: 'a', sequence: 1 } }, view: 'native' });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    expect(state().selected).toEqual([]);
  });
  it('lets an explicit destination bookmark replace the prior canvas camera and zoom', async () => {
    const current = props();
    const ui = mount({ canvasProps: current });
    await camera({ x: 14, y: 22, zoom: .62 });
    const destination = canvas([block('destination', { x: 1200, y: 900 })], 'destination');
    const target = { x: 80, y: 100, zoom: .85 };
    ui.change({ canvasProps: { ...current, canvas: destination, viewportRequest: { ...target, sequence: 1 } } });
    await waitFor(() => expect(instance().getViewport()).toEqual(target));
    await waitFor(() => expect(state().zoom).toBe(.85));
    expect(state().nodes.some(node => node.id === 'destination')).toBe(true);
  });
  it('lets Browse groups own the native viewport after a document selection has queued its focus animation', async () => {
    const changed = vi.fn();
    const current = { ...props(), onViewportChange: changed };
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    const node = document.querySelector<HTMLElement>('.react-flow__node-document[data-id="a"]');
    if (!node) throw new Error('Missing rendered document');
    fireEvent.click(node);
    expect(state().selected).toEqual(['a']);
    const target = { x: 24, y: 68, zoom: .28 };
    ui.change({ canvasProps: { ...current, viewportRequest: { ...target, sequence: 1 } } });
    await waitFor(() => expect(instance().getViewport()).toEqual(target));
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(target, expect.any(Array), expect.any(Object)));
  });
  it('applies Browse groups after a native fit animation was interrupted by document selection', async () => {
    const changed = vi.fn();
    const current = { ...props(), onViewportChange: changed };
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    await act(async () => { void instance().fitView({ maxZoom: .75, duration: 350 }); });
    await waitFor(() => expect(screen.getByLabelText('Native fit readiness').textContent).toContain('"fitting":true'));
    changed.mockClear();
    const node = document.querySelector<HTMLElement>('.react-flow__node-document[data-id="a"]');
    if (!node) throw new Error('Missing rendered document');
    fireEvent.click(node);
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ x: 330, y: 260, zoom: 1 }, expect.any(Array), expect.any(Object)));
    expect(screen.getByLabelText('Native fit readiness').textContent).toContain('"queued":false,"fitting":true');
    const target = { x: 24, y: 68, zoom: .28 };
    ui.change({ canvasProps: { ...current, viewportRequest: { ...target, sequence: 1 } } });
    await waitFor(() => expect(instance().getViewport()).toEqual(target));
  });
  it('applies a newer overview request after the native fit control queues a fit in the group overview', async () => {
    const current = props();
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 24, y: 68, zoom: .28 }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit View' }));
    await waitFor(() => expect(screen.getByLabelText('Native fit readiness').textContent).toContain('"queued":true'));
    const target = { x: 80, y: 100, zoom: .28 };
    ui.change({ canvasProps: { ...current, viewportRequest: { ...target, sequence: 1 } } });
    await waitFor(() => expect(instance().getViewport()).toEqual(target));
  });
  it('finishes at the newest requested viewport after an earlier native Fit View is queued', async () => {
    const changed = vi.fn();
    const current = { ...props(), onViewportChange: changed };
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    await act(async () => { void instance().fitView({ maxZoom: .75, duration: 350 }); });
    await waitFor(() => expect(screen.getByLabelText('Native fit readiness').textContent).toContain('"fitting":true'));
    changed.mockClear();
    const target = { x: 24, y: 68, zoom: .28 };
    ui.change({ canvasProps: { ...current, viewportRequest: { ...target, sequence: 1 } } });
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(target, expect.any(Array), expect.any(Object)));
    expect(instance().getViewport()).toEqual(target);
  });
  it.each([true, false])('supersedes older document focus work and still permits newer focus (focusSelect: %s)', async focusSelect => {
    const current = { ...props(), focusSelect };
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    const previousFocus = { blockId: 'b', sequence: 1 };
    ui.change({ canvasProps: { ...current, focusRequest: previousFocus } });
    const target = { x: 24, y: 68, zoom: .28 };
    const overview = { ...current, focusRequest: previousFocus, viewportRequest: { ...target, sequence: 1 } };
    ui.change({ canvasProps: overview });
    await waitFor(() => expect(instance().getViewport()).toEqual(target));
    ui.change({ canvasProps: { ...overview, focusRequest: { blockId: 'b', sequence: 2 } } });
    await waitFor(() => expect(instance().getViewport()).toEqual(focusSelect ? { x: 24, y: 281, zoom: .85 } : { x: -60, y: 260, zoom: 1 }));
    expect(state().selected).toEqual(focusSelect ? ['b'] : []);
    ui.change({ canvasProps: { ...current, focusRequest: { blockId: 'a', sequence: 3 } } });
    await waitFor(() => expect(instance().getViewport()).toEqual(focusSelect ? { x: 355.5, y: 281, zoom: .85 } : { x: 330, y: 260, zoom: 1 }));
  });
  it('permits a newer native Fit View without replaying an earlier overview request', async () => {
    const current = props();
    const ui = mount({ canvasProps: current });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    const target = { x: 24, y: 68, zoom: .28 };
    ui.change({ canvasProps: { ...current, viewportRequest: { ...target, sequence: 1 } } });
    await waitFor(() => expect(instance().getViewport()).toEqual(target));
    fireEvent.click(screen.getByRole('button', { name: 'Fit View' }));
    const fitted = { x: 90, y: 125, zoom: 1 };
    await waitFor(() => expect(instance().getViewport()).toEqual(fitted));
    ui.change({ canvasProps: { ...current, canvas: { ...current.canvas, blocks: [...current.canvas.blocks] },
      viewportRequest: { ...target, sequence: 1 } } });
    expect(instance().getViewport()).toEqual(fitted);
  });
});

describe('canvas model integration actions through the installed view', () => {
  it('reports an active document callback failure and rejects invalid document connections before writing', () => {
    const current = props();
    const ui = mount({ canvasProps: current, action: model => model.nodes[0].data.onError('Embedded document failed') });
    run();
    expect(screen.getByRole('alert').textContent).toContain('Embedded document failed');
    ui.change({ canvasProps: current, action: model => model.connect({ source: 'a', target: 'a', sourceHandle: null, targetHandle: null }) });
    run();
    ui.change({ canvasProps: current, action: model => model.connect({ source: 'removed', target: 'b', sourceHandle: null, targetHandle: null }) });
    run();
    expect(current.onUpdateBlock).not.toHaveBeenCalled();
  });
  it.each([new Error('Document write failed'), 'unexpected'])('contains failed resize, drop, connection and link removal writes (%s)', async reason => {
    const update = vi.fn(async (): Promise<void> => { throw reason; });
    const current = { ...props(), onUpdateBlock: update };
    const ui = mount({ canvasProps: current, action: model => model.nodes[0].data.onResize('a', { width: 500, height: 300 }) });
    run();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(reason instanceof Error ? 'Could not save: Document write failed' : 'Could not save this change.'));
    expect(update).toHaveBeenLastCalledWith('a', { width: 500, height: 300 });
    ui.change({ canvasProps: current, action: model => model.dropBlock({ ...model.nodes[0], position: { x: 80, y: 90 } }) });
    run();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    ui.change({ canvasProps: current, action: model => model.connect({ source: 'a', target: 'b', sourceHandle: null, targetHandle: null }) });
    run();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(3));
    ui.change({ canvasProps: current, action: model => model.deleteEdges([{ id: 'a->b', source: 'a', target: 'b' }]) });
    run();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(4));
    expect(screen.getByRole('alert').textContent).toContain(reason instanceof Error ? 'Could not save: Document write failed' : 'Could not save this change.');
    expect(state().nodes.find(node => node.id === 'a')?.position).toEqual({ x: 10, y: 20 });
  });
  it('permits empty native deletion, blocks deleting a group frame, and reports an untyped document deletion rejection', async () => {
    const deleted = vi.fn(async (): Promise<void> => { throw 'unexpected'; });
    const current = { ...props(), onDeleteBlock: deleted };
    let result: boolean | undefined;
    const ui = mount({ canvasProps: current, action: async model => { result = await model.beforeDelete({ nodes: [], edges: [] }); } });
    run();
    await waitFor(() => expect(result).toBe(true));
    ui.change({
      canvasProps: current, action: async model => {
        const frames = model.flowNodes.filter(node => node.type !== 'document');
        expect(frames).not.toHaveLength(0);
        result = await model.beforeDelete({ nodes: frames, edges: [] });
      }
    });
    run();
    await waitFor(() => expect(result).toBe(false));
    expect(deleted).not.toHaveBeenCalled();
    ui.change({ canvasProps: current, action: async model => { result = await model.beforeDelete({ nodes: model.nodes.slice(0, 1), edges: [] }); } });
    run();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not delete this document.'));
    expect(result).toBe(false);
    expect(deleted).toHaveBeenCalledWith('a');
    expect(state().nodes.some(node => node.id === 'a')).toBe(true);
  });
  it('uses the latest read, history, open, portal callbacks and permits omitted optional callbacks', () => {
    const current = props();
    const opened = vi.fn(), read = vi.fn(), history = vi.fn(), portal = vi.fn();
    function actions(model: ReturnType<typeof import('./canvas-model').useCanvasModel>) {
      const value = model.nodes[0].data;
      value.onOpenBlock(current.canvas.blocks[0]);
      value.onReadBlock(current.canvas.blocks[0]);
      value.onHistoryBlock(current.canvas.blocks[0]);
      value.onOpenCrossLink('other', 'target');
    }
    const ui = mount({ canvasProps: current, action: actions });
    run();
    expect(current.onSelectBlock).toHaveBeenCalledTimes(3);
    ui.change({ canvasProps: { ...current, onSelectBlock: opened, onReadBlock: read, onHistoryBlock: history, onOpenCrossLink: portal }, action: actions });
    run();
    expect(opened).toHaveBeenCalledWith(current.canvas.blocks[0]);
    expect(read).toHaveBeenCalledWith(current.canvas.blocks[0]);
    expect(history).toHaveBeenCalledWith(current.canvas.blocks[0]);
    expect(portal).toHaveBeenCalledWith('other', 'target');
  });
  it('ignores stale and repeated selection, publishes multiple/empty selections, and makes pulling require one selected document', () => {
    const changed = vi.fn();
    const current = { ...props(), onSelectionChange: changed };
    const ui = mount({ canvasProps: current, action: model => model.selectBlock('missing') });
    run();
    expect(changed).not.toHaveBeenCalled();
    ui.change({ canvasProps: current, action: model => model.pullRelated() });
    run();
    expect(state().pull).toBe(false);
    ui.change({ canvasProps: current, action: model => model.selectBlock('a') });
    run();
    run();
    expect(changed).toHaveBeenCalledTimes(1);
    ui.change({ canvasProps: current, action: model => model.pullRelated() });
    run();
    expect(state().pull).toBe(true);
    ui.change({ canvasProps: current, action: model => model.restoreLayout() });
    run();
    expect(state().pull).toBe(false);
    ui.change({ canvasProps: current, action: model => model.selectNodes({ nodes: model.flowNodes }) });
    run();
    expect(state().selected).toEqual(['a', 'b']);
    expect(changed).toHaveBeenLastCalledWith(current.canvas.blocks);
    ui.change({ canvasProps: current, action: model => model.pullRelated() });
    run();
    expect(state().pull).toBe(false);
    ui.change({ canvasProps: current, action: model => model.selectNodes({ nodes: [] }) });
    run();
    expect(state().selected).toEqual([]);
  });
  it('receives a newly selected document from the native public API and centers it at the selection minimum zoom', async () => {
    const changed = vi.fn();
    mount({ canvasProps: { ...props(), onSelectionChange: changed } });
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 330, y: 260, zoom: 1 }));
    await camera({ x: 0, y: 0, zoom: .6 });
    await act(async () => { instance().setNodes(nodes => nodes.map(node => ({ ...node, selected: node.id === 'a' }))); });
    await waitFor(() => expect(state().selected).toEqual(['a']));
    expect(changed).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a' })]);
    await waitFor(() => expect(instance().getViewport()).toEqual({ x: 355.5, y: 281, zoom: .85 }));
  });
  it('rejects a stale group drag and tolerates no document changes', () => {
    const current = props();
    const ui = mount({ canvasProps: current, action: model => model.saveGroupMove('group:removed') });
    run();
    expect(current.onUpdateBlock).not.toHaveBeenCalled();
    ui.change({ canvasProps: current, action: model => model.changeNodes([]) });
    run();
  });
  it('saves only remaining rendered group members, and skips a group whose cards are temporarily detached via the native public API', async () => {
    const update = vi.fn(async () => undefined);
    const current = { ...props(), onUpdateBlock: update };
    const ui = mount({ canvasProps: current, action: model => model.saveGroupMove('group:__ungrouped') });
    await camera({ x: 0, y: 0, zoom: 1 });
    await act(async () => { instance().setNodes(nodes => nodes.filter(node => node.id !== 'a')); });
    run();
    await waitFor(() => expect(update).toHaveBeenCalledWith('b', { x: 400, y: 20 }));
    expect(update).not.toHaveBeenCalledWith('a', expect.any(Object));
    update.mockClear();
    await act(async () => { instance().setNodes(nodes => nodes.filter(node => node.type !== 'document')); });
    run();
    expect(update).not.toHaveBeenCalled();
    expect(state().nodes.some(node => node.id === 'group:__ungrouped')).toBe(true);
    ui.unmount();
  });
  it.each([new Error('Group save failed'), 'unexpected'])('reports and recovers from group fallback writes (%s)', async reason => {
    const update = vi.fn(async (): Promise<void> => { throw reason; });
    const current = { ...props(), onUpdateBlock: update };
    const ui = mount({ canvasProps: current, action: model => model.saveGroupMove('group:__ungrouped') });
    run();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(reason instanceof Error ? 'Could not move group: Group save failed' : 'Could not move this group.'));
    update.mockImplementation(async () => undefined);
    run();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(update).toHaveBeenCalledWith('a', { x: 10, y: 20 });
    ui.unmount();
  });
});
