import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CanvasBlock } from '../shared/types';
import { api } from './api';
import { blockPath } from './app-model-helpers';

type RequestOwner = { block: CanvasBlock; canvasId: string; attempt: number };
type ContentResult = { owner: RequestOwner; block?: CanvasBlock; error: string };

export function useDocumentContent(block: CanvasBlock, canvasId: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<ContentResult>();
  // Each navigation or refresh owns its result, even when returning to the same document.
  const owner = useMemo(() => ({ block, canvasId, attempt }), [block, canvasId, attempt]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (owner.block.contentLoaded !== false) return;
    const controller = new AbortController();
    let cancelled = false;
    api<CanvasBlock>(blockPath(owner.canvasId, owner.block.id), { cache: 'no-store', signal: controller.signal })
      .then((loaded) => {
        if (!cancelled) setResult({ owner, block: loaded, error: '' });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ owner, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [owner]);

  if (block.contentLoaded !== false) return { block, loading: false, error: '', retry };
  const current = result?.owner === owner ? result : undefined;
  return { block: current?.block, loading: !current, error: current?.error ?? '', retry };
}
