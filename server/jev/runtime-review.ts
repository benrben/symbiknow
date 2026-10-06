import type { JevActionRequest, JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import { automationPrincipal } from './authorization.js';
import { documentActions, type DocumentJob } from './runtime-document.js';
import { pendingJob } from './runtime-controls.js';
import type { StoredJevJob } from './runtime-queue.js';
import type { JevWorkspaceFiles } from './workspace.js';

function requireAutomaticChecks(state: JevWorkspaceState): void {
  if (!state.settings.externalProcessing || state.settings.paused ||
    !documentActions.every(action => state.settings.modes[action] === 'auto')) {
    throw new ApiError(409, 'Enable automatic processing and all six checks before rechecking this document');
  }
}

function matchingRecheck(state: JevWorkspaceState, canvasId: string, blockId: string, hash: string): StoredJevJob | undefined {
  return (state.jobs as DocumentJob[]).find(job => pendingJob(job) && job.request.action === 'profile'
    && job.request.canvasId === canvasId && job.request.blockIds?.length === 1 && job.request.blockIds[0] === blockId
    && job.principal?.id === automationPrincipal.id
    && (job.documentPlan?.originalSources[0] ?? job.sources[0])?.contentHash === hash);
}

export async function admitDocumentRecheck(store: CanvasStore, files: JevWorkspaceFiles, workspaceId: string,
  canvasId: string, blockId: string, hash: string, providerAvailable: () => Promise<boolean>,
  enqueue: (request: JevActionRequest) => Promise<StoredJevJob>, key: string): Promise<StoredJevJob> {
  const block = await store.getCanvasBlock(canvasId, blockId);
  if (block.contentHash !== hash) throw new ApiError(409, 'The document changed before recheck');
  if (block.processingExcluded || block.archived) throw new ApiError(409, 'This document is excluded from automatic checks');
  if (process.env.SYMBI_NO_PROVIDER_CALLS === '1') throw new ApiError(503, 'Jev checks are paused for this app session; saved decisions remain available');
  if (!await providerAvailable()) throw new ApiError(503, 'Connect a processing provider before rechecking this document');
  const state = await files.read(workspaceId);
  requireAutomaticChecks(state);
  return matchingRecheck(state, canvasId, blockId, hash) ?? enqueue({ action: 'profile', canvasId, blockIds: [blockId], idempotencyKey: key });
}
