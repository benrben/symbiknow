import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { CanvasInspectorProps } from './canvas-inspector-types';

type Axis = 'width' | 'height';
type Drag = { axis: Axis; pointerId: number; start: number; size: number };
const fallbackSizes = { width: 344, height: 260 };
const minimumSizes = { width: 280, height: 190 };
const reservedSpace = { width: 260, height: 120 };
const arrowChanges: Record<Axis, Record<string, number>> = {
  width: { ArrowLeft: 32, ArrowRight: -32 }, height: { ArrowUp: 32, ArrowDown: -32 },
};
function resizeAxis(): Axis {
  return window.matchMedia?.('(max-width: 700px)').matches || window.innerWidth <= 700 ? 'height' : 'width';
}
function viewportSize(axis: Axis) { return axis === 'width' ? window.innerWidth : window.innerHeight; }
function dimension(element: Element | null, axis: Axis) { return element ? element.getBoundingClientRect()[axis] : 0; }
function panelSize(element: HTMLElement, axis: Axis) { return dimension(element.parentElement, axis) || fallbackSizes[axis]; }
function coordinate(event: PointerEvent<HTMLDivElement>, axis: Axis) { return axis === 'width' ? event.clientX : event.clientY; }
function boundedSize(element: HTMLElement, axis: Axis, requested: number) {
  const available = dimension(element.closest('.canvas-surface'), axis) || viewportSize(axis);
  const minimum = minimumSizes[axis];
  const maximum = Math.max(minimum, available - reservedSpace[axis]);
  return Math.round(Math.min(maximum, Math.max(minimum, requested)));
}

export function InspectorResize({ onResize }: Pick<CanvasInspectorProps, 'onResize'>) {
  const drag = useRef<Drag | null>(null);
  function resize(axis: Axis, requested: number, element: HTMLElement) { onResize(axis, boundedSize(element, axis, requested)); }
  function startResize(event: PointerEvent<HTMLDivElement>) {
    const axis = resizeAxis();
    if (!event.currentTarget.parentElement) return;
    drag.current = { axis, pointerId: event.pointerId, start: coordinate(event, axis), size: panelSize(event.currentTarget, axis) };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function moveResize(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const distance = current.start - coordinate(event, current.axis);
    resize(current.axis, current.size + distance, event.currentTarget);
  }
  function stopResize(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboardResize(event: KeyboardEvent<HTMLDivElement>) {
    const axis = resizeAxis();
    const delta = arrowChanges[axis][event.key] ?? 0;
    if (!delta) return;
    event.preventDefault();
    resize(axis, panelSize(event.currentTarget, axis) + delta, event.currentTarget);
  }
  return <div className="canvas-inspector__resize" role="separator" tabIndex={0} aria-label="Resize document panel"
    onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={keyboardResize}/>;
}
