import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

const storageKey = 'symbiknow.assistant.width';
const legacyStorageKey = 'allteam.assistant.width';

function maximumWidth(documentMode = false) {
  const viewport = window.innerWidth;
  if (documentMode) return Math.max(320, viewport - 480);
  if (viewport <= 620) return viewport - 66;
  if (viewport <= 780) return viewport - 66 - 280;
  if (viewport <= 1100) return viewport - 205 - 300;
  return viewport - 244 - 320;
}

function boundedWidth(value: number, documentMode = false) {
  return Math.min(maximumWidth(documentMode), Math.max(documentMode ? 320 : 240, value));
}

function savedWidth() {
  return Number(window.localStorage.getItem(storageKey) ?? window.localStorage.getItem(legacyStorageKey)) || 500;
}

export function ResizableAssistant({ hidden, documentWidth, onDocumentWidthChange, children }: {
  hidden: boolean; documentWidth?: number; onDocumentWidthChange?: (width: number) => void; children: ReactNode;
}) {
  const [width, setWidth] = useState(savedWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const documentMode = documentWidth !== undefined;
  const activeWidth = boundedWidth(documentWidth ?? width, documentMode);

  function updateWidth(value: number) {
    const next = boundedWidth(value, documentMode);
    if (documentMode) { onDocumentWidthChange?.(next); return; }
    setWidth(next);
    window.localStorage.setItem(storageKey, String(next));
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    drag.current = { x: event.clientX, width: activeWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current) updateWidth(drag.current.width + drag.current.x - event.clientX);
  }

  function stopDrag() { drag.current = null; }

  function resizeWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') updateWidth(activeWidth + 24);
    else if (event.key === 'ArrowRight') updateWidth(activeWidth - 24);
    else return;
    event.preventDefault();
  }

  return <aside className="chat-panel" hidden={hidden} aria-label="Symbi assistant" style={{ '--assistant-width': `${activeWidth}px` } as CSSProperties}>
    <div className="chat-resize-handle" role="separator" aria-label="Resize chat panel" aria-orientation="vertical" aria-valuemin={documentMode ? 320 : 240} aria-valuemax={maximumWidth(documentMode)} aria-valuenow={activeWidth} tabIndex={0} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onKeyDown={resizeWithKeys}/>
    {children}
  </aside>;
}
