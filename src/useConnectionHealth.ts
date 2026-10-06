import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceSummary } from '../shared/types';
import { api } from './api';
import type { McpInfo } from './connection-types';

export function useConnectionHealth() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [infoError, setInfoError] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [workspaceError, setWorkspaceError] = useState('');
  const loadInfo = useCallback(async () => {
    setInfoError('');
    try { setInfo(await api<McpInfo>('/mcp/info')); }
    catch (failure) { setInfo(null); setInfoError(failure instanceof Error ? failure.message : 'Connection health is unavailable.'); }
  }, []);
  useEffect(() => { void loadInfo(); }, [loadInfo]);
  const loadWorkspaces = useCallback(async () => {
    setWorkspaceError('');
    try { setWorkspaces(await api<WorkspaceSummary[]>('/workspaces')); }
    catch (failure) { setWorkspaces(null); setWorkspaceError(failure instanceof Error ? failure.message : 'Could not load canvases.'); }
  }, []);
  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);
  return { info, infoError, workspaces, workspaceError, loadInfo, loadWorkspaces };
}
