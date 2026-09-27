import { useEffect, useRef } from 'react';
import { useReactFlow, useStore, type Viewport } from '@xyflow/react';
import type { CanvasBlock } from '../shared/types';

export function FocusBlock({ block, sequence, minZoom = 0.8 }: { block?: CanvasBlock; sequence: number; minZoom?: number }) {
  const { setCenter, getZoom } = useReactFlow();
  const ready = useStore(state => state.width > 0 && state.height > 0 && Boolean(state.panZoom));
  const targetRef = useRef(block);
  targetRef.current = block;
  const available = Boolean(block);
  useEffect(() => {
    const target = targetRef.current;
    if (!target || !ready) return;
    const frame = window.requestAnimationFrame(() => {
      void setCenter(target.x + target.width / 2, target.y + target.height / 2,
        { zoom: Math.max(getZoom(), minZoom), duration: 350 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [available, sequence, ready, setCenter, getZoom, minZoom]);
  return null;
}

export function ViewRequest({ request }: { request?: Viewport & { sequence: number } }) {
  const { setViewport } = useReactFlow();
  const ready = useStore(state => state.width > 0 && state.height > 0 && Boolean(state.panZoom));
  useEffect(() => {
    if (request && ready) void setViewport({ x: request.x, y: request.y, zoom: request.zoom }, { duration: 300 });
  }, [request?.sequence, ready, setViewport]);
  return null;
}

export function FocusPoint({ request }: { request?: { x: number; y: number; zoom: number; sequence: number } }) {
  const { setCenter } = useReactFlow();
  const ready = useStore(state => state.width > 0 && state.height > 0 && Boolean(state.panZoom));
  useEffect(() => {
    if (!request || !ready) return;
    const timer = window.setTimeout(() => void setCenter(request.x, request.y, { zoom: request.zoom, duration: 300 }), 80);
    return () => window.clearTimeout(timer);
  }, [request?.sequence, ready, setCenter]);
  return null;
}
