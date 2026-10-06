// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { block, canvas, installCanvasBrowser, mount, props, run, state } from './canvas-model.test.helpers';

installCanvasBrowser();
describe('canvas focus timers with a temporarily absent renderer', () => {
  it('returns to the overview before its renderer is mounted without issuing a camera operation', async () => {
    vi.useFakeTimers();
    mount({ canvasProps: props(), view: false, action: model => model.returnOverview() });
    run();
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(state()).toMatchObject({ pinned: true, selected: [], group: '', parent: '' });
  });
  it('waits for a delayed document focus, clears its highlight on schedule, and emits selection only once for repeated focus', async () => {
    vi.useFakeTimers();
    const selected = vi.fn();
    const request = { blockId: 'later', sequence: 1 };
    let current = { ...props(canvas([])), onSelectionChange: selected, focusRequest: request };
    const ui = mount({ canvasProps: current, view: false });
    expect(state().selected).toEqual([]);
    current = { ...current, canvas: canvas([block('later', { group: 'custom:launch/notes' })]) };
    ui.change({ canvasProps: current, view: false });
    expect(state().selected).toEqual(['later']);
    expect(state().nodes[0].highlighted).toBe(true);
    expect(selected).toHaveBeenCalledWith([current.canvas.blocks[0]]);
    ui.change({ canvasProps: { ...current, canvas: { ...current.canvas, blocks: [...current.canvas.blocks] } }, view: false });
    expect(selected).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(state().nodes[0].highlighted).toBe(false);
  });
  it('allows focus and fit requests while a renderer is not yet available, and cancels replaced focus timers', async () => {
    vi.useFakeTimers();
    const current = { ...props(), focusSelect: false, focusRequest: { blockId: 'missing', sequence: 1 }, fitRequest: 1 };
    const ui = mount({ canvasProps: current, view: false });
    ui.change({ canvasProps: { ...current, focusRequest: { blockId: 'a', sequence: 2 } }, view: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(state().selected).toEqual([]);
    ui.change({ canvasProps: { ...current, focusRequest: { blockId: 'b', sequence: 3 } }, view: false });
    ui.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  });
});
