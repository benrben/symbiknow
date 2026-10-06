// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { block, canvas, installCanvasBrowser, instance, mount, props, resize, state } from './canvas-model.test.helpers';

installCanvasBrowser();
function nativeClock() {
  const epoch = Date.now();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
}
async function tick(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(16, milliseconds - elapsed)); });
  }
}
function resizeStage(width: number) {
  resize(width);
  act(() => { window.dispatchEvent(new Event('resize')); });
}
async function focused() {
  nativeClock(); resize(352);
  const document = block('first', { x: 100, y: 100, width: 240, height: 220, content: '# First view\n- [ ] Keep selection after saving' });
  const current = props(canvas([document]));
  const view = mount({ canvasProps: current }); await tick(600);
  resizeStage(72); await tick(48);
  view.change({ canvasProps: { ...current, focusRequest: { blockId: document.id, sequence: 1 } } });
  return { document, current, view };
}
function expectCentered(document: ReturnType<typeof block>, width: number, height = 800) {
  const viewport = instance().getViewport();
  expect(viewport.x + (document.x + document.width / 2) * viewport.zoom).toBeCloseTo(width / 2, 6);
  expect(viewport.y + (document.y + document.height / 2) * viewport.zoom).toBeCloseTo(height / 2, 6);
}

it('keeps a searched document centered when closing search expands the real renderer from 72 to 352 pixels', async () => {
  const { document, current } = await focused(); await tick(600); expectCentered(document, 72);
  const before = instance().getViewport(); resizeStage(352); await tick(100);
  expectCentered(document, 352); expect(instance().getZoom()).toBe(before.zoom);
  expect(state().selected).toEqual([document.id]); expect(current.onUpdateBlock).not.toHaveBeenCalled();
});

it('keeps the focused world position through height changes and does not write source metadata', async () => {
  const { document, current } = await focused(); await tick(600);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) {
    return this.style.height.endsWith('px') ? Number.parseFloat(this.style.height) : 600;
  });
  resizeStage(352); await tick(100); expectCentered(document, 352, 600);
  expect(current.onUpdateBlock).not.toHaveBeenCalled();
});

it('keeps a newer explicit viewport above a pending focus and subsequent stage resize', async () => {
  const { document, current, view } = await focused(); await tick(100);
  const viewport = { x: 33, y: 44, zoom: .9, sequence: 1 };
  view.change({ canvasProps: { ...current, focusRequest: { blockId: document.id, sequence: 1 }, viewportRequest: viewport } });
  resizeStage(352); await tick(800);
  expect(instance().getViewport()).toEqual({ x: 33, y: 44, zoom: .9 });
});

it('does not let a departing canvas focus adjust the camera after the next canvas takes ownership', async () => {
  const { view } = await focused(); await tick(100);
  const next = props(canvas([block('next', { x: 400, y: 200 })], 'next-canvas'));
  const viewport = { x: 55, y: 66, zoom: .95, sequence: 1 };
  view.change({ canvasProps: { ...next, viewportRequest: viewport } }); resizeStage(352); await tick(800);
  expect(instance().getViewport()).toEqual({ x: 55, y: 66, zoom: .95 }); expect(state().selected).toEqual([]);
});

it('cleans up native size subscriptions and pending focus ownership when the scene unmounts', async () => {
  nativeClock(); resize(72); const published = vi.fn(); const current = { ...props(), onViewportChange: published };
  const view = mount({ canvasProps: current }); await tick(600);
  view.change({ canvasProps: { ...current, focusRequest: { blockId: 'a', sequence: 1 } } }); await tick(100);
  view.unmount(); const before = published.mock.calls.length; resizeStage(352); await tick(800);
  expect(published).toHaveBeenCalledTimes(before);
});

it('uses the final renderer dimensions when search closes during the initial animated document focus', async () => {
  const { document } = await focused(); await tick(100); resizeStage(352); await tick(600);
  expectCentered(document, 352); expect(state().selected).toEqual([document.id]);
});

it('retains a user pan and zoom across a subsequent stage expansion and accepts a fresh focus request', async () => {
  const { document, current, view } = await focused(); await tick(600);
  const manual = { x: 12, y: 34, zoom: .9 };
  act(() => { void instance().setViewport(manual, { duration: 0 }); }); await tick(48); resizeStage(352); await tick(200);
  expect(instance().getViewport()).toEqual(manual);
  view.change({ canvasProps: { ...current, focusRequest: { blockId: document.id, sequence: 2 } } }); await tick(600);
  expectCentered(document, 352);
});

it.each([true, false])('keeps a missing document focus harmless until the refreshed source becomes available (selection: %s)', async focusSelect => {
  nativeClock(); resize(352);
  const document = block('arriving', { x: 100, y: 100, width: 240, height: 220 });
  const current = { ...props(canvas([])), focusSelect, focusRequest: { blockId: document.id, sequence: 1 } };
  const view = mount({ canvasProps: current }); await tick(600);
  const before = instance().getViewport();
  expect(state().selected).toEqual([]);
  view.change({ canvasProps: { ...current, canvas: canvas([document]) } }); await tick(800);
  expect(instance().getViewport()).not.toEqual(before);
  expectCentered(document, 352);
  expect(state().selected).toEqual(focusSelect ? [document.id] : []);
});

it('waits for a temporarily collapsed native stage before consuming the initial document focus', async () => {
  nativeClock(); resize(0);
  const document = block('waiting', { x: 100, y: 100, width: 240, height: 220 });
  mount({ canvasProps: { ...props(canvas([document])), focusRequest: { blockId: document.id, sequence: 1 } } });
  await tick(100); resizeStage(352); await tick(1000);
  expectCentered(document, 352); expect(state().selected).toEqual([document.id]);
});
