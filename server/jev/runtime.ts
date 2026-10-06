import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { JevActionRequest,JevEvaluation,JevJob,JevMutation,JevPrincipal,JevProposal,JevReceipt,JevSettings,JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import type { SymbiPassage } from '../../shared/symbi-contract.js';
import { ApiError } from '../errors.js';
import type { JevDecider } from '../jev.js';
import type { CanvasStore } from '../storage.js';
import { evaluateJevAction } from './actions.js';
import type { JevEvaluationContext,JevEvaluator,JevInputDocument } from './actions/context.js';
import { withoutOriginMigrations } from './approval-origin.js';
import { readJevWorkspace } from './runtime-read.js';
import {
automationPrincipal,currentPrincipal,mutationCanvases,principalFingerprint,
publicJevJob,publicJevReceipt,
rejectRetiredTaskMutation,requireApprove,requireCanvas,requireResetOwner,requireTool,runToolNames,scopedState
} from './authorization.js';
import { updatedJevSettings,validateRequest } from './configuration.js';
import { evaluationContext } from './context.js';
import { hasActiveJevDraft,readJevDraft,setJevDraftState } from './drafts.js';
import { editQuietWindow } from './runtime-edit-window.js';
import { subscribeJevStore,type JevStoreEvent } from './events.js';
import { JevFollowupQueue } from './followups.js';
import { purgeJevOrphans } from './lifecycle.js';
import { mutationIdentity,requireCurrentMutation,validateMutation } from './mutations.js';
import { undoBrowserParent } from './parent-browser.js';
import type { JevParentUndo } from './parent-undo.js';
import { JevProposalExecutor,suppressProposal } from './proposals.js';
import { cancelDraftWork,cancelJevJob,checkDraftCancellation,checkJobCancellation,metadataOwnership,pendingJob,stopJobDraft,validateMetadataOverride } from './runtime-controls.js';
import { checkFinishingPolicy,processingPolicyKey as settingsKey } from './runtime-guards.js';
import { JevRuntimeMaintenance } from './runtime-maintenance.js';
import { currentDocumentTransport,transportDecider } from './runtime-transport.js';
import { finishFailedJob,recordJevFailure } from './runtime-failure.js';
import { attachIndexedNeighbors } from './runtime-neighbors.js';
import { admitDocumentRecheck } from './runtime-review.js';
import { resetJevWorkspaceInside,withoutJevResetJournal } from './reset.js';
import { JevReconcileQueue } from './runtime-reconcile.js';
import { JevJobScheduler, type JevQueuedCandidate } from './runtime-scheduler.js';
import { canRunJevCandidate } from './runtime-parallel-policy.js';
import { currentQueuedSources, queuedSourceRefreshEligible } from './runtime-queued-source-refresh.js';
import type { JevFollowupAdmission } from './runtime-followup-admission.js';
import { QuestionAnswerCache } from './actions/question-answer-cache.js';
import { automaticQuestionPartition,cachedQuestionContext,evaluateWithQuestionPrefetch,questionTransportChanged,shouldPrefetchQuestions } from './runtime-question-prefetch.js';
import { enqueueJevJob,readonlyActions as readActions,type StoredJevJob as StoredJob } from './runtime-queue.js';
import { enqueueJevJobs } from './runtime-queue-batch.js';
import { automaticReason, commitJevAutomatic, finishJevAction } from './runtime-action-completion.js';
import { automaticDocumentEligible, checkDocumentSources, executeAutomaticDocument, initializeDocumentPlan, type DocumentJob } from './runtime-document.js';
import { documentOperation } from './runtime-document-policy.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';
export interface JevRuntimeOptions { evaluate?: JevEvaluator; apiKey?: string; startTimer?: boolean; fetcher?: typeof fetch; decider?: JevDecider; documentExecution?: boolean; editDebounceMs?: number; durableJournal?: boolean;
  onStorageWrite?: (kind: 'checkpoint' | 'journal', bytes: number) => void;
  retrieveNeighbors?: (context: JevEvaluationContext, source: JevInputDocument) => Promise<SymbiPassage[]> }
type ExecutionResult = { candidate: JevQueuedCandidate; failed: boolean; error?: unknown };
type ActiveExecution = { candidate: JevQueuedCandidate; promise: Promise<ExecutionResult> };
const runtimes = new WeakMap<CanvasStore, JevRuntime>();
const activeRunners = new Map<string, Map<string, AbortController>>();
function sharedRunners(root: string): Map<string, AbortController> {
  root = path.resolve(root);
  let runners = activeRunners.get(root);
  if (!runners) { runners = new Map(); activeRunners.set(root, runners); }
  return runners;
}
export class JevRuntime {
  private readonly files: JevWorkspaceFiles;
  private readonly executor: JevProposalExecutor;
  private readonly evaluate: JevEvaluator;
  private readonly followupQueue: JevFollowupQueue;
  private readonly maintenance: JevRuntimeMaintenance;
  private readonly sourceReconciliation: JevReconcileQueue;
  private readonly scheduler = new JevJobScheduler();
  private readonly questionAnswers = new QuestionAnswerCache({ ttlMs: 15 * 60_000 });
  private questionTransportVersion = 0;
  private readonly questionContexts = new WeakMap<JevEvaluationContext, number>();
  private readonly contextStates = new WeakMap<JevEvaluationContext, JevWorkspaceState>();
  private readonly running = new Map<string, AbortController>();
  private readonly canonicalRunning: Map<string, AbortController>;
  private readonly workspaces = new Set<string>();
  private readonly sourceEvents = new Set<Promise<void>>();
  private readonly maintenanceEvents = new Set<Promise<void>>();
  private drainPromise?: Promise<void>;
  private drainRequested = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly ready: Promise<void>;
  private closed = false;
  constructor(private readonly store: CanvasStore, private readonly options: JevRuntimeOptions = {}) {
    this.canonicalRunning = sharedRunners(store.root);
    this.sourceReconciliation = new JevReconcileQueue(workspaceId => this.reconcile(workspaceId));
    this.files = new JevWorkspaceFiles(store.root, { journalWrites: options.durableJournal ?? process.env.SYMBI_JEV_JOURNAL === '1',
      onStorageWrite: options.onStorageWrite });
    this.executor = new JevProposalExecutor(store, this.files);
    this.followupQueue = new JevFollowupQueue(store, this.files,
      (workspaceId, request, admission) => this.enqueueInside(workspaceId, request, automationPrincipal, admission), id => this.canonicalRunning.has(id));
    this.maintenance = new JevRuntimeMaintenance(store, this.files, this.executor, this.followupQueue,
      (workspaceId, request) => this.enqueueInside(workspaceId, request, automationPrincipal), this.canonicalRunning,
      () => this.providerAvailable(), (workspaceId, requests) =>
        enqueueJevJobs(this.store, this.files, this.executor, workspaceId, requests, automationPrincipal));
    this.evaluate = options.evaluate ?? evaluateJevAction;
    subscribeJevStore(store, event => {
      const pending = this.saved(event); this.sourceEvents.add(pending);
      void pending.finally(() => this.sourceEvents.delete(pending)).catch(() => undefined);
      return pending;
    });
    this.ready = this.reconcile();
    void this.ready.catch(() => console.error('Symbi Reflex startup requires recovery; ordinary knowledge remains available.'));
    if (options.startTimer !== false) {
      this.timer = setInterval(() => { void this.tick().catch(() => console.error('Symbi Reflex maintenance needs Retry.')); }, 60000);
      this.timer.unref();
    }
  }

  async read(workspaceId: string, supplied: JevPrincipal = automationPrincipal, summary = false): Promise<JevWorkspaceState> {
    await this.requireWorkspace(workspaceId);
    const principal = await currentPrincipal(this.store, supplied);
    // Atomic workspace snapshots stay readable while recovery and automatic work hold mutation queues.
    return readJevWorkspace(this.files, workspaceId, principal, summary);
  }

  async configure(workspaceId: string, patch: Partial<JevSettings>, supplied: JevPrincipal): Promise<JevWorkspaceState> {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied);
    if (!principal.canConfigure || principal.kind !== 'user') throw new ApiError(403, 'Workspace owner authorization is required');
    await this.requireWorkspace(workspaceId);
    const result = await this.files.serial(workspaceId, async () => {
      const state = await this.files.read(workspaceId);
      const next = updatedJevSettings(state.settings, patch);
      const policyChanged = settingsKey(state) !== settingsKey({ ...state, settings: next });
      state.settings = next;
      if (policyChanged) for (const job of state.jobs.filter(pendingJob)) cancelJevJob(job, this.canonicalRunning);
      await this.files.write(workspaceId, state);
      return withoutOriginMigrations(scopedState(withoutJevResetJournal(state), principal));
    });
    if (result.settings.externalProcessing && !result.settings.paused) await this.reconcile(workspaceId);
    return result;
  }

  async reset(workspaceId: string, supplied: JevPrincipal): Promise<JevWorkspaceState> {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied);
    requireResetOwner(principal);
    await this.requireWorkspace(workspaceId);
    if (process.env.SYMBI_NO_PROVIDER_CALLS === '1') throw new ApiError(503, 'Jev checks are paused for this app session; saved decisions remain available');
    if (!await this.providerAvailable()) throw new ApiError(503, 'Connect a processing provider before resetting Jev');
    await this.files.serial(workspaceId, async () => {
      const state = await this.files.read(workspaceId);
      if (!state.settings.externalProcessing) throw new ApiError(503, 'Enable automatic processing before resetting Jev');
      this.questionAnswers.clear();
      for (const job of state.jobs) cancelJevJob(job, this.canonicalRunning);
      await this.files.write(workspaceId, state);
      await this.executor.recoverInside(workspaceId);
      await resetJevWorkspaceInside(this.store, this.files, workspaceId);
    });
    await this.reconcile(workspaceId);
    return this.read(workspaceId, principal);
  }

  async run(workspaceId: string, request: JevActionRequest, supplied: JevPrincipal): Promise<JevJob> {
    await this.ready;
    validateRequest(request);
    const principal = await currentPrincipal(this.store, supplied);
    requireTool(principal, runToolNames(request));
    requireCanvas(principal, request.canvasId);
    if (principal.access === 'read' && !readActions.includes(request.action)) throw new ApiError(403, 'This action requires a proposal grant');
    if (process.env.SYMBI_NO_PROVIDER_CALLS === '1') throw new ApiError(503, 'Jev checks are paused for this app session; saved decisions remain available');
    const job = await this.files.serial(workspaceId, () => this.enqueueInside(workspaceId, request, principal));
    this.workspaces.add(workspaceId);
    this.startDrain();
    return publicJevJob(job);
  }

  /** An explicit owner click admits one fresh six-action source checkpoint. */
  async recheckDocument(workspaceId: string, canvasId: string, blockId: string,
    expectedContentHash: string, supplied: JevPrincipal): Promise<{ jobId: string }> {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied);
    requireResetOwner(principal);
    const workspace = await this.requireWorkspace(workspaceId);
    if (!workspace.canvases.some(canvas => canvas.id === canvasId)) throw new ApiError(404, 'Canvas not found');
    const job = await this.files.serial(workspaceId, () => admitDocumentRecheck(this.store, this.files,
      workspaceId, canvasId, blockId, expectedContentHash, () => this.providerAvailable(),
      request => this.enqueueInside(workspaceId, request, automationPrincipal), `manual-recheck:${randomUUID()}`));
    this.workspaces.add(workspaceId);
    this.startDrain();
    return { jobId: job.id };
  }

  private enqueueInside(workspaceId: string, request: JevActionRequest, principal: JevPrincipal, admission?: JevFollowupAdmission): Promise<StoredJob> {
    return enqueueJevJob(this.store, this.files, this.executor, workspaceId, request, principal, admission);
  }

  private startDrain(): void {
    this.drainRequested = true;
    if (this.drainPromise || this.closed) return;
    this.drainRequested = false;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
      if (this.drainRequested) this.startDrain();
    });
    void this.drainPromise.catch(() => console.error('Symbi Reflex queue requires recovery; saved knowledge is intact.'));
  }

  private async queuedCandidates(): Promise<JevQueuedCandidate[]> {
    const candidates = await Promise.all([...this.workspaces].map(async workspaceId => ({ workspaceId, jobs: await this.files.readQueued(workspaceId) })));
    return candidates.flatMap(({ workspaceId, jobs }) => jobs
      .map(job => ({ workspaceId, job: job as StoredJob })));
  }

  private async settledExecution(candidate: JevQueuedCandidate): Promise<ExecutionResult> {
    try { await this.executeJob(candidate.workspaceId, candidate.job.id); return { candidate, failed: false }; }
    catch (error) { return { candidate, failed: true, error }; }
  }

  private async fillExecutions(active: Map<string, ActiveExecution>): Promise<void> {
    if (process.env.SYMBI_NO_PROVIDER_CALLS === '1') return;
    let candidates = await this.queuedCandidates();
    while (!this.closed && active.size < 4) {
      const occupants = [...active.values()].map(execution => execution.candidate);
      candidates = candidates.filter(candidate => !active.has(candidate.job.id));
      const next = this.scheduler.peek(candidates);
      if (!next) return;
      if (!this.canSchedule(next, occupants)) {
        candidates = candidates.filter(candidate => candidate.workspaceId !== next.workspaceId);
        continue;
      }
      this.scheduler.select([next]);
      active.set(next.job.id, { candidate: next, promise: this.settledExecution(next) });
    }
  }

  private documentOperation(job: StoredJob): boolean {
    const enabled = this.options.documentExecution ?? this.evaluate === evaluateJevAction;
    return documentOperation(job, enabled);
  }

  private canSchedule(candidate: JevQueuedCandidate, occupants: JevQueuedCandidate[]): boolean {
    const workspace = occupants.filter(item => item.workspaceId === candidate.workspaceId);
    if (workspace.length && (this.documentOperation(candidate.job) || workspace.some(item => this.documentOperation(item.job)))) return false;
    return canRunJevCandidate(candidate, occupants);
  }

  private async drain(): Promise<void> {
    const active = new Map<string, ActiveExecution>();
    const originalFailures: unknown[] = [];
    try {
      while (!this.closed) {
        await this.fillExecutions(active);
        if (!active.size) return;
        const finished = await Promise.race([...active.values()].map(execution => execution.promise));
        active.delete(finished.candidate.job.id);
        if (finished.failed) throw finished.error;
      }
    } catch (error) {
      originalFailures.push(error);
      throw error;
    } finally {
      const completed = await Promise.all([...active.values()].map(execution => execution.promise));
      const failures = completed.filter(result => result.failed).map(result => result.error);
      if (failures.length) throw new AggregateError([...originalFailures, ...failures], 'Symbi Reflex parallel work requires recovery');
    }
  }

  private async takeJob(workspaceId: string, jobId: string, controller: AbortController): Promise<StoredJob | undefined> {
    return this.files.serial(workspaceId, async () => {
      let state = await this.files.read(workspaceId);
      let stored = state.jobs.find(item => item.id === jobId) as DocumentJob | undefined;
      if (stored?.state !== 'queued') return undefined;
      if (stored.documentPlan && state.prepared.length) {
        await this.executor.recoverInside(workspaceId);
        state = await this.files.read(workspaceId);
        stored = state.jobs.find(item => item.id === jobId) as DocumentJob;
      }
      await this.refreshQueuedSources(workspaceId, state, stored, controller.signal);
      stored.state = 'running'; stored.updatedAt = new Date().toISOString(); stored.attempts += 1;
      if (this.documentOperation(stored) && automaticDocumentEligible(stored, state)) initializeDocumentPlan(stored);
      this.canonicalRunning.set(jobId, controller);
      await this.files.write(workspaceId, state);
      return structuredClone(stored);
    });
  }

  private async refreshQueuedSources(workspaceId: string, state: JevWorkspaceState, job: StoredJob, signal: AbortSignal): Promise<void> {
    if ((job as DocumentJob).documentPlan) return;
    if (!queuedSourceRefreshEligible(job)) return;
    const principal = await currentPrincipal(this.store, job.principal);
    if (principalFingerprint(principal) !== job.authorizationFingerprint) throw new ApiError(403, 'The authorization changed while the action was queued');
    requireTool(principal, runToolNames(job.request));
    if (settingsKey(state) !== job.settingsKey || state.settings.paused) throw new ApiError(409, 'The processing policy changed');
    checkFinishingPolicy(state, job, job, principal, signal);
    job.sources = await currentQueuedSources(this.store, workspaceId, job);
    checkFinishingPolicy(state, job, job, principal, signal);
  }

  private contextActivity(): 'validate' | 'include' { return this.evaluate === evaluateJevAction ? 'validate' : 'include'; }
  private async jobContext(workspaceId: string, job: StoredJob, signal: AbortSignal): Promise<JevEvaluationContext> {
    const principal = await currentPrincipal(this.store, job.principal);
    if (principalFingerprint(principal) !== job.authorizationFingerprint) throw new ApiError(403, 'The authorization changed while the action was queued');
    requireTool(principal, runToolNames(job.request));
    const state = await this.files.read(workspaceId);
    if (settingsKey(state) !== job.settingsKey || state.settings.paused) throw new ApiError(409, 'The processing policy changed');
    if (this.documentOperation(job)) await checkDocumentSources(this.store, workspaceId, job);
    else await this.store.jevExecutor.checkSources(job.sources);
    return this.contextFromState(workspaceId, state, job, principal, signal);
  }

  private async contextFromState(workspaceId: string, state: JevWorkspaceState, job: StoredJob,
    principal: JevPrincipal, signal: AbortSignal): Promise<JevEvaluationContext> {
    const context = await evaluationContext(this.store, workspaceId, state, job.request, principal, signal, { activity: this.contextActivity() });
    await attachIndexedNeighbors(context, job.request, this.options.retrieveNeighbors);
    context.apiKey = this.options.apiKey ?? (await this.store.secretSettings()).secrets?.TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY;
    context.decider = transportDecider(this.options);
    this.questionContexts.set(context, this.questionTransportVersion);
    this.contextStates.set(context, state);
    return context;
  }
  private async continueJob(workspaceId: string, job: StoredJob): Promise<void> {
    if (job.principal.id !== automationPrincipal.id) return;
    if (job.request.action === 'profile') await this.followupQueue.queue(workspaceId, { ...job.request, idempotencyKey: job.request.idempotencyKey ?? job.id });
    else if (job.followupActions) await this.followupQueue.resume(workspaceId, job.request, job.followupActions, job.followupKey!);
  }

  private evaluateJob(context: JevEvaluationContext, job: StoredJob): Promise<JevEvaluation> {
    if (this.evaluate !== evaluateJevAction) return this.evaluate(context, job.request);
    const scope = automaticQuestionPartition(context, job), partition = scope && `${this.questionContexts.get(context)}:${scope}`;
    if (!partition) return this.evaluate(context, job.request);
    if (shouldPrefetchQuestions(context, job.request)) return evaluateWithQuestionPrefetch(context, job.request, this.questionAnswers, partition);
    return this.evaluate(cachedQuestionContext(context, this.questionAnswers, partition), job.request);
  }

  private async failJob(workspaceId: string, jobId: string, error: unknown, signal: AbortSignal): Promise<void> {
    const delay = await recordJevFailure(this.files, this.store, workspaceId, jobId, error, signal);
    if (delay) { await new Promise(resolve => setTimeout(resolve, delay)); return; }
    if (signal.aborted) return;
    const failed = (await this.files.read(workspaceId)).jobs.find(job => job.id === jobId) as StoredJob | undefined;
    await finishFailedJob(error, failed,
      job => this.followupQueue.fail(workspaceId, job.request, job.followupKey!), job => this.continueJob(workspaceId, job));
  }

  private async executeJob(workspaceId: string, jobId: string): Promise<void> {
    const controller = new AbortController();
    this.running.set(jobId, controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const job = await this.takeJob(workspaceId, jobId, controller);
      if (!job) return;
      timeout = setTimeout(() => controller.abort('execution_timeout'), 15000);
      const context = await this.jobContext(workspaceId, job, controller.signal);
      if (this.documentOperation(job) && automaticDocumentEligible(job, { settings: context.settings })) {
        await this.executeDocument(workspaceId, job, context, controller.signal);
        return;
      }
      const evaluated = await this.evaluateJob(context, job);
      await this.finishJob(workspaceId, job, evaluated, context, controller.signal);
      await this.continueJob(workspaceId, job);
    } catch (error) { await this.failJob(workspaceId, jobId, error, controller.signal); }
    finally { clearTimeout(timeout); this.running.delete(jobId); if (this.canonicalRunning.get(jobId) === controller) this.canonicalRunning.delete(jobId); }
  }

  private async executeDocument(workspaceId: string, job: StoredJob, context: JevEvaluationContext, signal: AbortSignal): Promise<void> {
    context.selectiveGroupAssessment = true;
    const transportVersion = this.questionContexts.get(context)!;
    await executeAutomaticDocument({ workspaceId, job, context, state: this.contextStates.get(context), store: this.store, files: this.files, executor: this.executor,
      evaluate: async (current, actionJob) => {
        const refreshed = await currentDocumentTransport(current, this.questionContexts, transportVersion,
          this.questionTransportVersion, this.options, this.store);
        return this.evaluateJob(refreshed, actionJob);
      },
      reason: (state, proposal, current) => automaticReason(state, proposal, current, true),
      refresh: async (state, actionJob) => {
        const current = await this.contextFromState(workspaceId, state, actionJob, await currentPrincipal(this.store, job.principal), signal);
        current.selectiveGroupAssessment = true;
        return current;
      },
      checkpoint: async (state, request, key) => { await this.followupQueue.checkpointInside(workspaceId, state, request, key); },
    });
  }

  private async finishJob(workspaceId: string, job: StoredJob, evaluated: JevEvaluation,
    context: JevEvaluationContext, signal: AbortSignal): Promise<void> {
    await finishJevAction({ workspaceId, job, evaluated, context, signal, store: this.store, files: this.files, executor: this.executor,
      commitAutomatic: (id, principal) => this.commitAutomatic(workspaceId, id, job, principal, context) });
  }

  private async commitAutomatic(workspaceId: string, id: string, job: StoredJob, principal: JevPrincipal, context: JevEvaluationContext): Promise<void> {
    await commitJevAutomatic({ workspaceId, id, job, principal, context, files: this.files, executor: this.executor });
  }

  async cancel(workspaceId: string, jobId: string, supplied: JevPrincipal): Promise<void> {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied);
    requireTool(principal, ['jev_do', 'jev_propose']);
    await this.files.serial(workspaceId, async () => {
      const state = await this.files.read(workspaceId);
      const job = state.jobs.find(item => item.id === jobId) as StoredJob | undefined;
      checkJobCancellation(job, principal);
      cancelJevJob(job, this.canonicalRunning);
      await stopJobDraft(this.store, job, 'cancelled');
      await this.files.write(workspaceId, state);
    });
  }

  async apply(workspaceId: string, proposalId: string, principal: JevPrincipal): Promise<JevReceipt> {
    await this.ready;
    return this.files.serial(workspaceId, async () => {
      const proposal = (await this.files.read(workspaceId)).proposals.find(item => item.id === proposalId);
      if (proposal) await rejectRetiredTaskMutation(this.store, principal, proposal.mutation, ['jev_resolve', 'undo_jev', 'set_metadata']);
      await this.executor.recoverInside(workspaceId);
      return publicJevReceipt(await this.executor.applyInside(workspaceId, proposalId, principal));
    });
  }

  async undo(workspaceId: string, receiptId: string, principal: JevPrincipal): Promise<JevReceipt> {
    await this.ready;
    return this.files.serial(workspaceId, async () => {
      const receipt = (await this.files.read(workspaceId)).receipts.find(item => item.id === receiptId);
      if (receipt) await rejectRetiredTaskMutation(this.store, principal, receipt.after, ['jev_resolve', 'undo_jev']);
      await this.executor.recoverInside(workspaceId);
      return publicJevReceipt(await this.executor.undoInside(workspaceId, receiptId, principal));
    });
  }

  async readDraft(workspaceId: string, canvasId: string, blockId: string, supplied: JevPrincipal) {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied); requireCanvas(principal, canvasId);
    const canvas = await this.store.getCanvas(canvasId, true);
    if (canvas.workspaceId !== workspaceId || !canvas.blocks.some(block => block.id === blockId)) throw new ApiError(404, 'Draft scope not found');
    const draft = await readJevDraft(this.store.root, canvasId, blockId);
    if (principal.kind !== 'user' && draft?.actor !== principal.id) throw new ApiError(403, 'Only the initiating agent can read this draft');
    return draft ?? null;
  }

  async cancelDraft(workspaceId: string, canvasId: string, blockId: string, draftId: string, supplied: JevPrincipal): Promise<void> {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied); requireCanvas(principal, canvasId);
    const draft = await this.readDraft(workspaceId, canvasId, blockId, principal);
    checkDraftCancellation(draft, draftId, principal);
    await this.files.serial(workspaceId, async () => {
      const state = await this.files.read(workspaceId);
      cancelDraftWork(state, draftId, this.canonicalRunning);
      await setJevDraftState(this.store.root, canvasId, blockId, draft.id, 'cancelled', draft.generation);
      await this.files.write(workspaceId, state);
    });
  }

  async undoParent(workspaceId: string, canvasId: string, parent: JevParentUndo, supplied: JevPrincipal): Promise<CanvasBlock | null> {
    await this.ready;
    const result = await undoBrowserParent(this.store, workspaceId, canvasId, parent, supplied);
    if (parent.kind === 'created') await this.maintenance.deleted({ workspaceId, canvasId, blockIds: [parent.after.id], kind: 'delete', actor: supplied.id });
    return result;
  }

  async revise(workspaceId: string, proposalId: string, mutation: JevMutation, supplied: JevPrincipal): Promise<JevProposal> {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied);
    requireApprove(principal); requireTool(principal, ['jev_resolve']);
    return this.files.serial(workspaceId, async () => {
      const state = await this.files.read(workspaceId);
      const proposal = state.proposals.find(item => item.id === proposalId);
      if (!proposal || proposal.state !== 'pending') throw new ApiError(404, 'Pending proposal not found');
      requireCurrentMutation(proposal.mutation);
      requireCurrentMutation(mutation);
      for (const id of mutationCanvases(mutation)) requireCanvas(principal, id);
      validateMutation(mutation);
      if (mutationIdentity(mutation) !== mutationIdentity(proposal.mutation)) throw new ApiError(409, 'A revised proposal cannot change targets');
      if (mutation.kind === 'content') throw new ApiError(409, 'Revised source bytes require a new staged review');
      await this.store.jevExecutor.checkSources(proposal.sources);
      proposal.mutation = mutation; proposal.confidence = undefined; proposal.reviewerEdited = true;
      await this.files.write(workspaceId, state);
      return structuredClone(proposal);
    });
  }

  dismiss(workspaceId: string, proposalId: string, principal: JevPrincipal): Promise<void> { return this.resolveState(workspaceId, proposalId, principal, false); }
  suppress(workspaceId: string, proposalId: string, principal: JevPrincipal): Promise<void> { return this.resolveState(workspaceId, proposalId, principal, true); }

  private async resolveState(workspaceId: string, proposalId: string, supplied: JevPrincipal, suppress: boolean): Promise<void> {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied); requireApprove(principal); requireTool(principal, ['jev_resolve']);
    await this.files.serial(workspaceId, async () => {
      const state = await this.files.read(workspaceId);
      const proposal = state.proposals.find(item => item.id === proposalId);
      if (!proposal) throw new ApiError(404, 'Proposal not found');
      for (const id of mutationCanvases(proposal.mutation)) requireCanvas(principal, id);
      if (proposal.state !== 'pending') throw new ApiError(409, 'Proposal is no longer pending');
      proposal.state = suppress ? 'suppressed' : 'dismissed';
      if (suppress) suppressProposal(state, proposal);
      await this.files.write(workspaceId, state);
    });
  }

  async setMetadata(workspaceId: string, canvasId: string, blockId: string, patch: Record<string, unknown>, supplied: JevPrincipal): Promise<CanvasBlock> {
    await this.ready;
    const principal = await currentPrincipal(this.store, supplied); requireApprove(principal); requireCanvas(principal, canvasId);
    requireTool(principal, ['jev_resolve', 'set_metadata']);
    validateMetadataOverride(patch);
    return this.files.serial(workspaceId, async () => {
      await this.store.ensureJevStamps(canvasId);
      const canvas = await this.store.getCanvas(canvasId, true);
      if (canvas.workspaceId !== workspaceId) throw new ApiError(404, 'Canvas scope not found');
      const fields = Object.fromEntries(Object.entries(patch).filter(([key]) => !['pins', 'managed'].includes(key)));
      const ownership = metadataOwnership(canvas, blockId, patch);
      const previous = canvas.blocks.find(block => block.id === blockId)!;
      const proposal: JevProposal = { id: randomUUID(), jobId: `override:${randomUUID()}`, action: 'profile',
        title: 'Update organization preferences', explanation: 'Explicit correction and ownership choices',
        evidence: [], sources: [sourceSnapshot(workspaceId, canvasId, previous)],
        mutation: { kind: 'document', canvasId, blockId, patch: fields }, state: 'pending', createdAt: new Date().toISOString() };
      const state = await this.files.read(workspaceId); state.proposals.push(proposal); await this.files.write(workspaceId, state);
      await this.executor.applyInside(workspaceId, proposal.id, principal, false, ownership);
      return (await this.store.getCanvas(canvasId, true)).blocks.find(block => block.id === blockId)!;
    });
  }

  async reconcile(workspaceId?: string, now = new Date()): Promise<void> {
    await purgeJevOrphans(this.store, this.files);
    const workspaces = await this.store.listWorkspaces();
    for (const workspace of workspaces.filter(item => !workspaceId || item.id === workspaceId)) {
      await this.maintenance.reconcile(workspace, now);
      this.workspaces.add(workspace.id);
    }
    this.startDrain();
  }

  private async deleted(event: JevStoreEvent): Promise<void> {
    const exists = (await this.store.listWorkspaces()).some(workspace => workspace.id === event.workspaceId);
    if (exists) await this.maintenance.deleted(event);
    else {
      const state = await this.files.read(event.workspaceId);
      for (const job of state.jobs) this.canonicalRunning.get(job.id)?.abort('workspace_deleted');
      this.workspaces.delete(event.workspaceId);
    }
    await purgeJevOrphans(this.store, this.files);
  }

  private async saved(event: JevStoreEvent): Promise<void> {
    if (this.closed) return;
    await this.ready;
    if (event.kind === 'delete') await this.deleted(event);
    else if (event.actor !== automationPrincipal.id) {
      await this.sourceReconciliation.request(event.workspaceId, editQuietWindow(this.store, event, this.options.editDebounceMs ?? 150));
    }
  }

  tick(now = new Date()): Promise<void> {
    if (this.closed) return Promise.resolve();
    const pending = this.maintain(now);
    this.maintenanceEvents.add(pending);
    void pending.finally(() => this.maintenanceEvents.delete(pending)).catch(() => undefined);
    return pending;
  }

  private async maintain(now: Date): Promise<void> {
    await this.ready;
    await this.reconcile(undefined, now);
  }

  private pendingWork(): Promise<void>[] {
    return [...this.sourceEvents, ...this.maintenanceEvents, ...(this.drainPromise ? [this.drainPromise] : [])];
  }

  async idle(): Promise<void> {
    await this.ready;
    let pending = this.pendingWork();
    while (pending.length) { await Promise.all(pending); pending = this.pendingWork(); }
  }

  async shutdown(): Promise<void> {
    this.close();
    await Promise.allSettled([this.ready]);
    let pending = this.pendingWork();
    while (pending.length) { await Promise.allSettled(pending); pending = this.pendingWork(); }
  }
  hasActiveDraft(canvasId: string, blockId: string): Promise<boolean> { return hasActiveJevDraft(this.store.root, canvasId, blockId); }
  close(): void { this.closed = true; this.questionAnswers.clear(); if (this.timer) clearInterval(this.timer); for (const controller of this.running.values()) controller.abort('shutdown'); }
  useTransport(options: Pick<JevRuntimeOptions, 'fetcher' | 'apiKey' | 'decider'>): void { if (questionTransportChanged(this.options, options)) { this.questionTransportVersion += 1; this.questionAnswers.clear(); } Object.assign(this.options, options); }
  private async providerAvailable(): Promise<boolean> {
    if (process.env.SYMBI_NO_PROVIDER_CALLS === '1') return false;
    return Boolean(this.options.apiKey || (await this.store.secretSettings()).secrets?.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY);
  }
  private async requireWorkspace(id: string) {
    const workspace = (await this.store.listWorkspaces()).find(item => item.id === id);
    if (!workspace) throw new ApiError(404, 'Workspace not found');
    return workspace;
  }
}

export function getJevRuntime(store: CanvasStore, options?: JevRuntimeOptions): JevRuntime {
  const existing = runtimes.get(store);
  if (existing) { if (options) existing.useTransport(options); return existing; }
  const runtime = new JevRuntime(store, options);
  runtimes.set(store, runtime);
  return runtime;
}
