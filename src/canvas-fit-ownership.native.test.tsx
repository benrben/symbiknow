// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { block, canvas, installCanvasBrowser, instance, mount, props } from './canvas-model.test.helpers';

installCanvasBrowser();
afterEach(() => { vi.useRealTimers(); });
async function tick(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(16, milliseconds - elapsed)); });
  }
}
function nativeClock() {
  const epoch = Date.now();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
}
function measuredResearchBrowser() {
  const Observer = ResizeObserver;
  vi.stubGlobal('ResizeObserver', class extends Observer {
    constructor(callback: ResizeObserverCallback) {
      const pending: ResizeObserverEntry[] = [];
      let scheduled = false;
      super((entries, observer) => {
        pending.push(...entries);
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          const changed = pending.splice(0).filter(entry => entry.target.isConnected);
          if (changed.length) callback(changed, observer);
        });
      });
    }
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.style.width.endsWith('px') ? Number.parseFloat(this.style.width) : 696; });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.style.height.endsWith('px') ? Number.parseFloat(this.style.height) : 574; });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const element = this as HTMLElement;
    return new DOMRect(0, 0, element.style?.width.endsWith('px') ? Number.parseFloat(element.style.width) : 696, element.style?.height.endsWith('px') ? Number.parseFloat(element.style.height) : 574);
  });
}
describe('native delayed fit camera ownership', () => {
  it('cancels a blocked research focus for a newer viewport and on unmount', async () => {
    nativeClock(); measuredResearchBrowser();
    const documents = Array.from({ length: 6 }, (_, index) => block(`research-${index}`, {
      x: index % 2 * 520, y: Math.floor(index / 2) * 390, width: 400, height: 290,
    }));
    const published = vi.fn();
    const initial = { ...props(canvas(documents)), focusSelect: false, focusZoom: 1, onViewportChange: published };
    const view = mount({ canvasProps: initial });
    await tick(1000);
    const focusRequest = { blockId: documents[0].id, sequence: 1 };
    view.change({ canvasProps: { ...initial, focusRequest } });
    await tick(176);
    act(() => {
      void instance().fitView({ padding: .16, maxZoom: .75, duration: 350 });
      vi.advanceTimersByTime(4);
    });
    const viewportRequest = { x: 33, y: 44, zoom: .9, sequence: 1 };
    view.change({ canvasProps: { ...initial, focusRequest, viewportRequest } });
    await tick(1000);
    expect(instance().getViewport()).toEqual({ x: 33, y: 44, zoom: .9 });
    view.change({ canvasProps: { ...initial, viewportRequest, focusRequest: { ...focusRequest, sequence: 2 } } });
    await tick(176);
    act(() => {
      void instance().fitView({ padding: .16, maxZoom: .75, duration: 350 });
      vi.advanceTimersByTime(4);
    });
    view.unmount();
    const before = published.mock.calls.length;
    await tick(1000);
    expect(published).toHaveBeenCalledTimes(before);
    expect(screen.queryByRole('region', { name: 'Canvas planning infinite canvas' })).toBeNull();
  });
  it('does not replay a replaced source under a reused focus sequence and accepts the next request', async () => {
    nativeClock(); measuredResearchBrowser();
    const documents = Array.from({ length: 6 }, (_, index) => block(`research-${index}`, {
      x: index % 2 * 520, y: Math.floor(index / 2) * 390, width: 400, height: 290,
    }));
    const initial = { ...props(canvas(documents)), focusSelect: false, focusZoom: 1 };
    const view = mount({ canvasProps: initial });
    await tick(1000);
    const before = instance().getViewport();
    view.change({ canvasProps: { ...initial, focusRequest: { blockId: documents[0].id, sequence: 1 } } });
    await tick(96);
    view.change({ canvasProps: { ...initial, focusRequest: { blockId: documents[1].id, sequence: 1 } } });
    await tick(1000);
    expect(instance().getViewport()).toEqual(before);
    view.change({ canvasProps: { ...initial, focusRequest: { blockId: documents[1].id, sequence: 2 } } });
    await tick(1000);
    expect(instance().getViewport()).toEqual({ x: -372, y: 142, zoom: 1 });
  });
  it('preserves requested fit options through a normal canvas theme render', async () => {
    nativeClock(); measuredResearchBrowser();
    const documents = Array.from({ length: 6 }, (_, index) => block(`research-${index}`, {
      x: index % 2 * 520, y: Math.floor(index / 2) * 390, width: 400, height: 290,
    }));
    const initial = { ...props(canvas(documents)), focusSelect: false, focusZoom: 1 };
    const view = mount({ canvasProps: initial });
    await tick(1000);
    expect(instance().getZoom()).toBeLessThan(.75);
    act(() => { void instance().fitView({ padding: .16, maxZoom: .4, duration: 350 }); });
    view.change({ canvasProps: { ...initial, theme: 'dark' } });
    await tick(1000);
    expect(instance().getZoom()).toBe(.4);
  });
  it('waits for an already queued renderer fit before consuming the research focus timer', async () => {
    nativeClock(); measuredResearchBrowser();
    const documents = Array.from({ length: 6 }, (_, index) => block(`research-${index}`, {
      x: index % 2 * 520, y: Math.floor(index / 2) * 390, width: 400, height: 290,
    }));
    const initial = { ...props(canvas(documents)), focusSelect: false, focusZoom: 1 };
    const view = mount({ canvasProps: initial });
    await tick(1000);
    expect(instance().getZoom()).toBeLessThan(.75);
    view.change({ canvasProps: { ...initial, focusRequest: { blockId: documents[0].id, sequence: 1 } } });
    await tick(176);
    act(() => {
      void instance().fitView({ padding: .16, maxZoom: .75, duration: 350 });
      vi.advanceTimersByTime(4);
    });
    await tick(1200);
    expect(instance().getZoom()).toBe(1);
    expect(screen.getByRole('region', { name: 'Canvas planning infinite canvas' }).classList.contains('canvas-surface--full')).toBe(true);
  });
  it('honors a new research focus after a native viewport movement interrupts an older automatic fit', async () => {
    nativeClock();
    const documents = Array.from({ length: 6 }, (_, index) => block(`research-${index}`, {
      x: 80 + index % 2 * 520, y: 80 + Math.floor(index / 2) * 380, width: 400, height: 290,
    }));
    const initial = { ...props(canvas(documents)), fitRequest: 1, focusSelect: false, focusZoom: 1 };
    const view = mount({ canvasProps: initial });
    await tick(240);
    expect(JSON.parse(screen.getByLabelText('Native fit readiness').textContent ?? '{}')).toMatchObject({ queued: false, fitting: true });
    act(() => { void instance().setViewport({ x: 12, y: 24, zoom: .44 }, { duration: 0 }); });
    await tick(48);
    expect(instance().getZoom()).toBe(.44);
    view.change({ canvasProps: { ...initial, focusRequest: { blockId: documents[0].id, sequence: 1 } } });
    await tick(1200);
    expect(instance().getZoom()).toBe(1);
    expect(screen.getByRole('region', { name: 'Canvas planning infinite canvas' }).classList.contains('canvas-surface--full')).toBe(true);
  });
  it('keeps an explicit research outline focus above the older automatic fit and accepts a genuinely newer fit', async () => {
    nativeClock();
    const documents = Array.from({ length: 6 }, (_, index) => block(`research-${index}`, {
      x: 80 + index % 2 * 520, y: 80 + Math.floor(index / 2) * 380, width: 400, height: 290,
    }));
    const initial = { ...props(canvas(documents)), fitRequest: 1, focusSelect: false, focusZoom: 1,
      focusRequest: { blockId: documents[0].id, sequence: 1 } };
    const view = mount({ canvasProps: initial });
    await tick(1000);
    expect(instance().getZoom()).toBe(1);
    expect(screen.getByRole('region', { name: 'Canvas planning infinite canvas' }).classList.contains('canvas-surface--full')).toBe(true);
    view.change({ canvasProps: { ...initial, fitRequest: 2 } });
    await tick(1000);
    expect(instance().getZoom()).toBeLessThan(.75);
  });
  it('keeps a newer explicit viewport above an older delayed fit', async () => {
    nativeClock();
    const initial = { ...props(), fitRequest: 1 };
    const view = mount({ canvasProps: initial });
    await tick(96);
    expect(JSON.parse(screen.getByLabelText('Native fit readiness').textContent ?? '{}')).toMatchObject({ queued: false, fitting: false });
    view.change({ canvasProps: { ...initial, viewportRequest: { x: 24, y: 68, zoom: .28, sequence: 1 } } });
    await tick(1000);
    expect(instance().getViewport()).toEqual({ x: 24, y: 68, zoom: .28 });
  });
  it('honors an explicit viewport supplied at first mount over the startup fit', async () => {
    nativeClock();
    mount({ canvasProps: { ...props(), fitRequest: 1, viewportRequest: { x: 33, y: 44, zoom: .9, sequence: 1 } } });
    await tick(1000);
    expect(instance().getViewport()).toEqual({ x: 33, y: 44, zoom: .9 });
  });
  it('allows a genuinely newer fit after an explicit viewport', async () => {
    nativeClock();
    const initial = { ...props(), viewportRequest: { x: 33, y: 44, zoom: .9, sequence: 1 } };
    const view = mount({ canvasProps: initial });
    await tick(1000);
    expect(instance().getZoom()).toBe(.9);
    view.change({ canvasProps: { ...initial, fitRequest: 1 } });
    await tick(1000);
    expect(instance().getZoom()).toBe(.75);
  });
  it('keeps a superseded fit canceled across A → B → A navigation and accepts a new fit signal', async () => {
    nativeClock();
    const initial = { ...props(), fitRequest: 1 };
    const view = mount({ canvasProps: initial });
    await tick(96);
    const request = { x: 33, y: 44, zoom: .9, sequence: 1 };
    const explicit = { ...initial, viewportRequest: request };
    view.change({ canvasProps: explicit });
    await tick(1000);
    view.change({ canvasProps: { ...explicit, canvas: canvas([block('c', { x: 300, y: 140 })], 'second') } });
    await tick(1000);
    expect(instance().getZoom()).toBe(1);
    view.change({ canvasProps: explicit });
    await tick(1000);
    expect(instance().getViewport()).toEqual({ x: request.x, y: request.y, zoom: request.zoom });
    view.change({ canvasProps: { ...explicit, fitRequest: 2 } });
    await tick(1000);
    expect(instance().getZoom()).toBe(.75);
  });
  it('restores fitting after clearing an explicit request and cancels pending fits on unmount', async () => {
    nativeClock();
    const published = vi.fn();
    const initial = { ...props(), fitRequest: 1, onViewportChange: published };
    const view = mount({ canvasProps: initial });
    await tick(96);
    view.change({ canvasProps: { ...initial, viewportRequest: { x: 24, y: 68, zoom: .9, sequence: 1 } } });
    await tick(1000);
    view.change({ canvasProps: initial });
    await tick(1000);
    expect(instance().getZoom()).toBe(.75);
    view.change({ canvasProps: { ...initial, fitRequest: 2 } });
    view.unmount();
    const before = published.mock.calls.length;
    await tick(1000);
    expect(published).toHaveBeenCalledTimes(before);
    expect(screen.queryByRole('region', { name: 'Canvas planning infinite canvas' })).toBeNull();
  });
});
