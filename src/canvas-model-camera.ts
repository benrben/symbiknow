import { useRef } from 'react';
import type { CanvasProps } from './canvas-types';

/** An explicit viewport supersedes document work queued before that request. */
export function useCanvasCameraRequest(viewportSequence: number | undefined, focusRequest: CanvasProps['focusRequest'], clearPoint: () => void) {
  const focusSequence = focusRequest?.sequence;
  const camera = useRef({ viewportSequence, focusSequence: viewportFocusSequence(viewportSequence, focusSequence) });
  if (camera.current.viewportSequence !== viewportSequence) {
    camera.current = { viewportSequence, focusSequence: viewportFocusSequence(viewportSequence, focusSequence) };
    if (viewportSequence !== undefined) clearPoint();
  }
  return eligibleFocus(focusRequest, camera.current.focusSequence);
}

/** A saved viewport owns centering, while a fresh co-batched focus still selects its document. */
export function useCanvasFocusRequests(viewportSequence: number | undefined, focusRequest: CanvasProps['focusRequest'], clearPoint: () => void) {
  const cameraRequest = useCanvasCameraRequest(viewportSequence, focusRequest, clearPoint);
  const selectionRequest = useCanvasSelectionRequest(viewportSequence, focusRequest);
  return { cameraRequest, selectionRequest };
}

function useCanvasSelectionRequest(viewportSequence: number | undefined, request: CanvasProps['focusRequest']) {
  const focusSequence = request?.sequence;
  const owner = useRef<{ viewportSequence?: number; focusSequence?: number; blockedSequence?: number }>({ viewportSequence, focusSequence });
  if (owner.current.viewportSequence !== viewportSequence) {
    const blockedSequence = retainedFocusSequence(viewportSequence, focusSequence, owner.current.focusSequence);
    owner.current = { viewportSequence, focusSequence, blockedSequence };
  } else owner.current.focusSequence = focusSequence;
  return eligibleFocus(request, owner.current.blockedSequence);
}

function retainedFocusSequence(viewportSequence: number | undefined, focusSequence: number | undefined, previous: number | undefined) {
  if (focusSequence !== previous) return undefined;
  return viewportFocusSequence(viewportSequence, focusSequence);
}

function viewportFocusSequence(viewportSequence: number | undefined, focusSequence: number | undefined) {
  return viewportSequence === undefined ? undefined : focusSequence;
}

function eligibleFocus(request: CanvasProps['focusRequest'], blockedSequence: number | undefined) {
  return request?.sequence === blockedSequence ? undefined : request;
}

/** Only a fit issued after the current explicit viewport or focus may replace it. */
export function useCanvasFitRequest(viewportSequence: number | undefined, fitRequest: number | undefined, focusSequence?: number) {
  const scope = JSON.stringify([viewportSequence, focusSequence]);
  const camera = useRef({ scope, fitSequence: supersededFit(viewportSequence, focusSequence, fitRequest) });
  if (camera.current.scope !== scope) {
    camera.current = { scope, fitSequence: supersededFit(viewportSequence, focusSequence, fitRequest) };
  }
  return fitRequest === camera.current.fitSequence ? undefined : fitRequest;
}

function supersededFit(viewportSequence: number | undefined, focusSequence: number | undefined, fitRequest: number | undefined) {
  return viewportSequence === undefined && focusSequence === undefined ? undefined : fitRequest;
}
