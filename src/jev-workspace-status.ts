import type { JevActionRequest, JevSettings, JevWorkspaceState } from '../shared/jev-types';
import type { AvatarState } from './avatar-types';
import type { JevViewState } from './jev-client-types';

export function workspaceFailure(failure: unknown, fallback: string): string { return failure instanceof Error ? failure.message : fallback; }
export function ownerWorkspaceView(value: JevViewState): JevViewState {
  if (!value?.settings?.modes || typeof value.hasApiKey !== 'boolean') throw new Error('Open Symbi Reflex with an authenticated workspace owner session.');
  return value;
}
export function skipWorkspaceRefresh(expected: string, current: string, changing: boolean, force: boolean): boolean {
  return expected !== current || (changing && !force);
}
export function changedReceipts(previous: string | undefined, current: string): boolean { return previous !== undefined && previous !== current; }
export function optimisticSettings(current: JevViewState | null, patch: Partial<JevSettings>): JevViewState | null {
  if (!current) return null;
  return { ...current, settings: { ...current.settings, ...patch, modes: { ...current.settings.modes, ...patch.modes },
    confidenceThresholds: { ...current.settings.confidenceThresholds, ...patch.confidenceThresholds } } };
}
export function operationNotice(operation: string): string {
  if (operation === 'reset') return 'Jev-generated results cleared. Automatic checks restarted across this workspace.';
  return operation === 'connection' ? 'TypeSafe connection verified. No documents were sent.' : 'Workspace settings updated.';
}
export function jevAvatarState(state: JevWorkspaceState | null, error: string): AvatarState {
  if (error) return 'unavailable';
  if (!state) return 'resting';
  if (state.settings.paused) return 'paused';
  return activeAvatar(state);
}
function activeAvatar(state: JevWorkspaceState): AvatarState {
  const running = state.jobs.find(job => job.state === 'running');
  if (running) return actionAvatar(running.request.action);
  if (state.jobs.some(job => job.state === 'queued')) return 'thinking';
  const recent = state.jobs.find(job => job.state === 'completed' && Date.now() - Date.parse(job.updatedAt) < 5000);
  return recent ? 'done' : 'resting';
}
function actionAvatar(action: JevActionRequest['action']): AvatarState {
  const states: Partial<Record<JevActionRequest['action'], AvatarState>> = { profile: 'reading', recall: 'searching',
    link: 'connecting', recheck_links: 'checking', flag_conflict: 'comparing', flag_duplicate: 'comparing',
    score_quality: 'checking' };
  return states[action] ?? 'organizing';
}
