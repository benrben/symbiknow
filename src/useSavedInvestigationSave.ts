import type { FormEvent } from 'react';
import { api } from './api';
import { errorText, savedKeys, storeKey } from './saved-investigation-keys';
import { investigationData, saveLimitError } from './saved-investigation-input';
import type { SavedInvestigationsProps, SavedResult } from './saved-investigation-types';
import type { SavedInvestigationState } from './useSavedInvestigationState';

function retainKey(result: SavedResult, visibility: 'private' | 'shared'): string {
  if (!result.accessKey && visibility !== 'shared') return '';
  try {
    storeKey(result.investigation.id, result.accessKey);
    return '';
  }
  catch (reason) {
    if (result.accessKey) return result.accessKey;
    // Removing an obsolete key is secondary to a successful shared save.
    console.error('Could not remove the obsolete investigation access key.', reason);
    return '';
  }
}
function saveRequest(props: SavedInvestigationsProps, state: SavedInvestigationState) {
  const data = investigationData(props, state.title, state.visibility);
  if (!state.selected) return api<SavedResult>('/investigations', { method: 'POST', body: JSON.stringify({ workspaceId: props.workspaceId, ...data }) });
  const oldKey = savedKeys()[state.selected.id];
  return api<SavedResult>('/investigations/' + encodeURIComponent(state.selected.id), {
    method: 'PATCH',
    headers: oldKey ? { 'x-investigation-key': oldKey } : {}, body: JSON.stringify({ ...data, expectedRevision: state.selected.revision })
  });
}
function maySave(state: SavedInvestigationState) { return !!state.title.trim() && !state.busy; }
function completeSave(result: SavedResult, props: SavedInvestigationsProps, state: SavedInvestigationState, isOwner: () => boolean): boolean {
  const { setSelected, setUnreadableKey, setReceipt } = state;
  if (!isOwner()) {
    // Navigation must not discard the only access key for a completed private save.
    const unreadableKey = retainKey(result, state.visibility);
    if (unreadableKey) console.error('Could not retain the completed investigation access key after navigation.');
    return false;
  }
  setSelected(result.investigation);
  props.onSaved?.(result.investigation);
  setUnreadableKey(retainKey(result, state.visibility));
  setReceipt('Saved ' + result.investigation.title + ' (' + state.visibility + ').');
  return true;
}
async function completeAndRefresh(result: SavedResult, props: SavedInvestigationsProps, state: SavedInvestigationState, isOwner: () => boolean, refresh: () => Promise<void>) {
  if (completeSave(result, props, state, isOwner)) await refresh();
}
export function useSavedInvestigationSave(props: SavedInvestigationsProps, state: SavedInvestigationState, refresh: () => Promise<void>) {
  const { setBusy, setError, setReceipt, setUnreadableKey } = state;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!maySave(state)) return;
    const validation = saveLimitError(props);
    if (validation) {
      setError(validation);
      return;
    }
    const isOwner = state.owner();
    setBusy(true);
    setError('');
    setReceipt('');
    setUnreadableKey('');
    try {
      const result = await saveRequest(props, state);
      await completeAndRefresh(result, props, state, isOwner, refresh);
    } catch (reason) {
      if (isOwner()) setError('Could not save investigation: ' + errorText(reason) + ' Refresh and reopen it before retrying.');
    } finally { if (isOwner()) setBusy(false); }
  }
  return save;
}
