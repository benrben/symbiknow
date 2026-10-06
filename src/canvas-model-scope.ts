import { useRef } from 'react';

/** A returned canvas gets a new generation so work from an earlier visit stays stale. */
export function useCanvasOperationScope(canvasId: string) {
  const scope = useRef({ canvasId, generation: 0 });
  if (scope.current.canvasId !== canvasId) {
    scope.current = { canvasId, generation: scope.current.generation + 1 };
  }
  return scope;
}
