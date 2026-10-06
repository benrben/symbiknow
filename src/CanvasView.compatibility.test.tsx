// @vitest-environment jsdom
import { ReactFlowProvider } from '@xyflow/react';
import { fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraFrames, nativeCameraClock } from './CanvasOverview.readiness.test.helpers';
import { block, canvas, installCanvasBrowser, ModelBoundary, props } from './canvas-model.test.helpers';

installCanvasBrowser();
let frame: HTMLIFrameElement | undefined;
afterEach(() => { frame?.remove(); frame = undefined; });

function foreignDocument() {
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const ownerDocument = frame.contentDocument;
  const ownerWindow = ownerDocument?.defaultView as (Window & typeof globalThis) | null;
  if (!ownerDocument || !ownerWindow) throw new Error('Missing native iframe document');
  // Match the normal browser geometry fixture in the iframe's distinct realm.
  // The renderer, model, event targets and native DOM constructors are intact.
  Object.defineProperty(ownerWindow.HTMLElement.prototype, 'offsetWidth', { configurable: true,
    get() { return this.style.width.endsWith('px') ? Number.parseFloat(this.style.width) : 1000; } });
  Object.defineProperty(ownerWindow.HTMLElement.prototype, 'offsetHeight', { configurable: true,
    get() { return this.style.height.endsWith('px') ? Number.parseFloat(this.style.height) : 800; } });
  Object.defineProperty(ownerWindow.Element.prototype, 'getBoundingClientRect', { configurable: true,
    value(this: HTMLElement) { return new ownerWindow.DOMRect(0, 0,
      this.style?.width.endsWith('px') ? Number.parseFloat(this.style.width) : 1000,
      this.style?.height.endsWith('px') ? Number.parseFloat(this.style.height) : 800); } });
  const container = ownerDocument.createElement('div');
  ownerDocument.body.appendChild(container);
  return { container, ownerWindow };
}

describe('CanvasView component compatibility in a foreign document', () => {
  it('accepts genuine iframe click/wheel input through the installed renderer without page errors or target substitution', async () => {
    nativeCameraClock();
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...values) => { errors.push(values); });
    const { container, ownerWindow } = foreignDocument();
    render(<ReactFlowProvider><ModelBoundary canvasProps={props(canvas([
      block('a', { group: 'lane:overview' }), block('b', { group: 'lane:overview', x: 400 }),
    ]))}/></ReactFlowProvider>, { container });
    await cameraFrames(1000);
    const scoped = within(container);
    const zoom = scoped.getByRole('button', { name: 'Zoom In' });
    expect(zoom.ownerDocument.defaultView).toBe(ownerWindow);
    expect(zoom instanceof Element).toBe(false);
    const label = container.querySelector('.canvas-zoom-label');
    expect(label?.textContent).toBe('Files · 100%');
    fireEvent.click(zoom);
    await cameraFrames(1000);
    expect(label?.textContent).toBe('Files · 120%');
    const group = container.querySelector('[data-canvas-group="lane:overview"]');
    if (!group) throw new Error('Missing iframe canvas group');
    expect(group instanceof Element).toBe(false);
    const wheel = new ownerWindow.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, clientX: 500, clientY: 300 });
    fireEvent(group, wheel);
    await cameraFrames(1000);
    expect(label?.textContent).toBe('Files · 104%');
    expect(errors).toEqual([]);
  });
});
