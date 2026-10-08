import { createHash } from 'node:crypto';
import type { CanvasBlock, CanvasTask } from '../../shared/types.js';
import type { JevAction, JevActionRequest, JevJob, JevSourceSnapshot, JevValues, JevVocabularyTerm, JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import { ApiError } from '../errors.js';
import { JevWorkspaceFiles } from './workspace.js';
import { hasPendingCanvasFollowup, hasPendingSourceFollowup } from './runtime-followup-pending.js';
import { sourceSnapshot } from './stamps.js';
import { OrganizationDocumentProjection, organizationOwnership } from './followup-document-inputs.js';
import { projectedOrganizationTask } from './followup-task-inputs.js';
import { organizationVocabulary } from './followup-vocabulary-inputs.js';
import { applyJevFollowupAdmission, matchesJevFollowupAdmission, type JevFollowupAdmission } from './runtime-followup-admission.js';

type ChainedJob = JevJob & { followupActions?: JevAction[]; followupKey?: string; followupSources?: JevSourceSnapshot[] };
type OrganizationDocument = { canvasId: string; block: CanvasBlock };
type OrganizationContext = { key: string; documents: OrganizationDocument[] };
type ReadOrganizationContext = (state: JevWorkspaceState) => Promise<OrganizationContext>;
type NativeGroup = { id: string; name: string; definition?: string; purpose?: string };
export const JEV_ORGANIZATION_VERSION = 'automatic-knowledge-22';
const automaticActions: JevAction[] = ['label', 'link', 'flag_duplicate', 'file', 'suggest_home_canvas'];

function documentInputs(block: CanvasBlock) {
  return { id: block.id, title: block.title, incarnation: block.incarnation, sourceGeneration: block.sourceGeneration,
    contentHash: block.contentHash, group: block.group, tags: block.tags, purpose: block.purpose, workArea: block.workArea,
    links: block.links, linkTypes: block.linkTypes, crossLinks: block.crossLinks, reviewer: block.reviewer,
    stale: block.stale, archived: block.archived, processingExcluded: block.processingExcluded,
    ownership: organizationOwnership(block.jevOwnership), headline: block.headline, freshness: block.freshness, quality: block.quality?.score };
}

function taskInputs(task: CanvasTask) {
  return { id: task.id, revision: task.revision, title: task.title, detail: task.detail, status: task.status,
    assignee: task.assignee, reviewer: task.reviewer, priority: task.priority, acceptanceCriteria: task.acceptanceCriteria,
    dueDate: task.dueDate, dependsOnTaskIds: task.dependsOnTaskIds, blockIds: task.blockIds, findingRef: task.findingRef,
    comments: task.comments.map(({ author, text }) => ({ author, text })) };
}

function vocabularyInputs(term: JevVocabularyTerm) {
  return { id: term.id, kind: term.kind, name: term.name, parentId: term.parentId, groupKey: term.groupKey,
    definition: term.definition, aliases: term.aliases.slice().sort(), state: term.state };
}

function selectedDocuments(documents: OrganizationDocument[], request: JevActionRequest): OrganizationDocument[] {
  const allowed = documents.filter(document => !document.block.processingExcluded);
  const ids = request.blockIds;
  if (ids?.length) return allowed.filter(document => ids.includes(document.block.id));
  return allowed.filter(document => document.canvasId === request.canvasId);
}

function completedOrganization(state: JevWorkspaceState, documents: OrganizationDocument[], key: string): boolean {
  return documents.every(({ canvasId, block }) => state.profiles[`${canvasId}:${block.id}`]?.organizationContextKey === key);
}

function currentOriginalSource(document: OrganizationDocument, originals?: JevSourceSnapshot[]): boolean {
  if (!originals) return true;
  const source = originals.find(item => item.blockId === document.block.id);
  if (!source) return false;
  return source.incarnation === document.block.incarnation && source.sourceGeneration === document.block.sourceGeneration
    && source.contentHash === document.block.contentHash;
}

function retryDeadline(state: JevWorkspaceState, documents: OrganizationDocument[], contextKey: string): string | undefined {
  const profiles = documents.map(({ canvasId, block }) => state.profiles[`${canvasId}:${block.id}`]);
  return profiles.filter(profile => profile?.organizationFailedContextKey === contextKey)
    .map(profile => String(profile.organizationRetryAt)).sort().at(-1);
}

function waitingForRetry(deadline: string | undefined): boolean {
  return deadline !== undefined && Date.parse(deadline) > Date.now();
}

function chainKey(request: JevActionRequest, contextKey: string, deadline: string | undefined): string {
  return `${request.idempotencyKey ?? 'automatic'}:${contextKey}${deadline ? `:retry:${deadline}` : ''}`;
}

function resumedChainKey(state: JevWorkspaceState, baseKey: string): string {
  const cancelled = (state.jobs as ChainedJob[]).filter(job => job.state === 'cancelled'
    && (job.followupKey === baseKey || job.followupKey?.startsWith(`${baseKey}:resume:`)));
  if (!cancelled.length) return baseKey;
  const previous = cancelled.map(job => job.id).sort().join(':');
  return `${baseKey}:resume:${createHash('sha256').update(previous).digest('hex').slice(0, 12)}`;
}

function finishedCheckpoint(state: JevWorkspaceState, documents: OrganizationDocument[], key: string, contextKey: string): boolean {
  return documents.every(({ canvasId, block }) => {
    const profile = state.profiles[`${canvasId}:${block.id}`];
    return profile?.organizationKey === key && [profile.organizationContextKey, profile.organizationFailedContextKey].includes(contextKey);
  });
}

function checkpoint(profile: JevValues | undefined, key: string, contextKey: string, failed: boolean): JevValues {
  const next: JevValues = { ...profile, organizationKey: key };
  if (failed) {
    delete next.organizationContextKey;
    return { ...next, organizationFailedContextKey: contextKey, organizationRetryAt: new Date(Date.now() + 60_000).toISOString() };
  }
  delete next.organizationFailedContextKey; delete next.organizationRetryAt;
  return { ...next, organizationContextKey: contextKey };
}

function liveFrontierState(state: JevWorkspaceState, liveJob: (jobId: string) => boolean): JevWorkspaceState {
  const jobs = (state.jobs as ChainedJob[]).filter(job => job.followupKey && ['completed', 'failed'].includes(job.state) && liveJob(job.id));
  return { ...state, jobs: jobs.map(job => ({ ...job, state: 'running' as const })) };
}

/** Each dependent takes a new canonical snapshot after the previous checked action commits. */
export class JevFollowupQueue {
  constructor(private readonly store: CanvasStore, private readonly files: JevWorkspaceFiles,
    private readonly enqueue: (workspaceId: string, request: JevActionRequest, admission?: JevFollowupAdmission) => Promise<JevJob>,
    private readonly liveJob: (jobId: string) => boolean = () => false) {}

  private async context(workspaceId: string, state: JevWorkspaceState): Promise<OrganizationContext> {
    const projection = new OrganizationDocumentProjection(state);
    const workspace = (await this.store.listWorkspaces()).find(item => item.id === workspaceId);
    if (!workspace) throw new ApiError(404, 'Workspace not found');
    const canvases = await Promise.all(workspace.canvases.slice().sort((a, b) => a.id.localeCompare(b.id)).map(async summary => {
      const [canvas, tasks] = await Promise.all([this.store.getCanvas(summary.id, true, false), this.store.listTasks(summary.id)]);
      return { id: canvas.id, name: canvas.name, blocks: canvas.blocks.slice().sort((a, b) => a.id.localeCompare(b.id)),
        groups: (summary as { groups?: NativeGroup[] }).groups,
        tasks: tasks.slice().sort((a, b) => a.id.localeCompare(b.id)).map(task => taskInputs(projectedOrganizationTask(task, canvas.id, state))) };
    }));
    const inputs = { version: JEV_ORGANIZATION_VERSION, settings: state.settings,
      vocabulary: organizationVocabulary(state).sort((a, b) => a.id.localeCompare(b.id)).map(vocabularyInputs),
      canvases: canvases.map(canvas => ({ ...canvas, blocks: canvas.blocks.map(block => documentInputs(projection.project(canvas.id, block))) })) };
    return { key: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
      documents: canvases.flatMap(canvas => canvas.blocks.map(block => ({ canvasId: canvas.id, block }))) };
  }

  /** Planning uses one pass snapshot; enqueue and execution still reread canonical state and sources. */
  maintenancePass(workspaceId: string, state: JevWorkspaceState): (request: JevActionRequest) => Promise<void> {
    let context: Promise<OrganizationContext> | undefined;
    return request => this.queueState(workspaceId, request, state, current => context ??= this.context(workspaceId, current));
  }

  async queue(workspaceId: string, request: JevActionRequest): Promise<void> {
    return this.queueState(workspaceId, request, await this.files.read(workspaceId), state => this.context(workspaceId, state));
  }

  private async queueState(workspaceId: string, request: JevActionRequest, state: JevWorkspaceState, readContext: ReadOrganizationContext): Promise<void> {
    if (await this.pendingSource(workspaceId, state, request)) return;
    const context = await readContext(state);
    const documents = selectedDocuments(context.documents, request);
    if (!documents.length || completedOrganization(state, documents, context.key)) return;
    const deadline = retryDeadline(state, documents, context.key);
    if (waitingForRetry(deadline)) return;
    const key = resumedChainKey(state, chainKey(request, context.key, deadline));
    await this.startRoot(workspaceId, request, key);
  }

  private async pendingSource(workspaceId: string, state: JevWorkspaceState, request: JevActionRequest): Promise<boolean> {
    const frontier = liveFrontierState(state, this.liveJob);
    if (!hasPendingCanvasFollowup(state, request.canvasId) && !hasPendingCanvasFollowup(frontier, request.canvasId)) return false;
    const summary = await this.store.getCanvasSummary(request.canvasId);
    const selected = selectedDocuments(summary.blocks.map(block => ({ canvasId: summary.id, block })), request);
    const documents = await Promise.all(selected.map(document => this.store.getCanvasBlock(document.canvasId, document.block.id)));
    return documents.some(block => this.pendingSnapshot(state, frontier, sourceSnapshot(workspaceId, request.canvasId, block)));
  }

  private pendingSnapshot(state: JevWorkspaceState, frontier: JevWorkspaceState, source: JevSourceSnapshot): boolean {
    return hasPendingSourceFollowup(state, source) || hasPendingSourceFollowup(frontier, source);
  }

  private async startRoot(workspaceId: string, request: JevActionRequest, key: string): Promise<void> {
    const [action, ...remaining] = automaticActions;
    const job = await this.files.serial(workspaceId, async () => {
      if (await this.pendingSource(workspaceId, await this.files.read(workspaceId), request)) return undefined;
      return this.admitStep(workspaceId, request, action, remaining, key);
    });
    if (job && ['completed', 'failed'].includes(job.state)) await this.resume(workspaceId, request, remaining, key);
  }

  private async complete(workspaceId: string, request: JevActionRequest, key: string): Promise<void> {
    await this.files.serial(workspaceId, async () => {
      const state = await this.files.read(workspaceId);
      if (await this.checkpointInside(workspaceId, state, request, key)) await this.files.write(workspaceId, state);
    });
  }

  /** The document runner commits this checkpoint together with its final action outcomes. */
  async checkpointInside(workspaceId: string, state: JevWorkspaceState, request: JevActionRequest, key: string): Promise<boolean> {
    const context = await this.context(workspaceId, state);
    const originals = (state.jobs as ChainedJob[]).find(job => job.followupKey === key)?.followupSources;
    const documents = selectedDocuments(context.documents, request).filter(document => currentOriginalSource(document, originals));
    if (finishedCheckpoint(state, documents, key, context.key)) return false;
    const failed = (state.jobs as ChainedJob[]).some(job => job.followupKey === key && job.state === 'failed');
    for (const { canvasId, block } of documents) {
      const profileKey = `${canvasId}:${block.id}`;
      state.profiles[profileKey] = checkpoint(state.profiles[profileKey], key, context.key, failed);
    }
    return true;
  }

  /** An exhausted provider failure checkpoints the chain without advancing dependents. */
  async fail(workspaceId: string, request: JevActionRequest, key: string): Promise<void> {
    await this.complete(workspaceId, request, key);
  }

  async resume(workspaceId: string, request: JevActionRequest, actions: JevAction[], key: string): Promise<void> {
    const retained = actions.filter(action => automaticActions.includes(action));
    if (!retained.length) { await this.complete(workspaceId, request, key); return; }
    const [action, ...remaining] = retained;
    const job = await this.files.serial(workspaceId, () => this.admitStep(workspaceId, request, action, remaining, key));
    if (job.state === 'completed' || job.state === 'failed') await this.resume(workspaceId, request, remaining, key);
  }

  private async admitStep(workspaceId: string, request: JevActionRequest, action: JevAction, remaining: JevAction[], key: string): Promise<ChainedJob> {
      const admission = { key, remaining };
      const queued = await this.enqueue(workspaceId, { action, canvasId: request.canvasId, blockIds: request.blockIds,
        idempotencyKey: `${key}:${action}` }, admission);
      if (matchesJevFollowupAdmission(queued, admission)) return queued;
      const state = await this.files.read(workspaceId);
      const stored = state.jobs.find(item => item.id === queued.id) as ChainedJob;
      if (applyJevFollowupAdmission(state, stored, admission)) await this.files.write(workspaceId, state);
      return stored;
  }
}
