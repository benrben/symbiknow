// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cameraFrames, nativeCameraClock } from './CanvasOverview.readiness.test.helpers';
import { block, canvas, installCanvasBrowser, instance, mount, props, state } from './canvas-model.test.helpers';

installCanvasBrowser();

function node(id: string) {
  const value = document.querySelector(`[data-id="${id}"]`);
  if (!value) throw new Error(`Missing native node ${id}`);
  return value as HTMLElement;
}

function minimapColors() {
  return [...document.querySelectorAll<SVGElement>('.react-flow__minimap-node')].map(value => value.style.fill);
}

describe('CanvasView public controls with its actual model and installed renderer', () => {
  it('keeps group clicks unselected and routes group/document double clicks through their real public actions', async () => {
    nativeCameraClock();
    const opened: string[] = [];
    const current = { ...props(canvas([block('a', { group: 'lane:overview' }), block('b', { group: 'lane:overview', x: 400 })])),
      onSelectBlock: (value: ReturnType<typeof block>) => { opened.push(value.id); } };
    mount({ canvasProps: current });
    await cameraFrames(1000);
    fireEvent.click(node('group:lane:overview'));
    expect(state().selected).toEqual([]);
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Overview' }));
    expect(document.querySelector('[data-id="a"]')).toBeNull();
    expect(document.querySelector('[data-id="b"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Overview' }));
    expect(node('a')).toBeTruthy();
    expect(node('b')).toBeTruthy();
    expect(instance().getNode('b')?.position).toEqual({ x: 400, y: 20 });
    fireEvent.doubleClick(node('group:lane:overview'));
    await cameraFrames(1000);
    expect(state().group).toBe('lane:overview');
    expect(opened).toEqual([]);
    fireEvent.doubleClick(node('a'));
    expect(opened).toEqual(['a']);
  });

  it('renders native minimap group tone zero and light/dark searched-document colors without changing positions', async () => {
    nativeCameraClock();
    const current = { ...props(canvas([block('a', { group: 'lane:overview' }), block('b', { group: 'lane:overview', x: 400 })])), searchMatchIds: ['a'] };
    const view = mount({ canvasProps: current });
    await cameraFrames(1000);
    expect(minimapColors()).toEqual(['rgb(56, 88, 184)', 'rgb(188, 231, 201)', 'rgb(174, 188, 240)']);
    const before = instance().getNodes().map(value => ({ id: value.id, position: value.position }));
    view.change({ canvasProps: { ...current, theme: 'dark' } });
    await cameraFrames(1000);
    expect(minimapColors()).toEqual(['rgb(175, 192, 255)', 'rgb(188, 231, 201)', 'rgb(174, 188, 240)']);
    expect(instance().getNodes().map(value => ({ id: value.id, position: value.position }))).toEqual(before);
  });

  it('resizes the actual inspector by keyboard on desktop width and mobile height', async () => {
    nativeCameraClock();
    vi.stubGlobal('matchMedia', undefined);
    vi.stubGlobal('innerWidth', 1200);
    const view = mount({ canvasProps: props() });
    await cameraFrames(1000);
    fireEvent.click(node('a'));
    const panel = screen.getByRole('complementary', { name: 'Selection inspector' });
    // JSDOM has no CSS layout; this is the measured native panel size, while
    // production resize handlers and the actual CanvasView surface stay intact.
    Object.defineProperty(panel, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 344, 260) });
    const handle = within(panel).getByRole('separator', { name: 'Resize document panel' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    const surface = screen.getByRole('region', { name: 'Canvas planning infinite canvas' });
    expect(surface.style.getPropertyValue('--canvas-inspector-width')).toBe('376px');
    vi.stubGlobal('innerWidth', 500);
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(surface.style.getPropertyValue('--canvas-inspector-height')).toBe('292px');
    expect(surface.style.getPropertyValue('--canvas-inspector-width')).toBe('376px');
    const style = surface.getAttribute('style');
    view.unmount();
    expect(handle.isConnected).toBe(false);
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 });
    expect(surface.getAttribute('style')).toBe(style);
  });

  it('closes a native keyboard multiselection once, clears all selected flags and allows a fresh selection', async () => {
    nativeCameraClock();
    const changes: string[][] = [];
    mount({ canvasProps: { ...props(), onSelectionChange: values => { changes.push(values.map(value => value.id)); } } });
    await cameraFrames(1000);
    fireEvent.keyDown(node('a'), { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(node('a'), { key: 'Enter', code: 'Enter' });
    const modifier = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';
    const held = { ctrlKey: modifier === 'Control', metaKey: modifier === 'Meta' };
    fireEvent.keyDown(window, { key: modifier, code: modifier + 'Left', ...held });
    fireEvent.keyDown(node('b'), { key: 'Enter', code: 'Enter', ...held });
    fireEvent.keyUp(node('b'), { key: 'Enter', code: 'Enter', ...held });
    fireEvent.keyUp(window, { key: modifier, code: modifier + 'Left' });
    await cameraFrames(32);
    expect(state().selected).toEqual(['a', 'b']);
    expect(screen.getByRole('complementary', { name: 'Selection inspector' }).textContent).toContain('2 documents selected');
    const before = changes.length;
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    await cameraFrames(32);
    expect(state().selected).toEqual([]);
    expect(instance().getNodes().filter(value => value.selected)).toEqual([]);
    expect(changes.slice(before)).toEqual([[]]);
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    fireEvent.click(node('b'));
    expect(state().selected).toEqual(['b']);
    expect(changes.at(-1)).toEqual(['b']);
    expect(screen.getByRole('complementary', { name: 'Selection inspector' }).textContent).toContain('Document b');
  });

  it('shows a focused document while native connection controls pull and restore positions', async () => {
    nativeCameraClock();
    const document = canvas([block('a', { links: ['b'] }), block('b', { x: 900 })]);
    mount({ canvasProps: { ...props(document), focusRequest: { blockId: 'a', sequence: 1 } } });
    await cameraFrames(1000);
    expect(screen.queryByRole('button', { name: 'Arrange by connections' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply layout' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel layout' })).toBeNull();
    expect(state().selected).toEqual(['a']);
    fireEvent.click(screen.getByRole('button', { name: '+2 hops' }));
    expect(screen.getByRole('button', { name: '+2 hops' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '+1 hop' }));
    expect(screen.getByRole('button', { name: '+1 hop' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Pull neighbors close' }));
    expect(state().pull).toBe(true);
    expect(instance().getNode('b')?.position).not.toEqual({ x: 900, y: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Restore positions' }));
    expect(instance().getNode('b')?.position).toEqual({ x: 900, y: 20 });
    expect(state().pull).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(state().selected).toEqual([]);
    expect(instance().getNodes().filter(value => value.selected)).toEqual([]);
  });

  it('opens nested groups, toggles the native file board and returns through its parent breadcrumb', async () => {
    nativeCameraClock();
    mount({ canvasProps: props(canvas([block('a', { group: 'custom:research' }), block('b', { group: 'custom:research/notes', x: 400 })])) });
    await cameraFrames(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
    await cameraFrames(1000);
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Groups · 28%');
    fireEvent.click(node('group:custom:research').querySelector('[data-canvas-group]') ?? node('group:custom:research'));
    await cameraFrames(1000);
    expect(state().parent).toBe('custom:research');
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Subgroups · 28%');
    fireEvent.click(node('group:custom:research/notes').querySelector('[data-canvas-group]') ?? node('group:custom:research/notes'));
    await cameraFrames(1000);
    expect(state().group).toBe('custom:research/notes');
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Files · 80%');
    fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    expect(screen.getByRole('region', { name: 'Notes group documents' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas' }));
    expect(screen.queryByRole('region', { name: 'Notes group documents' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    fireEvent.keyDown(node('b'), { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(node('b'), { key: 'Enter', code: 'Enter' });
    await cameraFrames(32);
    expect(state().selected).toEqual(['b']);
    expect(screen.queryByRole('region', { name: 'Notes group documents' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    const breadcrumb = document.querySelector('.canvas-breadcrumb');
    if (!breadcrumb) throw new Error('Missing native canvas breadcrumb');
    fireEvent.click(within(breadcrumb as HTMLElement).getByRole('button', { name: 'Notes' }));
    await cameraFrames(1000);
    fireEvent.click(within(breadcrumb as HTMLElement).getByRole('button', { name: 'Research' }));
    await cameraFrames(1000);
    expect(state()).toMatchObject({ parent: 'custom:research', group: '' });
    expect(instance().getViewport()).toEqual({ x: 24, y: 68, zoom: .28 });
  });

  it('distinguishes title zoom and ungrouped file navigation using normal owner requests', async () => {
    nativeCameraClock();
    const current = props();
    const view = mount({ canvasProps: { ...current, viewportRequest: { x: 0, y: 0, zoom: .6, sequence: 1 } } });
    await cameraFrames(1000);
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Titles · 60%');
    view.change({ canvasProps: { ...current, groupFocusRequest: { canvasId: current.canvas.id, group: '__ungrouped', sequence: 1 } } });
    await cameraFrames(1000);
    expect(state().group).toBe('__ungrouped');
    expect(document.querySelector('.canvas-breadcrumb')?.textContent).toContain('Ungrouped');
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Files · 80%');
  });

  it('opens a native supergroup and returns through the supergroup breadcrumb without selecting documents', async () => {
    nativeCameraClock();
    mount({ canvasProps: props(canvas('abcdefghij'.split('').map((id, index) => block(id, { group: 'custom:' + id, x: index * 400 })))) });
    await cameraFrames(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
    await cameraFrames(1000);
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Supergroups · 28%');
    const group = document.querySelector('.canvas-group.is-super');
    if (!group) throw new Error('Missing actual native supergroup');
    fireEvent.click(group);
    await cameraFrames(1000);
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Groups · 28%');
    fireEvent.click(screen.getByRole('button', { name: /^Supergroup:/ }));
    await cameraFrames(1000);
    expect(state()).toMatchObject({ selected: [], parent: '', group: '' });
    expect(instance().getViewport()).toEqual({ x: 24, y: 68, zoom: .28 });
  });

  it('routes native zoom controls and group/pane wheel targets through the actual camera', async () => {
    nativeCameraClock();
    mount({ canvasProps: props(canvas([block('a', { group: 'lane:overview' }), block('b', { group: 'lane:overview', x: 400 })])) });
    await cameraFrames(1000);
    const zoomIn = screen.getByRole('button', { name: 'Zoom In' });
    fireEvent.click(zoomIn.querySelector('svg') ?? zoomIn);
    await cameraFrames(1000);
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Files · 120%');
    const zoomOut = screen.getByRole('button', { name: 'Zoom Out' });
    fireEvent.click(zoomOut.querySelector('svg') ?? zoomOut);
    await cameraFrames(1000);
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Files · 100%');
    const group = node('group:lane:overview').querySelector('[data-canvas-group]');
    if (!group) throw new Error('Missing actual native wheel group');
    fireEvent.wheel(group, { deltaY: 100, clientX: 500, clientY: 300 });
    await cameraFrames(1000);
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Files · 87%');
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) throw new Error('Missing actual native wheel pane');
    fireEvent.wheel(pane, { deltaY: -100, clientX: 500, clientY: 300 });
    await cameraFrames(1000);
    expect(document.querySelector('.canvas-zoom-label')?.textContent).toBe('Files · 100%');
  });

  it('keeps a closed focus-based inspector closed when the native owner supplies refreshed document props', async () => {
    nativeCameraClock();
    const current = { ...props(), focusRequest: { blockId: 'a', sequence: 1 }, viewportRequest: { x: 33, y: 44, zoom: .9, sequence: 1 } };
    const view = mount({ canvasProps: current });
    await cameraFrames(1000);
    expect(state().selected).toEqual(['a']);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(state().selected).toEqual([]);
    expect(instance().getNodes().filter(value => value.selected)).toEqual([]);
    view.change({ canvasProps: { ...current, canvas: { ...current.canvas,
      blocks: current.canvas.blocks.map(value => ({ ...value, title: value.title + ' refreshed' })) } } });
    await cameraFrames(1000);
    expect(state().selected).toEqual([]);
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    expect(instance().getViewport()).toEqual({ x: 33, y: 44, zoom: .9 });
  });

  it.each([true, false])('keeps a newer manual selection during refresh but accepts a newer co-batched request (focusSelect: %s)', async focusSelect => {
    nativeCameraClock();
    const current = { ...props(), focusSelect, focusRequest: { blockId: 'a', sequence: 1 }, viewportRequest: { x: 33, y: 44, zoom: .9, sequence: 1 } };
    const view = mount({ canvasProps: current });
    await cameraFrames(1000);
    expect(state().selected).toEqual(focusSelect ? ['a'] : []);
    if (focusSelect) fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    fireEvent.click(node('b'));
    await cameraFrames(1000);
    expect(state().selected).toEqual(['b']);
    const refreshed = { ...current, canvas: { ...current.canvas, blocks: current.canvas.blocks.map(value => ({ ...value, title: value.title + ' refreshed' })) } };
    view.change({ canvasProps: refreshed });
    await cameraFrames(1000);
    expect(state().selected).toEqual(['b']);
    expect(instance().getNodes().filter(value => value.selected).map(value => value.id)).toEqual(['b']);
    view.change({ canvasProps: { ...refreshed, focusRequest: { blockId: 'a', sequence: 2 }, viewportRequest: { x: 81, y: 92, zoom: .7, sequence: 2 } } });
    await cameraFrames(1000);
    expect(state().selected).toEqual(focusSelect ? ['a'] : []);
    expect(instance().getViewport()).toEqual({ x: 81, y: 92, zoom: .7 });
  });

  it('waits for a requested native document to arrive, consumes it once and accepts the next request after removal and return', async () => {
    nativeCameraClock();
    const current = { ...props(canvas([])), focusRequest: { blockId: 'later', sequence: 7 } };
    const view = mount({ canvasProps: current });
    await cameraFrames(1000);
    expect(state().selected).toEqual([]);
    const arrived = { ...current, canvas: canvas([block('later')]) };
    view.change({ canvasProps: arrived });
    await cameraFrames(1000);
    expect(state().selected).toEqual(['later']);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    view.change({ canvasProps: current });
    await cameraFrames(1000);
    view.change({ canvasProps: arrived });
    await cameraFrames(1000);
    expect(state().selected).toEqual([]);
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    view.change({ canvasProps: { ...arrived, focusRequest: { blockId: 'later', sequence: 8 } } });
    await cameraFrames(1000);
    expect(state().selected).toEqual(['later']);
  });

  it('allows a supported selection-mode change and a new canvas binding to consume an existing focus sequence', async () => {
    nativeCameraClock();
    const current = { ...props(), focusSelect: false, focusRequest: { blockId: 'a', sequence: 1 } };
    const view = mount({ canvasProps: current });
    await cameraFrames(1000);
    expect(state().selected).toEqual([]);
    view.change({ canvasProps: { ...current, focusSelect: true } });
    await cameraFrames(1000);
    expect(state().selected).toEqual(['a']);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    view.change({ canvasProps: { ...current, canvas: canvas([block('destination')], 'destination'), focusSelect: true } });
    await cameraFrames(1000);
    expect(state().selected).toEqual([]);
    view.change({ canvasProps: { ...current, focusSelect: true } });
    await cameraFrames(1000);
    expect(state().selected).toEqual(['a']);
    view.change({ canvasProps: current });
    await cameraFrames(1000);
    expect(state().selected).toEqual([]);
    expect(instance().getNodes().filter(value => value.selected)).toEqual([]);
  });
});
