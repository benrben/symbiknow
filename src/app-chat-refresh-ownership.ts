import { useEffect, useRef } from 'react';
import type { AppState } from './app-state';

/** A chat refresh belongs to the canvas and form that were active when it began. */
export function useChatRefreshOwnership(state: AppState) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return (canvasId: string) => {
    const navigation = state.navigationVersion.current;
    const dialog = state.dialogVersion.current;
    return () => mounted.current && state.activeCanvasId.current === canvasId
      && state.navigationVersion.current === navigation && state.dialogVersion.current === dialog;
  };
}
