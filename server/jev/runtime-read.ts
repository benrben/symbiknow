import type { JevPrincipal, JevWorkspaceState } from '../../shared/jev-types.js';
import { withoutOriginMigrations } from './approval-origin.js';
import { scopedState } from './authorization.js';
import { compactJevState } from './compact-state.js';
import { withoutJevResetJournal } from './reset.js';
import type { JevWorkspaceFiles } from './workspace.js';

/** Only unrestricted owners can use the public progress projection; narrower grants still scope the full snapshot. */
export async function readJevWorkspace(files: JevWorkspaceFiles, workspaceId: string,
  principal: JevPrincipal, summary: boolean): Promise<JevWorkspaceState> {
  if (summary && principal.kind === 'user' && principal.allowedCanvasIds === undefined) {
    const progress = await files.readProgress(workspaceId);
    if (progress) return progress;
  }
  const state = withoutOriginMigrations(scopedState(withoutJevResetJournal(await files.read(workspaceId)), principal));
  return summary ? compactJevState(state) : state;
}
