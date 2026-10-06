import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { CanvasViewFocus } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';
import type { AppModel } from './app-model';
import type { CanvasViewport } from './useCanvasJourney';
import { useStableEvent } from './useStableEvent';

export function useWorkspaceCanvasEvents(model: AppModel) {
  const { canvas, openBlock } = model;
  const selectBlock = useStableEvent((block: CanvasBlock) => openBlock(block));
  const readBlock = useStableEvent((block: CanvasBlock) => model.openReader(block.id));
  const openCrossLink = useStableEvent((canvasId: string, blockId: string) => model.openCrossLink(canvasId, blockId));
  const historyBlock = useStableEvent((block: CanvasBlock) => model.openVersionHistory(block));
  const selectionChanged = useStableEvent((blocks: CanvasBlock[]) => model.selectedOnCanvas(blocks));
  const summarizeSelection = useStableEvent((blocks: CanvasBlock[]) => model.summarizeSelection(blocks));
  const viewportTimer = useRef<number | null>(null);
  const viewportPending = useRef<{ canvasId: string; viewport: CanvasViewport } | null>(null);
  const saveViewport = useStableEvent(() => {
    // This callback is scheduled only after a pending viewport is assigned.
    // Changing canvas or unmounting cancels its timer before clearing pending.
    const pending = viewportPending.current!;
    viewportTimer.current = null;
    viewportPending.current = null;
    model.journey.updateViewport(pending.canvasId, pending.viewport);
  });
  const viewportChanged = useCallback((viewport: CanvasViewport, visibleBlockIds: string[], focus: CanvasViewFocus) => {
    if (!canvas) return;
    model.setVisibleBlockIds(visibleBlockIds);
    model.setCanvasViewFocus(current => current.level === focus.level && current.activeGroup === focus.activeGroup
      && current.visibleGroups.join('|') === focus.visibleGroups.join('|') ? current : focus);
    viewportPending.current = { canvasId: canvas.id, viewport };
    if (viewportTimer.current === null) viewportTimer.current = window.setTimeout(saveViewport, 180);
  }, [canvas, saveViewport]);
  useLayoutEffect(() => () => {
    if (viewportTimer.current !== null) window.clearTimeout(viewportTimer.current);
    viewportTimer.current = null;
    viewportPending.current = null;
  }, [canvas?.id]);
  const searchMatchIds = useMemo(() => model.searchOpen && canvas
    ? model.searchHits.filter(hit => hit.canvasId === canvas.id).map(hit => hit.blockId) : [],
  [model.searchOpen, model.searchHits, canvas?.id]);
  return { selectBlock, readBlock, openCrossLink, historyBlock, selectionChanged, summarizeSelection, viewportChanged, searchMatchIds };
}
