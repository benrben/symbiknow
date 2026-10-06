// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import type { CanvasBlock } from '../shared/types';
import { CanvasInspector, type CanvasInspectorProps } from './canvas-inspector';
import { InspectorResize } from './InspectorResize';

function block(id: string, patch: Partial<CanvasBlock> = {}): CanvasBlock {
  return { id, title: `Document ${id}`, file: `docs/${id}.md`, kind: 'markdown', content: `# ${id}`, x: 0, y: 0, width: 320, height: 240, links: [], ...patch };
}
function props(selected = [block('a')], overrides: Partial<CanvasInspectorProps> = {}): CanvasInspectorProps {
  return { blocks: selected, selected, canvasId: 'planning', onUpdateBlock: vi.fn(async () => {}), onReadBlock: vi.fn(), onFocusBlock: vi.fn(), onError: vi.fn(), onClose: vi.fn(), onResize: vi.fn(), ...overrides };
}
function details() { fireEvent.click(screen.getByRole('tab', { name: 'Details' })); }
function rect(width: number, height: number): DOMRect { return { width, height, x: 0, y: 0, top: 0, left: 0, bottom: height, right: width, toJSON: () => ({}) }; }
function resizeSurface(configuration: CanvasInspectorProps, surface = [1200, 800], panel = [344, 260]) {
  const view = render(<div className="canvas-surface"><CanvasInspector {...configuration}/></div>);
  const handle = screen.getByRole('separator', { name: 'Resize document panel' });
  vi.spyOn(view.container.firstElementChild!, 'getBoundingClientRect').mockReturnValue(rect(surface[0], surface[1]));
  vi.spyOn(screen.getByRole('complementary'), 'getBoundingClientRect').mockReturnValue(rect(panel[0], panel[1]));
  return handle;
}
function pointer(element: HTMLElement, type: string, pointerId: number, clientX = 0, clientY = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  fireEvent(element, event);
  return event;
}
beforeEach(() => { vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 800); vi.stubGlobal('matchMedia', undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('canvas selection inspector controls', () => {
  it('hides without a selection and opens a real document preview with accessible view controls', () => {
    const configuration = props([]);
    const view = render(<CanvasInspector {...configuration}/>);
    expect(screen.queryByRole('complementary')).toBeNull();
    const selected = [block('a', { content: '# Inspector document' })];
    view.rerender(<CanvasInspector {...configuration} selected={selected}/>);
    expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tabpanel')).getByRole('heading', { name: 'Inspector document' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open full document ↗' }));
    expect(configuration.onReadBlock).toHaveBeenCalledWith(selected[0]);
    details();
    expect(screen.getByRole('tabpanel').textContent).toContain('Ungrouped');
    expect(screen.getAllByText('None')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Open full document' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(configuration.onReadBlock).toHaveBeenCalledTimes(2);
    expect(configuration.onClose).toHaveBeenCalledOnce();
  });

  it('shows saved groups and navigates inbound and outbound links, ignoring missing documents', () => {
    const first = block('a', { links: ['b', 'missing'], group: 'work' });
    const configuration = props([first], { blocks: [first, block('b'), block('c', { links: ['a'] })] });
    render(<CanvasInspector {...configuration}/>); details();
    expect(screen.getByRole('tabpanel').textContent).toContain('Active work');
    fireEvent.click(screen.getByRole('button', { name: 'Document b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Document c' }));
    expect(configuration.onFocusBlock).toHaveBeenNthCalledWith(1, 'b');
    expect(configuration.onFocusBlock).toHaveBeenNthCalledWith(2, 'c');
  });

  it('summarizes multiple selections, shared tags, empty text, and optional AI assistance', () => {
    const selected = [block('a', { tags: ['shared', 'first'], content: '# A * useful\n > [summary]' }), block('b', { tags: ['shared'], content: ' # *_`[] > ' })];
    const summarize = vi.fn();
    const view = render(<CanvasInspector {...props(selected, { onSummarizeSelection: summarize })}/>);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('complementary').textContent).toContain('2 documents selected');
    expect(screen.getByRole('complementary').textContent).toContain('A useful summary');
    expect(screen.getByText(/No text preview/)).toBeTruthy();
    expect(screen.getByText('Shared tags: shared')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'AI: summarize these' }));
    expect(summarize).toHaveBeenCalledWith(selected);
    view.rerender(<CanvasInspector {...props([block('a'), block('b')])}/>);
    expect(screen.queryByRole('button', { name: 'AI: summarize these' })).toBeNull();
    expect(screen.getByText('Shared tags: none')).toBeTruthy();
  });

  it('ignores blank group and tag values, normalizes custom groups, and preserves explicit group keys', async () => {
    const configuration = props([block('a'), block('b')]); render(<CanvasInspector {...configuration}/>);
    for (const [field, action] of [['Group selected documents', 'Set group'], ['Tag selected documents', 'Add tag']]) {
      fireEvent.change(screen.getByLabelText(field), { target: { value: '  ' } }); fireEvent.click(screen.getByRole('button', { name: action }));
    }
    expect(configuration.onUpdateBlock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Group selected documents'), { target: { value: ' Research/Benchmarks & Notes ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set group' }));
    await waitFor(() => expect(configuration.onUpdateBlock).toHaveBeenCalledWith('a', { group: 'custom:research/benchmarks_notes' }));
    expect((screen.getByLabelText('Group selected documents') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Group selected documents'), { target: { value: 'lane:overview' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set group' }));
    await waitFor(() => expect(configuration.onUpdateBlock).toHaveBeenCalledWith('b', { group: 'lane:overview' }));
  });

  it('adds deduplicated tags to every selected document and reads persisted metadata back', async () => {
    const selected = [block('a', { tags: ['keep', 'important'] }), block('b')];
    const saved = new Map(selected.map(item => [item.id, item]));
    const configuration = props(selected, { onUpdateBlock: vi.fn(async (id, patch) => { saved.set(id, { ...saved.get(id)!, ...patch }); }) });
    const view = render(<CanvasInspector {...configuration}/>);
    fireEvent.change(screen.getByLabelText('Tag selected documents'), { target: { value: ' important ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    await waitFor(() => expect(configuration.onUpdateBlock).toHaveBeenCalledWith('b', { tags: ['important'] }));
    expect(configuration.onUpdateBlock).toHaveBeenCalledWith('a', { tags: ['keep', 'important'] });
    expect((screen.getByLabelText('Tag selected documents') as HTMLInputElement).value).toBe('');
    view.rerender(<CanvasInspector {...configuration} selected={[...saved.values()]}/>);
    expect(screen.getByText('Shared tags: important')).toBeTruthy();
  });

  it('connects to an external target and connects selections without duplicates or self-links', async () => {
    const selected = [block('a', { links: ['c', 'b'] }), block('b')];
    const configuration = props(selected, { blocks: [...selected, block('c')] });
    render(<CanvasInspector {...configuration}/>);
    expect((screen.getByRole('button', { name: 'Connect selected' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Connect selected' }));
    expect(configuration.onUpdateBlock).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'Document a' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Connection target'), { target: { value: 'c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect selected' }));
    await waitFor(() => expect(configuration.onUpdateBlock).toHaveBeenCalledWith('a', { links: ['c', 'b'] }));
    expect(configuration.onUpdateBlock).toHaveBeenCalledWith('b', { links: ['c'] });
    expect((screen.getByLabelText('Connection target') as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Connect selected together' }));
    await waitFor(() => expect(configuration.onUpdateBlock).toHaveBeenCalledWith('b', { links: ['a'] }));
    expect(configuration.onUpdateBlock).toHaveBeenCalledWith('a', { links: ['c', 'b'] });
  });

  it('avoids a self-link if an existing connection target becomes selected before applying', async () => {
    const first = block('a'); const target = block('b', { links: ['c'] });
    const configuration = props([first], { blocks: [first, target, block('c')] });
    const view = render(<CanvasInspector {...configuration}/>); details();
    fireEvent.change(screen.getByLabelText('Connection target'), { target: { value: 'b' } });
    view.rerender(<CanvasInspector {...configuration} selected={[first, target]}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Connect selected' }));
    await waitFor(() => expect(configuration.onUpdateBlock).toHaveBeenCalledWith('a', { links: ['b'] }));
    expect(configuration.onUpdateBlock).toHaveBeenCalledWith('b', { links: ['c'] });
  });

  it.each([new Error('Write conflict'), 'Disconnected'])('reports update failures and lets a subsequent action retry (%s)', async failure => {
    const update = vi.fn<CanvasInspectorProps['onUpdateBlock']>().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const configuration = props([block('a'), block('b')], { onUpdateBlock: update });
    render(<CanvasInspector {...configuration}/>);
    fireEvent.change(screen.getByLabelText('Tag selected documents'), { target: { value: 'reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    await waitFor(() => expect(configuration.onError).toHaveBeenCalledWith(failure instanceof Error ? 'Could not update selection: Write conflict' : 'Could not update selection.'));
    fireEvent.change(screen.getByLabelText('Tag selected documents'), { target: { value: 'retry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('a', { tags: ['retry'] }));
    expect(configuration.onError).toHaveBeenCalledOnce();
  });
});

describe('canvas inspector resizing', () => {
  it('resizes desktop width with pointer identity, bounds, capture, and cancellation', () => {
    const configuration = props(); const handle = resizeSurface(configuration);
    const setPointerCapture = vi.fn(); const releasePointerCapture = vi.fn();
    Object.assign(handle, { setPointerCapture, hasPointerCapture: () => true, releasePointerCapture });
    pointer(handle, 'pointermove', 4, 100); pointer(handle, 'pointerup', 4);
    expect(configuration.onResize).not.toHaveBeenCalled();
    expect(pointer(handle, 'pointerdown', 1, 500).defaultPrevented).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    pointer(handle, 'pointermove', 2, 300); pointer(handle, 'pointerup', 2);
    expect(configuration.onResize).not.toHaveBeenCalled();
    pointer(handle, 'pointermove', 1, 400);
    expect(configuration.onResize).toHaveBeenLastCalledWith('width', 444);
    pointer(handle, 'pointermove', 1, 2000); expect(configuration.onResize).toHaveBeenLastCalledWith('width', 280);
    pointer(handle, 'pointermove', 1, -2000); expect(configuration.onResize).toHaveBeenLastCalledWith('width', 940);
    pointer(handle, 'pointercancel', 1); expect(releasePointerCapture).toHaveBeenCalledWith(1);
    pointer(handle, 'pointermove', 1, 300); expect(configuration.onResize).toHaveBeenCalledTimes(3);
  });

  it('resizes mobile height with pointer fallback sizes and no capture implementation', () => {
    vi.stubGlobal('innerWidth', 600);
    const configuration = props(); const handle = resizeSurface(configuration, [600, 800], [0, 0]);
    pointer(handle, 'pointerdown', 1, 0, 500); pointer(handle, 'pointermove', 1, 0, 450);
    expect(configuration.onResize).toHaveBeenLastCalledWith('height', 310);
    pointer(handle, 'pointermove', 1, 0, 2000); expect(configuration.onResize).toHaveBeenLastCalledWith('height', 190);
    pointer(handle, 'pointermove', 1, 0, -2000); expect(configuration.onResize).toHaveBeenLastCalledWith('height', 680);
    pointer(handle, 'pointerup', 1); pointer(handle, 'pointermove', 1, 0, 300);
    expect(configuration.onResize).toHaveBeenCalledTimes(3);
  });

  it('uses mobile media queries and keyboard arrows while ignoring unrelated keys', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const configuration = props(); const handle = resizeSurface(configuration, [600, 800], [344, 300]);
    const ignored = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    fireEvent(handle, ignored); expect(ignored.defaultPrevented).toBe(false);
    fireEvent.keyDown(handle, { key: 'ArrowUp' }); expect(configuration.onResize).toHaveBeenLastCalledWith('height', 332);
    fireEvent.keyDown(handle, { key: 'ArrowDown' }); expect(configuration.onResize).toHaveBeenLastCalledWith('height', 268);
  });

  it('uses desktop keyboard arrows and viewport bounds when no surface dimensions exist', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    const configuration = props(); render(<CanvasInspector {...configuration}/>);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowUp' }); expect(configuration.onResize).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' }); expect(configuration.onResize).toHaveBeenLastCalledWith('width', 376);
    fireEvent.keyDown(handle, { key: 'ArrowRight' }); expect(configuration.onResize).toHaveBeenLastCalledWith('width', 312);
  });

  it('uses mobile viewport bounds when the containing surface has no measured height', () => {
    vi.stubGlobal('innerWidth', 600); vi.stubGlobal('innerHeight', 400);
    const configuration = props(); const handle = resizeSurface(configuration, [600, 0], [344, 0]);
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(configuration.onResize).toHaveBeenCalledWith('height', 280);
  });

  it('safely ignores pointer drag when an embedded resize control has no parent element', () => {
    const fragment = document.createDocumentFragment();
    const root = createRoot(fragment); const onResize = vi.fn();
    act(() => root.render(<InspectorResize onResize={onResize}/>));
    const handle = fragment.querySelector<HTMLDivElement>('[role="separator"]')!;
    try {
      expect(pointer(handle, 'pointerdown', 1, 500).defaultPrevented).toBe(false);
      pointer(handle, 'pointermove', 1, 400);
      expect(onResize).not.toHaveBeenCalled();
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(onResize).toHaveBeenCalledWith('width', 376);
    } finally { act(() => root.unmount()); }
  });
});
