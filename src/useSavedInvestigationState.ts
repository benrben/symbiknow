import { useEffect, useRef, useState } from 'react';
import type { InvestigationRecord, InvestigationSummary } from './saved-investigation-types';
export function useSavedInvestigationState(workspaceId: string) {
  const [items, setItems] = useState<InvestigationSummary[]>([]);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [selected, setSelected] = useState<InvestigationRecord | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [unreadableKey, setUnreadableKey] = useState('');
  const requestId = useRef(0);
  const actionId = useRef(0);
  const active = useRef(true);
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      ++actionId.current;
    };
  }, []);
  function owner() {
    const id = ++actionId.current;
    return () => active.current && id === actionId.current && currentWorkspace.current === workspaceId;
  }
  useEffect(() => {
    // Leaving and returning to the same workspace must not revive an earlier action.
    ++actionId.current;
    setSelected(null);
    setTitle('');
    setItems([]);
    setError('');
    setReceipt('');
    setBusy(false);
    setUnreadableKey('');
  }, [workspaceId]);
  function newInvestigation(onClearSelection?: () => void) {
    ++actionId.current;
    setUnreadableKey('');
    setSelected(null);
    onClearSelection?.();
    setTitle('');
    setVisibility('private');
    setReceipt('');
    setError('');
  }
  return {
    items, setItems, title, setTitle, visibility, setVisibility, selected, setSelected, isOpen, setIsOpen, loading, setLoading,
    busy, setBusy, error, setError, receipt, setReceipt, unreadableKey, setUnreadableKey, requestId, owner, newInvestigation
  };
}
export type SavedInvestigationState = ReturnType<typeof useSavedInvestigationState>;
