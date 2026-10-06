import type { FormEvent } from 'react';
import { api } from './api';
import { failureMessage, type VersionAction, type VersionPanelProps, type VersionStatus } from './version-panel-types';
import type { VersionState } from './useVersionState';

type Ownership = () => boolean;
export function useVersionMutations(props: VersionPanelProps, base: string, state: VersionState) {
  const { action, preview, busy, status, name, setBusy, setError, setStatus, setReceipt, setUndoRevision, setAction, setPreview, setName } = state;
  function finish(isOwner: Ownership) {
    if (isOwner()) setBusy(false);
  }
  function failedSave(reason: unknown, isOwner: Ownership) {
    if (!isOwner()) return;
    setError('Could not confirm whether document content was saved: ' + failureMessage(reason) + ' Reload saved history and inspect the current revision before retrying.');
    setPreview(null);
  }
  async function acceptedSave(next: VersionStatus, applied: VersionAction, previousRevision: string, isOwner: Ownership) {
    if (!isOwner()) return;
    setStatus(next);
    setReceipt(applied.label + ' completed. Document content is saved on ' + next.current + ' at revision ' + (next.commits[0]?.id.slice(0, 12) ?? 'current') + '. To undo, preview the previous saved revision and restore it as a new revision.');
    setUndoRevision(previousRevision);
    setAction(null);
    setPreview(null);
    try {
      await props.onChanged();
    } catch (reason) {
      if (isOwner()) setError('Document content was saved, but the canvas did not refresh: ' + failureMessage(reason) + ' Reopen this canvas to see the saved version. Do not apply this change again.');
    }
  }
  async function apply() {
    if (!action || !preview || busy) return;
    const isOwner = state.owner();
    setBusy(true);
    setError('');
    const previousRevision = status?.commits[0]?.id ?? '';
    try {
      const payload = actionPayload(action);
      const next = await api<VersionStatus>(base + '/' + action.kind, { method: 'POST', body: JSON.stringify(payload) });
      await acceptedSave(next, action, previousRevision, isOwner);
    } catch (reason) {
      failedSave(reason, isOwner);
    } finally {
      finish(isOwner);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const isOwner = state.owner();
    setBusy(true);
    setError('');
    try {
      const next = await api<VersionStatus>(base + '/branches', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      if (!isOwner()) return;
      setStatus(next);
      setReceipt('Branch ' + name.trim() + ' created. Document content is unchanged; current branch: ' + next.current + '.');
      setName('');
    } catch (reason) {
      if (isOwner()) setError(failureMessage(reason));
    } finally {
      finish(isOwner);
    }
  }
  return { apply, create };
}

function actionPayload(action: VersionAction) {
  return action.kind === 'restore' ? { revision: action.value } : { name: action.value };
}
