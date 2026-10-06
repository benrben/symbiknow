import { useLayoutEffect, useRef } from 'react';

type Layer = { close: () => void };
const layers: Layer[] = [];

function closeTopLayer(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  layers.at(-1)!.close();
}

/**
 * Escape closes only the most recently opened layer, wherever focus is.
 * The window capture listener runs before any element handler, so one key press never closes two surfaces.
 */
export function useEscapeLayer(open: boolean, onEscape: () => void): void {
  const handler = useRef(onEscape);
  useLayoutEffect(() => { handler.current = onEscape; });
  useLayoutEffect(() => {
    if (!open) return;
    const layer = { close: () => handler.current() };
    layers.push(layer);
    if (layers.length === 1) window.addEventListener('keydown', closeTopLayer, true);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (!layers.length) window.removeEventListener('keydown', closeTopLayer, true);
    };
  }, [open]);
}
