import { groupPath } from '../shared/groups';
import type { CanvasState } from './canvas-state';
import type { ZoomBand } from './canvas-viewport-types';

export function zoomBandFor(zoom: number): ZoomBand {
  return zoom < .34 ? 'overview' : zoom < .75 ? 'titles' : 'full';
}

export function enteringOverview(zoom: number, enteringFiles: boolean, mapPinned: boolean) {
  return zoom < .34 && !enteringFiles && !mapPinned;
}

export function enteringMapGroup(zoom: number, intent: string | null, mapPinned: boolean, frameCount: number) {
  return mapPinned && intent === 'in' && zoom >= .5 && frameCount > 0;
}

export function leavingMapGroup(zoom: number, intent: string | null, mapPinned: boolean) {
  return mapPinned && intent === 'out' && zoom <= .21;
}

export function stepOutOfMap(state: CanvasState) {
  if (state.mapParent) state.setMapParent(groupPath(state.mapParent).at(-2) ?? '');
  else if (state.activeSupergroup) state.setActiveSupergroup('');
}
