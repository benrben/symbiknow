import { useCallback, useEffect } from 'react';
import { api } from './api';
import { savedKeys, errorText } from './saved-investigation-keys';
import type { InvestigationSummary } from './saved-investigation-types';
import type { SavedInvestigationState } from './useSavedInvestigationState';
export function useSavedInvestigationList(workspaceId: string, state: SavedInvestigationState) {
  const { requestId, setLoading, setError, setItems, isOpen } = state;
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const keys = savedKeys();
      const response = await api<{ investigations: InvestigationSummary[] }>('/investigations/list', {
        method: 'POST', body: JSON.stringify({ workspaceId, privateKeys: Object.values(keys).slice(0, 200) }),
      });
      if (id === requestId.current) setItems(response.investigations);
    } catch (reason) { if (id === requestId.current) setError('Could not list investigations: ' + errorText(reason)); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [workspaceId]);
  useEffect(() => {
    if (isOpen) void refresh();
    return () => { ++requestId.current; };
  }, [isOpen, refresh]);
  return refresh;
}
