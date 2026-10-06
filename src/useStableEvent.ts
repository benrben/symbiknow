import { useCallback,useLayoutEffect,useRef } from 'react';

export function useStableEvent<T extends (...args: never[]) => unknown>(callback: T): T {
  const current = useRef(callback);
  useLayoutEffect(() => { current.current = callback; }, [callback]);
  return useCallback(((...args: Parameters<T>) => current.current(...args)) as T, []);
}
