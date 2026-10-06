import type { Viewport } from '@xyflow/react';
import { useCallback } from 'react';
import { useStableEvent } from './useStableEvent';
import type { CanvasGraph } from './canvas-graph';
import type { CanvasState } from './canvas-state';
import type { CanvasProps, FlowNode } from './canvas-types';
import { rememberViewport } from './canvas-view-helpers';
import { nearestMapGroup, visibleDocuments, visibleGroupNodes, visibleGroups } from './canvas-viewport-geometry';
import { enteringOverview, enteringMapGroup, leavingMapGroup, stepOutOfMap, zoomBandFor } from './canvas-viewport-transitions';

export { zoomBandFor } from './canvas-viewport-transitions';

export function useCanvasViewport(state: CanvasState, graph: CanvasGraph, props: CanvasProps, flowNodes: FlowNode[], openHierarchyGroup: (group: string) => void) {
  const {
    mapPinned, surface, enteringFiles, zoomIntent, zoomTarget, setMapPinned, setDrillGroup, setShowDrillBoard,
    zoomBand, setZoom, rememberedViewports, viewportCallback,
  } = state;
  const { mapFrames } = graph;
  const publishViewport = useStableEvent((viewport: Viewport) => {
    const bounds = flowStageBounds(surface);
    const visibleBlockIds = visibleDocuments(flowNodes, viewport, bounds);
    const groups = visibleGroups(visibleGroupNodes(flowNodes, viewport, bounds), graph);
    viewportCallback.current?.(viewport, visibleBlockIds, { ...graph.viewFocus, visibleGroups: [...new Set(groups)].slice(0, 16) });
  });
  const moved = useCallback((event: unknown, viewport: Viewport) => {
    releaseFittedGroup(state, event, viewport, false);
    const scale = 1 / Math.max(viewport.zoom, .28);
    surface.current?.style.setProperty('--canvas-label-scale', String(scale));
    surface.current?.style.setProperty('--canvas-map-summary-opacity', String(Math.max(0, Math.min(1, (viewport.zoom - .1) / .12))));
    if (viewport.zoom >= .75) enteringFiles.current = false;
    if (props.groupsEnabled !== false && enteringOverview(viewport.zoom, overviewIntentBlocked(state), mapPinned)) {
      zoomIntent.current = null;
      zoomTarget.current = null;
      setMapPinned(true);
      setDrillGroup('');
      setShowDrillBoard(false);
    }
    const nextBand = zoomBandFor(viewport.zoom);
    if (nextBand !== zoomBand.current) {
      zoomBand.current = nextBand;
      setZoom(viewport.zoom);
    }
    publishViewport(viewport);
  }, [mapPinned, publishViewport, state.fittedGroup, props.groupsEnabled]);
  const moveEnded = useCallback((event: unknown, viewport: Viewport) => {
    releaseFittedGroup(state, event, viewport, true);
    const intent = zoomIntent.current;
    const intendedGroup = zoomTarget.current;
    zoomIntent.current = null;
    zoomTarget.current = null;
    if (viewport.zoom >= .75) enteringFiles.current = false;
    if (props.groupsEnabled !== false) finishGroupZoom(state, graph, flowNodes, openHierarchyGroup, viewport, intent, intendedGroup);
    zoomBand.current = zoomBandFor(viewport.zoom);
    rememberViewport(rememberedViewports.current, props.canvas.id, viewport);
    setZoom(viewport.zoom);
    publishViewport(viewport);
  }, [props.canvas.id, props.groupsEnabled, mapPinned, mapFrames.length, flowNodes, state.hoveredGroup, openHierarchyGroup,
  state.mapParent, state.activeSupergroup, graph.supergroups, graph.viewFocus, state.fittedGroup]);
  return { moved, moveEnded };
}

function flowStageBounds(surface: CanvasState['surface']): DOMRect | undefined {
  return surface.current?.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
}

function settleFittedGroup(state: CanvasState, owner: NonNullable<CanvasState['fittedGroup']>, ended: boolean): void {
  if (ended) state.fittedGroupSettled.current = owner.sequence;
}

function laterGroupZoom(event: unknown, intent: string | null, settled: boolean): boolean {
  return Boolean(event || intent || settled);
}

function pendingGroupFit(state: CanvasState): boolean {
  const owner = state.fittedGroup;
  if (!owner) return false;
  return state.fittedGroupSettled.current !== owner.sequence && owner.sequence === state.pointRequest?.sequence;
}

function overviewIntentBlocked(state: CanvasState): boolean {
  return state.enteringFiles.current || pendingGroupFit(state);
}

/** A fitted group's reading view lasts until a later zoom takes ownership of the camera. */
function releaseFittedGroup(state: CanvasState, event: unknown, viewport: Viewport, ended: boolean): void {
  const owner = state.fittedGroup;
  if (!owner) return;
  if (Math.abs(owner.zoom - viewport.zoom) < .001) { settleFittedGroup(state, owner, ended); return; }
  if (laterGroupZoom(event, state.zoomIntent.current, state.fittedGroupSettled.current === owner.sequence)) state.setFittedGroup(undefined);
}

function finishGroupZoom(state: CanvasState, graph: CanvasGraph, flowNodes: FlowNode[], openGroup: (group: string) => void,
  viewport: Viewport, intent: 'in' | 'out' | null, intendedGroup: string | null): void {
  if (enteringOverview(viewport.zoom, overviewIntentBlocked(state), state.mapPinned)) {
    state.setMapPinned(true);
    state.setDrillGroup('');
    state.setShowDrillBoard(false);
  } else if (enteringMapGroup(viewport.zoom, intent, state.mapPinned, graph.mapFrames.length)) {
    const bounds = flowStageBounds(state.surface);
    const nearest = nearestMapGroup(flowNodes, viewport, bounds, intendedGroup, state.hoveredGroup);
    if (nearest) openGroup(nearest.data.group);
  } else if (leavingMapGroup(viewport.zoom, intent, state.mapPinned)) stepOutOfMap(state);
}
