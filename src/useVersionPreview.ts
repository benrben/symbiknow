import { useEffect } from 'react';
import { api } from './api';
import { failureMessage, type VersionAction, type VersionPreview } from './version-panel-types';
import type { VersionState } from './useVersionState';

export function useVersionPreview(base: string, state: VersionState) {
  const { setAction, setPreview, setError, setReceipt, setUndoRevision, setLoadingPreview, requestId, linkedRevision, status } = state;
  async function choose(next: VersionAction) {
    const id = ++requestId.current;
    const isOwner = state.owner();
    const current = () => isOwner() && requestId.current === id;
    setAction(next);
    setPreview(null);
    setError('');
    setReceipt('');
    setUndoRevision('');
    setLoadingPreview(true);
    const parameter = next.kind === 'restore' ? 'revision' : 'name';
    try {
      const value = await api<VersionPreview>(base + '/preview?kind=' + next.kind + '&' + parameter + '=' + encodeURIComponent(next.value));
      if (current()) setPreview(value);
    } catch (reason) {
      if (current()) setError('Preview failed: ' + failureMessage(reason) + ' Saved content is unchanged. Retry the preview before applying.');
    } finally {
      if (current()) setLoadingPreview(false);
    }
  }
  useEffect(() => {
    const revision = linkedRevision.current;
    if (!revision || !status) return;
    linkedRevision.current = undefined;
    void choose({ kind: 'restore', value: revision, label: 'Inspect linked revision ' + revision.slice(0, 12) });
  }, [status]);
  function cancelPreview() {
    ++requestId.current;
    setAction(null);
    setPreview(null);
    setLoadingPreview(false);
  }
  return { choose, cancelPreview };
}
