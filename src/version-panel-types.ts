import type { CanvasBlock } from '../shared/types';

export type Commit = { id: string; parents: string[]; message: string; createdAt: string; author?: string };
export type VersionStatus = { current: string; branches: string[]; commits: Commit[] };
export type VersionAction = { kind: 'switch' | 'merge' | 'restore'; value: string; label: string };
export type VersionPreview = { before: string; after: string; scope: string; revision?: Commit | string };
export type VersionPanelProps = { canvasId: string; block: CanvasBlock; initialRevision?: string; onChanged: () => Promise<void> };
export function versionBase({ canvasId, block }: VersionPanelProps) {
  return '/canvases/' + encodeURIComponent(canvasId) + '/blocks/' + encodeURIComponent(block.id) + '/versions';
}
export const failureMessage = (reason: unknown) => reason instanceof Error ? reason.message : 'Could not change history. Try again.';
