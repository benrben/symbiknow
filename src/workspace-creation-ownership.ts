import { useEffect, useRef } from 'react';
import type { AppState } from './app-state';

export function useWorkspaceCreationOwnership(state: AppState) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return function captureCreation() {
    const navigation = state.navigationVersion.current;
    const dialog = state.dialogVersion.current;
    return () => mounted.current && state.navigationVersion.current === navigation
      && state.dialogVersion.current === dialog;
  };
}
