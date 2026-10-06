import { useEffect, useRef, useState } from 'react';
import type { VersionAction, VersionPreview, VersionStatus } from './version-panel-types';

export function useVersionState(initialRevision?: string) {
  const [status, setStatus] = useState<VersionStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [action, setAction] = useState<VersionAction | null>(null);
  const [preview, setPreview] = useState<VersionPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [undoRevision, setUndoRevision] = useState('');
  const requestId = useRef(0);
  const linkedRevision = useRef(initialRevision);
  const active = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      ++generation.current;
      ++requestId.current;
    };
  }, []);
  function owner() {
    // StrictMode can restart effects on the same mounted state; prior requests stay invalid.
    const current = generation.current;
    return () => active.current && generation.current === current;
  }
  return {
    status, setStatus, loadingStatus, setLoadingStatus, name, setName, selected, setSelected, action, setAction,
    preview, setPreview, loadingPreview, setLoadingPreview, busy, setBusy, error, setError, receipt, setReceipt,
    undoRevision, setUndoRevision, requestId, linkedRevision, owner,
  };
}
export type VersionState = ReturnType<typeof useVersionState>;
