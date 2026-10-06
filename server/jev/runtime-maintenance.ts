import { createHash } from 'node:crypto';
import type { CanvasBlock, WorkspaceSummary } from '../../shared/types.js';
import type { JevActionRequest, JevJob, JevSourceSnapshot, JevValues, JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import { JevWorkspaceFiles } from './workspace.js';
import { JevProposalExecutor } from './proposals.js';
import { JevFollowupQueue, JEV_ORGANIZATION_VERSION } from './followups.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import { sourceSnapshot } from './stamps.js';
import { processingPolicyKey } from './runtime-guards.js';
import { recoverParentUndos } from './parent-undo.js';
import { pruneJevWorkspace } from './lifecycle.js';
import type { JevStoreEvent } from './events.js';
import { cancelJevJob, pendingJob } from './runtime-controls.js';
import { reconcileApprovedOwnership } from './approval-origin.js';
import { reconcileHeadlineSuggestions } from './runtime-proposals.js';
import { actionConfidenceThreshold } from './automatic-policy.js';
import { recoverJevResetInside } from './reset.js';
import { hasPendingSourceFollowup } from './runtime-followup-pending.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';
import type { StoredJevJob } from './runtime-queue.js';
import { checkDocumentSources, type DocumentJob } from './runtime-document.js';

type Enqueue = (workspaceId: string, request: JevActionRequest) => Promise<JevJob>;
type QueueFollowup = (request: JevActionRequest) => Promise<void>;
type EnqueueProfiles = (workspaceId: string, requests: JevActionRequest[]) => Promise<{ jobs: JevJob[]; full: boolean }>;
type BackfillPass = { state: JevWorkspaceState; now: Date; queueFollowup: QueueFollowup; queueProfile: QueueFollowup; deferCompletedRechecks: boolean; completedRechecks: JevActionRequest[] };
const automaticFingerprint = principalFingerprint(automationPrincipal);
const sourceIdentity = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'] as const;
function sourceKey(state: JevWorkspaceState, source: JevSourceSnapshot): string {
  const policy = createHash('sha256').update(processingPolicyKey(state)).digest('hex').slice(0, 12);
  return `source:${source.canvasId}:${source.blockId}:${source.incarnation}:${source.sourceGeneration}:${JEV_QUESTION_VERSION}:${JEV_ORGANIZATION_VERSION}:${policy}`;
}
function currentProfile(state: JevWorkspaceState, source: JevSourceSnapshot): boolean {
  const profile = state.profiles[`${source.canvasId}:${source.blockId}`];
  const threshold = actionConfidenceThreshold(state.settings, 'profile');
  return matchingProfileSource(profile, source) && profile?.questionVersion === JEV_QUESTION_VERSION
    && profile?.profileConfidenceThreshold === threshold;
}
function matchingProfileSource(profile: JevValues | undefined, source: JevSourceSnapshot): boolean {
  const previous = profile?.source as Record<string, unknown> | undefined;
  return previous?.incarnation === source.incarnation && previous.sourceGeneration === source.sourceGeneration
    && previous.contentHash === source.contentHash;
}
function enabled(state: JevWorkspaceState): boolean {
  return state.settings.externalProcessing && !state.settings.paused && state.settings.modes.profile !== 'off';
}
function previousProfileJob(state: JevWorkspaceState, baseKey: string): JevJob | undefined {
  return state.jobs.filter(job => job.request.action === 'profile' && (job.request.idempotencyKey === baseKey || job.request.idempotencyKey?.startsWith(`${baseKey}:retry:`)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).at(0);
}
function profileRefreshIdentity(profile: JevValues | undefined): string {
  return createHash('sha256').update(String(profile?.profileEvaluationId ?? 'legacy')).digest('hex').slice(0, 12);
}
function profileOperationKey(baseKey: string, previous: JevJob | undefined, now: Date, profile: JevValues | undefined): string {
  if (previous?.state === 'cancelled') return `${baseKey}:retry:cancel:${createHash('sha256').update(previous.id).digest('hex').slice(0, 12)}`;
  if (previous?.state === 'completed') return `${baseKey}:retry:profile-cutoff:${profileRefreshIdentity(profile)}`;
  return previous?.state === 'failed' ? `${baseKey}:retry:${Math.floor(now.getTime() / 60000)}` : baseKey;
}
function mayBackfill(previous: JevJob | undefined, now: Date): boolean {
  if (previous?.state === 'completed') return true;
  if (previous && !['failed', 'cancelled'].includes(previous.state)) return false;
  if (previous?.state === 'failed' && now.getTime() - Date.parse(previous.updatedAt) < 60000) return false;
  return true;
}
function sourceProfileRequest(job: StoredJevJob): boolean {
  return job.request.action === 'profile' && job.request.query === undefined && job.request.options === undefined
    && Boolean(job.request.blockIds?.length);
}
function checkedProfileAuthorization(job: StoredJevJob): boolean {
  return job.principal?.id === automationPrincipal.id && principalFingerprint(job.principal) === automaticFingerprint
    && job.authorizationFingerprint === automaticFingerprint;
}
function pendingAutomaticProfile(job: StoredJevJob, policy: string): boolean {
  return pendingJob(job) && sourceProfileRequest(job) && checkedProfileAuthorization(job) && job.settingsKey === policy;
}
function dueDocumentRetry(job: DocumentJob, state: JevWorkspaceState, policy: string): boolean {
  const retryAt = job.documentPlan?.retryAt;
  if (!retryAt) return false;
  return job.state === 'failed' && Date.parse(retryAt) <= Date.now() && !state.settings.paused
    && job.settingsKey === policy && checkedProfileAuthorization(job);
}
async function resumeDocument(store: CanvasStore, workspaceId: string, job: DocumentJob): Promise<boolean> {
  try { await checkDocumentSources(store, workspaceId, job); }
  catch (error) {
    if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) throw error;
    delete job.documentPlan!.retryAt;
    return true;
  }
  job.state = 'queued'; job.attempts = 0; delete job.error; delete job.documentPlan!.retryAt;
  return true;
}
function checkedProfileScope(job: StoredJevJob, workspace: WorkspaceSummary): boolean {
  const selected = new Set(job.request.blockIds);
  const guarded = new Set(job.sources.map(source => source.blockId));
  return guarded.size === job.sources.length && guarded.size === selected.size && job.sources.every(source =>
    source.workspaceId === workspace.id && source.canvasId === job.request.canvasId && selected.has(source.blockId))
    && workspace.canvases.some(canvas => canvas.id === job.request.canvasId);
}
function freshProfileSource(state: JevWorkspaceState, source: JevSourceSnapshot, block: CanvasBlock): boolean {
  // getCanvasBlock rejects archived sources with 404 before this predicate.
  if (!block.incarnation || block.processingExcluded) return false;
  const current = sourceSnapshot(source.workspaceId, source.canvasId, block);
  return sourceIdentity.every(field => current[field] === source[field]) && !currentProfile(state, current);
}
function successfulOrganizationCheckpoint(state: JevWorkspaceState, source: JevSourceSnapshot): boolean {
  const profile = state.profiles[`${source.canvasId}:${source.blockId}`];
  return typeof profile.organizationKey === 'string' && profile.organizationKey.length > 0
    && typeof profile.organizationContextKey === 'string' && /^[a-f0-9]{64}$/.test(profile.organizationContextKey)
    && profile.organizationFailedContextKey === undefined;
}
async function queueOrganization(pass: BackfillPass, source: JevSourceSnapshot, request: JevActionRequest): Promise<void> {
  if (successfulOrganizationCheckpoint(pass.state, source)) { pass.completedRechecks.push(request); return; }
  await pass.queueFollowup(request);
}
export class JevRuntimeMaintenance {
  constructor(private readonly store: CanvasStore, private readonly files: JevWorkspaceFiles,
    private readonly executor: JevProposalExecutor, private readonly followups: JevFollowupQueue, private readonly enqueue: Enqueue,
    private readonly running: Map<string, AbortController>, private readonly providerAvailable: () => Promise<boolean> = async () => true,
    private readonly enqueueProfiles?: EnqueueProfiles) {}

  private async recover(workspaceId: string): Promise<void> {
    await this.files.serial(workspaceId, async () => {
      await recoverJevResetInside(this.store, this.files, workspaceId);
      await recoverParentUndos(this.store, workspaceId);
      // A prepared canonical mutation may already be saved. Complete it before
      // pruning analyses whose original source has since disappeared.
      await this.executor.recoverInside(workspaceId);
      const original = await this.files.read(workspaceId);
      if (await pruneJevWorkspace(this.store, workspaceId, original)) await this.files.write(workspaceId, original);
      await this.store.jevExecutor.serialized(() => reconcileApprovedOwnership(this.store, this.files, this.executor, workspaceId));
      const state = await this.files.read(workspaceId);
      const repairedSuggestions = reconcileHeadlineSuggestions(state);
      const resumed = await this.resumeDocuments(workspaceId, state);
      const interrupted = state.jobs.filter(job => job.state === 'running' && !this.running.has(job.id));
      for (const job of interrupted) job.state = 'queued';
      if (interrupted.length || repairedSuggestions || resumed) await this.files.write(workspaceId, state);
    });
  }

  private async resumeDocuments(workspaceId: string, state: JevWorkspaceState): Promise<boolean> {
    let changed = false;
    const policy = processingPolicyKey(state);
    for (const job of state.jobs as DocumentJob[]) {
      if (dueDocumentRetry(job, state, policy)) changed = await resumeDocument(this.store, workspaceId, job) || changed;
    }
    return changed;
  }

  private async backfill(workspaceId: string, canvasId: string, block: CanvasBlock, pass: BackfillPass): Promise<void> {
    const { state, now, queueProfile } = pass;
    if (block.processingExcluded) return;
    const source = sourceSnapshot(workspaceId, canvasId, block);
    const profiled = currentProfile(state, source);
    if (profiled && hasPendingSourceFollowup(state, source)) return;
    const baseKey = sourceKey(state, source);
    const previous = previousProfileJob(state, baseKey);
    if ((previous as DocumentJob | undefined)?.documentPlan?.retryAt) return;
    const key = profileOperationKey(baseKey, previous, now, state.profiles[`${canvasId}:${block.id}`]);
    const request: JevActionRequest = { action: 'profile', canvasId, blockIds: [block.id], idempotencyKey: key };
    if (profiled) { await queueOrganization(pass, source, request); return; }
    if (!mayBackfill(previous, now)) return;
    await queueProfile(request);
  }

  private async refill(workspaceId: string, canvasId: string, block: CanvasBlock, pass: BackfillPass): Promise<boolean> {
    try { await this.backfill(workspaceId, canvasId, block, pass); return true; }
    catch (error) { if (error instanceof ApiError && error.status === 429) return false; throw error; }
  }

  private async flushProfiles(workspaceId: string, requests: JevActionRequest[], pass: BackfillPass): Promise<boolean> {
    if (!this.enqueueProfiles || !requests.length) return false;
    const pending = requests.splice(0);
    const result = await this.files.serial(workspaceId, () => this.enqueueProfiles!(workspaceId, pending));
    pass.deferCompletedRechecks ||= result.jobs.some(pendingJob);
    return result.full;
  }

  private backfillPass(workspaceId: string, state: JevWorkspaceState, now: Date, requests: JevActionRequest[],
    deferCompletedRechecks: boolean): BackfillPass {
    const followup = this.followups.maintenancePass(workspaceId, state);
    const pass: BackfillPass = { state, now, deferCompletedRechecks, completedRechecks: [], queueProfile: async request => {
      if (this.enqueueProfiles) { requests.push(request); return; }
      const queued = await this.files.serial(workspaceId, () => this.enqueue(workspaceId, request));
      pass.deferCompletedRechecks ||= pendingJob(queued);
    }, queueFollowup: async request => {
      // Preserve source order and durable prefixes when a later ordinary followup reaches queue capacity.
      if (await this.flushProfiles(workspaceId, requests, pass)) throw new ApiError(429, 'Symbi Reflex queue is full');
      await followup(request);
    } };
    return pass;
  }

  private async finishBackfill(workspaceId: string, requests: JevActionRequest[], pass: BackfillPass): Promise<void> {
    if (await this.flushProfiles(workspaceId, requests, pass)) return;
    await this.queueCompletedRechecks(pass);
  }

  private async queueCompletedRechecks(pass: BackfillPass): Promise<void> {
    if (pass.deferCompletedRechecks) return;
    for (const request of pass.completedRechecks) {
      try { await pass.queueFollowup(request); }
      catch (error) { if (error instanceof ApiError && error.status === 429) return; throw error; }
    }
  }

  private async backlogBlock(source: JevSourceSnapshot): Promise<CanvasBlock | undefined> {
    try { return await this.store.getCanvasBlock(source.canvasId, source.blockId); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
  }

  private async freshProfileJob(workspace: WorkspaceSummary, state: JevWorkspaceState, job: StoredJevJob, policy: string): Promise<boolean> {
    if (!pendingAutomaticProfile(job, policy) || !checkedProfileScope(job, workspace)) return false;
    for (const source of job.sources) {
      const block = await this.backlogBlock(source);
      if (block && freshProfileSource(state, source, block)) return true;
    }
    return false;
  }

  /** Existing genuine initial understanding also postpones new rechecks; source scanning adds admitted replacement profiles. */
  private async hasFreshProfileBacklog(workspace: WorkspaceSummary, state: JevWorkspaceState): Promise<boolean> {
    const policy = processingPolicyKey(state);
    for (const job of state.jobs as StoredJevJob[]) if (await this.freshProfileJob(workspace, state, job, policy)) return true;
    return false;
  }

  async reconcile(workspace: WorkspaceSummary, now = new Date()): Promise<void> {
    await this.recover(workspace.id);
    const state = await this.files.read(workspace.id);
    if (!enabled(state) || !await this.providerAvailable()) return;
    const requests: JevActionRequest[] = [];
    const pass = this.backfillPass(workspace.id, state, now, requests, await this.hasFreshProfileBacklog(workspace, state));
    for (const canvas of workspace.canvases) {
      await this.store.ensureJevStamps(canvas.id);
      for (const block of (await this.store.getCanvas(canvas.id, false, false)).blocks) if (!await this.refill(workspace.id, canvas.id, block, pass)) return;
    }
    await this.finishBackfill(workspace.id, requests, pass);
  }

  async deleted(event: JevStoreEvent): Promise<void> {
    await this.files.serial(event.workspaceId, async () => {
      await this.executor.recoverInside(event.workspaceId);
      const state = await this.files.read(event.workspaceId);
      const affected = (source: JevSourceSnapshot) => source.canvasId === event.canvasId && event.blockIds.includes(source.blockId);
      for (const proposal of state.proposals.filter(proposal => proposal.state === 'pending' && proposal.sources.some(affected))) proposal.state = 'stale';
      for (const job of state.jobs.filter(job => pendingJob(job) && job.sources.some(affected))) cancelJevJob(job, this.running);
      for (const id of event.blockIds) delete state.profiles[`${event.canvasId}:${id}`];
      const jobIds = state.jobs.map(job => job.id);
      await pruneJevWorkspace(this.store, event.workspaceId, state);
      for (const id of jobIds.filter(id => !state.jobs.some(job => job.id === id))) this.running.get(id)?.abort();
      if (state.revision) await this.files.write(event.workspaceId, state);
    });
  }

}
