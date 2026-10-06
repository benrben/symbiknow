import type { SavedInvestigationsProps } from './saved-investigation-types';
import { useSavedInvestigationState } from './useSavedInvestigationState';
import { useSavedInvestigationList } from './useSavedInvestigationList';
import { useSavedInvestigationOpen } from './useSavedInvestigationOpen';
import { useSavedInvestigationSave } from './useSavedInvestigationSave';
import { useSavedInvestigationSources } from './useSavedInvestigationSources';

export function useSavedInvestigations(props: SavedInvestigationsProps) {
  const state = useSavedInvestigationState(props.workspaceId);
  const refresh = useSavedInvestigationList(props.workspaceId, state);
  const opening = useSavedInvestigationOpen(props, state);
  const save = useSavedInvestigationSave(props, state, refresh);
  const sources = useSavedInvestigationSources(state.selected);
  function newInvestigation() {
    state.newInvestigation(props.onClearSelection);
  }
  return { ...props, ...state, ...opening, ...sources, refresh, save, newInvestigation };
}
export type SavedInvestigationsModel = ReturnType<typeof useSavedInvestigations>;
