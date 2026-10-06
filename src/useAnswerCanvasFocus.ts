import { useEffect } from 'react';
import type { Viewport } from '@xyflow/react';
import type { AnswerCanvasViewFocus, CanvasViewFocus } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';
import type { ResearchBlock } from './research-canvas';
import type { AnswerCanvasProps } from './answer-canvas-types';
import type { AnswerCanvasGraph } from './useAnswerCanvasGraph';
import type { AnswerCanvasState } from './useAnswerCanvasState';
import { sourceKey } from './answer-canvas-helpers';

export function useAnswerCanvasFocus({ onOpenSource, onViewFocusChange }: AnswerCanvasProps, { graph, sources, latest, first }: AnswerCanvasGraph, state: AnswerCanvasState) {
  const { setFocusedTurnId, setFocusRequest, setFitRequest, focusedKey, focusState } = state;
  useEffect(() => {
    if (!first) return;
    const key = String(latest?.id) + ':' + first.id;
    if (focusedKey.current === key) return;
    focusedKey.current = key;
    setFocusRequest(undefined);
    setFitRequest(current => current + 1);
    // Automatic outline blocks are selected from the latest turn.
    setFocusedTurnId(latest!.id);
  }, [first?.id, latest?.id]);
  const focus = (block: ResearchBlock) => {
    setFocusedTurnId(block.turnId);
    setFocusRequest(current => ({ blockId: block.id, sequence: (current?.sequence ?? 0) + 1 }));
  };
  const focusTurn = (turnId: number) => {
    const block = graph.blocks.find(item => item.turnId === turnId);
    if (block) focus(block);
  };
  const reportFocus = (next: AnswerCanvasViewFocus) => {
    focusState.current = next;
    onViewFocusChange?.(next);
  };
  const viewChanged = (viewport: Viewport, visibleIds: string[], focusView: CanvasViewFocus) => {
    const visible = graph.blocks.filter(block => visibleIds.includes(block.id));
    reportFocus({
      ...focusState.current,
      level: focusView.level === 'overview' || viewport.zoom < .45 ? 'big-picture' : viewport.zoom < .9 ? 'answers' : 'sources',
      visibleAnswerIds: [...new Set(visible.map(block => block.turnId))], visibleBlockIds: visibleIds,
      visibleSourceKeys: [...new Set(visible.flatMap(block => block.sources.map(sourceKey)))],
    });
  };
  const selectionChanged = (blocks: CanvasBlock[]) => {
    const chosen = graph.blocks.find(block => block.id === blocks[0]?.id);
    reportFocus({
      ...focusState.current, selectedBlockId: chosen?.id, selectedAnswerId: chosen?.turnId,
      selectedSourceKey: undefined
    });
  };
  const openSourceLink = (canvasId: string, blockId: string) => {
    const source = sources.find(item => item.canvasId === canvasId && item.blockId === blockId);
    if (source) onOpenSource(source);
  };
  return { focus, focusTurn, viewChanged, selectionChanged, openSourceLink };
}
export type AnswerCanvasFocus = ReturnType<typeof useAnswerCanvasFocus>;
