import { useEffect, useRef, type RefObject } from 'react';
import { useReactFlow, useStore, useStoreApi, type ReactFlowState, type Viewport } from '@xyflow/react';
import type { CanvasBlock } from '../shared/types';

export function FocusBlock({ block, sequence, minZoom = 0.8 }: { block?: CanvasBlock; sequence: number; minZoom?: number }) {
  const { setCenter, getZoom, setViewport } = useReactFlow();
  const store = useStoreApi();
  const operation = useFocusedStageResize(store, setViewport);
  const ready = useCanvasViewReady();
  const appliedSequence = useRef<number | undefined>(undefined);
  const targetRef = useRef(block);
  targetRef.current = block;
  const available = Boolean(block);
  useEffect(() => {
    const target = targetRef.current;
    if (!target) { appliedSequence.current = undefined; return; }
    if (!ready || appliedSequence.current === sequence) return;
    const owner = newFocusStage();
    const frame = window.requestAnimationFrame(() => {
      appliedSequence.current = sequence;
      operation.current = owner;
      centerFocusedStage(store, owner, { x: target.x + target.width / 2, y: target.y + target.height / 2,
        zoom: Math.max(getZoom(), minZoom), duration: 350 }, { setCenter, setViewport });
    });
    return () => { owner.active = false; window.cancelAnimationFrame(frame); };
  }, [available, sequence, ready, setCenter, getZoom, minZoom, store, operation, setViewport]);
  return null;
}

type FocusStage = { width: number; height: number; viewport: Viewport; pending: boolean; active: boolean };
type SetViewport = ReturnType<typeof useReactFlow>['setViewport'];
function newFocusStage(): FocusStage {
  return { width: 0, height: 0, viewport: { x: 0, y: 0, zoom: 0 }, pending: true, active: true };
}
function centerFocusedStage(store: ReturnType<typeof useStoreApi>, owner: FocusStage, target: { x: number; y: number; zoom: number; duration: number },
  commands: Pick<ReturnType<typeof useReactFlow>, 'setCenter' | 'setViewport'>) {
  const state = store.getState();
  owner.width = state.width; owner.height = state.height;
  owner.viewport = { x: state.width / 2 - target.x * target.zoom, y: state.height / 2 - target.y * target.zoom, zoom: target.zoom };
  void commands.setCenter(target.x, target.y, { zoom: target.zoom, duration: target.duration }).then(() => {
    owner.pending = false;
    if (owner.active) resizeFocusedViewport(store.getState(), owner, commands.setViewport);
  });
}
function useFocusedStageResize(store: ReturnType<typeof useStoreApi>, setViewport: SetViewport) {
  const operation = useRef<FocusStage | undefined>(undefined);
  useEffect(() => store.subscribe((state, previous) => {
    if (state.width === previous.width && state.height === previous.height) return;
    const owner = operation.current;
    if (owner?.active && !owner.pending) resizeFocusedViewport(state, owner, setViewport);
  }), [store, setViewport]);
  return operation;
}

/** Size changes retain the focused world position only while its viewport still owns the camera. */
function resizeFocusedViewport(state: ReactFlowState, owner: FocusStage, setViewport: SetViewport) {
  if (!focusedViewportMatches(state.transform, owner.viewport)) { owner.active = false; return; }
  if (state.width === owner.width && state.height === owner.height) return;
  const viewport = { ...owner.viewport, x: owner.viewport.x + (state.width - owner.width) / 2,
    y: owner.viewport.y + (state.height - owner.height) / 2 };
  owner.width = state.width; owner.height = state.height; owner.viewport = viewport;
  void setViewport(viewport, { duration: 0 });
}
function focusedViewportMatches(transform: ReactFlowState['transform'], viewport: Viewport): boolean {
  return [viewport.x, viewport.y, viewport.zoom].every((value, index) => Math.abs(value - transform[index]) < 0.001);
}

/** Research previews fit the full source after the renderer's initial fit completes. */
export function FocusFittedBlock({ block, sequence, maxZoom = 1, surface }: {
  block?: CanvasBlock; sequence: number; maxZoom?: number; surface: RefObject<HTMLElement | null>;
}) {
  const { setCenter } = useReactFlow();
  const store = useStoreApi();
  const ready = useCanvasViewReady();
  const appliedSequence = useRef<number | undefined>(undefined);
  const targetRef = useRef(block);
  targetRef.current = block;
  const owner = useRef('');
  owner.current = JSON.stringify([block?.id, sequence]);
  const available = Boolean(block);
  useEffect(() => {
    const target = targetRef.current;
    if (!target) { appliedSequence.current = undefined; return; }
    if (!ready || appliedSequence.current === sequence) return;
    const requestOwner = owner.current;
    return scheduleFittedFocus(() => owner.current === requestOwner, () => fittedViewReady(store.getState()), () => {
      const stage = surface.current?.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
      const fittingZoom = stage ? Math.min((stage.width - 24) / target.width, (stage.height - 24) / target.height) : 1;
      appliedSequence.current = sequence;
      void setCenter(target.x + target.width / 2, target.y + target.height / 2,
        { zoom: Math.max(.28, Math.min(maxZoom, fittingZoom)), duration: 350 });
    });
  }, [available, sequence, ready, setCenter, maxZoom, surface]);
  return null;
}

/** A fit can be queued after scheduling; do not consume focus before that work drains. */
function scheduleFittedFocus(current: () => boolean, ready: () => boolean, apply: () => void) {
  let frame = 0;
  function attempt() {
    if (!current()) return;
    if (!ready()) { frame = window.requestAnimationFrame(attempt); return; }
    apply();
  }
  const timer = window.setTimeout(attempt, 180);
  return () => { window.clearTimeout(timer); window.cancelAnimationFrame(frame); };
}

function fittedViewReady(state: ReactFlowState) {
  return !state.fitViewQueued && viewRequestReady(state);
}

export function ViewRequest({ request }: { request?: Viewport & { sequence: number } }) {
  const { setViewport } = useReactFlow();
  const appliedSequence = useRef<number | undefined>(undefined);
  const ready = useCanvasViewReady();
  useEffect(() => {
    if (!request || !ready || appliedSequence.current === request.sequence) return;
    appliedSequence.current = request.sequence;
    void setViewport({ x: request.x, y: request.y, zoom: request.zoom }, { duration: 300 });
  }, [request?.sequence, ready, setViewport]);
  return null;
}

function useCanvasViewReady() {
  return useStore(viewRequestReady);
}

type OverviewRequestProps = {
  active: boolean; canvasId: string; parent: string; sequence: number; supergroup?: { id: string };
  viewportRequest?: { sequence: number }; pointRequest?: { sequence: number }; focusRequest?: { sequence: number };
};

/** Geometry can arrive after the overview button; only its current camera owner may replay it. */
export function OverviewRequest(props: OverviewRequestProps) {
  const { setViewport } = useReactFlow();
  const ready = useCanvasViewReady();
  const scope = overviewScope(props);
  const camera = cameraRequestKey(props);
  const owner = useRef({ scope, camera });
  if (owner.current.scope !== scope) owner.current = { scope, camera };
  const current = owner.current.camera === camera;
  useEffect(() => {
    if (!props.active || !current || !ready) return;
    const frame = window.requestAnimationFrame(() => void setViewport({ x: 24, y: 68, zoom: .28 }, { duration: 250 }));
    return () => window.cancelAnimationFrame(frame);
  }, [props.active, current, ready, scope, setViewport]);
  return null;
}

function overviewScope({ canvasId, parent, sequence, supergroup }: OverviewRequestProps) {
  return JSON.stringify([canvasId, parent, sequence, supergroup?.id]);
}

function cameraRequestKey({ viewportRequest, pointRequest, focusRequest }: OverviewRequestProps) {
  return JSON.stringify([viewportRequest?.sequence, pointRequest?.sequence, focusRequest?.sequence]);
}

function viewRequestReady(state: ReactFlowState): boolean {
  return state.width > 0 && state.height > 0 && Boolean(state.panZoom) && initialLayoutReady(state);
}

function initialLayoutReady(state: ReactFlowState): boolean {
  // The default initial fit sets its transform before clearing this queue.
  // An interrupted animated fit can leave its resolver pending forever; a newer
  // explicit request owns the camera once the queued layout has been consumed.
  return state.nodes.length === 0 || !state.fitViewQueued;
}

export function FocusPoint({ request }: { request?: { x: number; y: number; zoom: number; sequence: number } }) {
  const { setCenter, setViewport } = useReactFlow();
  const store = useStoreApi();
  const operation = useFocusedStageResize(store, setViewport);
  const ready = useCanvasViewReady();
  const appliedSequence = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!request) { appliedSequence.current = undefined; return; }
    if (!ready || appliedSequence.current === request.sequence) return;
    const owner = newFocusStage();
    const timer = window.setTimeout(() => {
      appliedSequence.current = request.sequence;
      operation.current = owner;
      centerFocusedStage(store, owner, { ...request, duration: 300 }, { setCenter, setViewport });
    }, 80);
    return () => { owner.active = false; window.clearTimeout(timer); };
  }, [request?.sequence, ready, setCenter, setViewport, store, operation]);
  return null;
}
