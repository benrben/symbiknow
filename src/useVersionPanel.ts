import { useEffect } from 'react';
import { api } from './api';
import { failureMessage, versionBase, type VersionPanelProps, type VersionStatus } from './version-panel-types';
import { useVersionState } from './useVersionState';
import { useVersionPreview } from './useVersionPreview';
import { useVersionMutations } from './useVersionMutations';

export function useVersionPanel(props: VersionPanelProps) {
  const state = useVersionState(props.initialRevision);
  const base = versionBase(props);
  const { setLoadingStatus, setStatus, setError } = state;
  async function refreshStatus() {
    const isOwner = state.owner();
    setLoadingStatus(true);
    try {
      const next = await api<VersionStatus>(base);
      if (isOwner()) {
        setStatus(next);
        setError('');
      }
    } catch (reason) {
      if (isOwner()) setError('Could not load saved history: ' + failureMessage(reason));
    } finally {
      if (isOwner()) setLoadingStatus(false);
    }
  }
  useEffect(() => { void refreshStatus(); }, [base]);
  const preview = useVersionPreview(base, state);
  const mutations = useVersionMutations(props, base, state);
  const otherBranches = state.status?.branches.filter(branch => branch !== state.status!.current) ?? [];
  const target = state.selected && otherBranches.includes(state.selected) ? state.selected : otherBranches[0];
  return { ...props, ...state, ...preview, ...mutations, refreshStatus, otherBranches, target };
}
export type VersionPanelModel = ReturnType<typeof useVersionPanel>;
