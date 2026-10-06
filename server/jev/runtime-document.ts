import type { JevActionRequest, JevCurrentAction, JevEvaluation, JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { jevActions } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import type { JevEvaluationContext } from './actions/context.js';
import { currentDocumentIndexes } from './document-index.js';
import { automationPrincipal, currentPrincipal, principalFingerprint } from './authorization.js';
import type { JevProposalExecutor, StoredJevReceipt } from './proposals.js';
import { advanceDocumentContext, assertDocumentContext, snapshotDocumentContext, type DocumentContextProof } from './runtime-document-context.js';
import { checkFinishingPolicy, validateJevEvaluation } from './runtime-guards.js';
import { recordJevCandidates } from './runtime-proposals.js';
import type { StoredJevJob } from './runtime-queue.js';
import { commitWorkspaceJobs, stageWorkspaceJob, type WorkspaceCompletion } from './runtime-workspace-completion.js';
import { JevWorkspaceFiles } from './workspace.js';

export const documentActions: readonly JevCurrentAction[] = ['profile', 'label', 'link', 'flag_duplicate', 'file', 'suggest_home_canvas'];
export interface JevDocumentPlan {
  version: 2; originalSources: JevSourceSnapshot[]; completedActions: JevCurrentAction[]; activeJob?: StoredJevJob;
  claimPreparedAt: string; completionPreparedAt?: string; queueWaitMs: number; retryAt?: string;
  failedAction?: JevCurrentAction; failureReason?: string;
  contextProof?: DocumentContextProof;
}
export type DocumentJob = StoredJevJob & { documentPlan?: JevDocumentPlan };
export interface DocumentExecution {
  workspaceId: string; job: StoredJevJob; context: JevEvaluationContext;
  state?: JevWorkspaceState;
  store: CanvasStore; files: JevWorkspaceFiles; executor: JevProposalExecutor;
  evaluate: (context: JevEvaluationContext, job: StoredJevJob) => Promise<JevEvaluation>;
  reason: (state: JevWorkspaceState, proposal: JevProposal, context: JevEvaluationContext) => string | undefined;
  refresh: (state: JevWorkspaceState, job: StoredJevJob) => Promise<JevEvaluationContext>;
  checkpoint: (state: JevWorkspaceState, request: JevActionRequest, key: string) => Promise<void>;
}

function singleDocumentProfile(job: StoredJevJob): boolean {
  return profileRequest(job.request) && job.sources.length === 1 && job.sources[0].blockId === job.request.blockIds?.[0]
    && job.sources[0].canvasId === job.request.canvasId;
}
function profileRequest(request: JevActionRequest): boolean {
  return request.action === 'profile' && request.blockIds?.length === 1 && request.query === undefined
    && request.options === undefined;
}
export function automaticDocumentEligible(job: StoredJevJob, state: Pick<JevWorkspaceState, 'settings'>): boolean {
  const fingerprint = principalFingerprint(automationPrincipal);
  return singleDocumentProfile(job) && principalFingerprint(job.principal) === fingerprint
    && job.authorizationFingerprint === fingerprint && state.settings.externalProcessing && !state.settings.paused
    && jevActions.every(action => state.settings.modes[action] === 'auto');
}

/** Persist this together with the root claim, before any provider work starts. */
export function initializeDocumentPlan(job: DocumentJob): void {
  job.documentPlan ??= { version: 2, originalSources: structuredClone(job.sources), completedActions: [],
    claimPreparedAt: new Date().toISOString(), queueWaitMs: Math.max(0, Date.parse(job.updatedAt) - Date.parse(job.createdAt)) };
  if (job.documentPlan.version !== 2) throw new ApiError(409, 'The document action plan changed');
  if (job.documentPlan.activeJob && !documentActions.includes(job.documentPlan.activeJob.request.action as JevCurrentAction)) {
    throw new ApiError(409, 'The document action plan changed');
  }
  job.documentPlan.completedActions = job.documentPlan.completedActions.filter(action => documentActions.includes(action));
  job.followupKey = `document:${job.id}`;
  job.followupSources = job.documentPlan.originalSources;
  job.followupActions = documentActions.filter(action => !job.documentPlan!.completedActions.includes(action));
}

function sameContent(left: JevSourceSnapshot, right: JevSourceSnapshot): boolean {
  return left.blockId === right.blockId && left.incarnation === right.incarnation
    && left.sourceGeneration === right.sourceGeneration && left.contentHash === right.contentHash;
}

/** Only this operation's durable receipts may advance its metadata guard after an interrupted canonical commit. */
export async function checkDocumentSources(store: CanvasStore, workspaceId: string, job: DocumentJob): Promise<void> {
  const plan = job.documentPlan;
  let sources = job.sources;
  if (plan?.activeJob) {
    const state = await new JevWorkspaceFiles(store.root).read(workspaceId);
    const ids = new Set(plan.activeJob.proposalIds);
    for (const receipt of state.receipts.filter(item => item.state === 'applied' && ids.has(item.proposalId))) {
      sources = sources.map(source => receipt.sourcesAfter.find(after => after.blockId === source.blockId) ?? source);
    }
  }
  if (plan && sources.some(source => !plan.originalSources.some(original => sameContent(original, source)))) {
    throw new ApiError(409, 'The document changed during automatic processing');
  }
  await store.jevExecutor.checkSources(sources);
  job.sources = sources;
  if (sources.length === 1) job.request = { ...job.request, canvasId: sources[0].canvasId };
}

class DocumentRunner {
  private state!: JevWorkspaceState;
  private context: JevEvaluationContext;
  private staged: WorkspaceCompletion[] = [];
  private readonly signal: AbortSignal;
  constructor(private readonly input: DocumentExecution) {
    this.context = { ...input.context, selectiveGroupAssessment: true };
    this.signal = input.context.signal ?? new AbortController().signal;
  }
  private get root(): DocumentJob { return this.state.jobs.find(job => job.id === this.input.job.id) as DocumentJob; }
  private get plan(): JevDocumentPlan { return this.root.documentPlan!; }
  private get key(): string { return `document:${this.root.id}`; }

  private async prepareRun(): Promise<void> {
    if (process.env.SYMBI_NO_PROVIDER_CALLS === '1') {
      throw new ApiError(503, 'Jev checks are paused for this app session; saved decisions remain available');
    }
    this.state = this.input.state ?? await this.input.files.read(this.input.workspaceId);
    const root = this.runningRoot();
    root.sources = this.input.job.sources;
    initializeDocumentPlan(root);
    if (!this.plan.contextProof && this.plan.completedActions.length) throw new ApiError(409, 'The saved document context requires a fresh review');
    this.plan.contextProof ??= snapshotDocumentContext(this.context);
    assertDocumentContext(this.expectedContext(), this.context);
    this.frontier();
  }
  private runningRoot(): DocumentJob {
    const root = this.root;
    if (!root || root.state !== 'running') throw new ApiError(409, 'The document operation is no longer running');
    return root;
  }
  async run(): Promise<void> {
    await this.prepareRun();
    if (this.plan.activeJob) await this.finishCanonical(this.plan.activeJob);
    await this.runActions();
    await this.complete();
  }
  private async runActions(): Promise<void> {
    for (const action of documentActions) {
      if (this.plan.completedActions.includes(action)) continue;
      const job = this.actionJob(action);
      const evaluated = await this.evaluate(job);
      await this.accept(job, evaluated);
    }
  }

  private frontier(): void { this.root.followupActions = documentActions.filter(action => !this.plan.completedActions.includes(action)); }
  private protectedFiling(job: StoredJevJob): JevEvaluation | undefined {
    if (job.request.action !== 'file') return undefined;
    const source = this.context.documents.find(document => document.canvasId === job.request.canvasId
      && document.block.id === job.request.blockIds?.[0]);
    const ownership = source?.block.jevOwnership;
    if (!source || !ownership || (ownership.managed.includes('group') && !ownership.pins.includes('group'))) return undefined;
    const reason = 'A field is pinned or managed manually';
    return { proposals: [], result: { status: 'no_change', reason, documents: { [source.block.id]: {
      status: 'no_change', reason, source: { ...source.snapshot } } } } };
  }
  private async evaluate(job: StoredJevJob): Promise<JevEvaluation> {
    // The automatic runner cannot change protected grouping; explicit filing still uses the ordinary evaluator.
    const protectedResult = this.protectedFiling(job);
    if (protectedResult) return protectedResult;
    try { return await this.input.evaluate(this.context, job); }
    catch (error) {
      if (this.signal.aborted) throw error;
      await this.input.files.serial(this.input.workspaceId, () => this.persistFailure(job, error));
      throw error;
    }
  }
  private async persistFailure(job: StoredJevJob, error: unknown): Promise<void> {
    if (this.signal.aborted) throw error;
    this.plan.failedAction = job.request.action as JevCurrentAction;
    this.plan.failureReason = error instanceof ApiError ? error.message : 'Automatic document processing was interrupted';
    if (job.id !== this.root.id) {
      this.state.jobs = this.state.jobs.filter(item => item.id !== job.id);
      this.state.jobs.push({ ...job, state: 'failed', error: this.plan.failureReason, updatedAt: new Date().toISOString() });
    }
    this.root.state = 'running';
    await this.flush();
  }
  private actionJob(action: JevCurrentAction): StoredJevJob {
    if (action === 'profile') return this.root;
    const source = this.context.documents.find(document => document.block.id === this.root.request.blockIds![0]);
    if (!source || !this.plan.originalSources.some(original => sameContent(original, source.snapshot))) {
      throw new ApiError(409, 'The document changed during automatic processing');
    }
    return { ...this.root, documentPlan: undefined, id: `${this.root.id}:${action}`, state: 'running', sources: [source.snapshot],
      request: { action, canvasId: source.canvasId, blockIds: [source.block.id], idempotencyKey: `${this.key}:${action}` },
      result: undefined, error: undefined, proposalIds: [], followupActions: [], updatedAt: new Date().toISOString() } as DocumentJob;
  }

  private async checked(job: StoredJevJob): Promise<void> {
    const principal = await currentPrincipal(this.input.store, this.root.principal);
    checkFinishingPolicy(this.state, this.root, this.input.job, principal, this.signal);
    await this.input.store.jevExecutor.checkSources(job.sources);
  }
  private completion(job: StoredJevJob): WorkspaceCompletion {
    return { ...this.input, state: this.state, current: job, job, signal: this.signal, principal: this.root.principal,
      pendingDocumentRoot: job.id === this.root.id,
      validateContext: () => this.checkContext(),
      reason: proposal => this.input.reason(this.state, proposal, this.context) };
  }
  private expectedContext(): DocumentContextProof {
    const ids = new Set(this.plan.activeJob?.proposalIds ?? []);
    const receipts = this.state.receipts.filter(receipt => receipt.state === 'applied' && ids.has(receipt.proposalId));
    return advanceDocumentContext(this.plan.contextProof!, receipts as StoredJevReceipt[]);
  }
  private async checkContext(): Promise<void> {
    const fresh = await this.input.refresh(this.state, { ...this.root,
      request: { ...this.root.request, canvasId: this.root.sources[0].canvasId } });
    assertDocumentContext(this.expectedContext(), fresh);
  }
  private checkOutcome(job: StoredJevJob): void {
    if (Array.isArray(job.result?.automaticFailures) && job.result.automaticFailures.length) {
      throw new ApiError(409, 'An automatic action could not apply its checked result');
    }
  }
  private holdCanonicalCandidates(job: StoredJevJob): void {
    const proposals = job.proposalIds.map(id => this.state.proposals.find(proposal => proposal.id === id)!);
    // A definition can unblock a later filing proposal; preserve that checked application order.
    if (proposals.some(proposal => proposal.state === 'pending' && proposal.mutation.kind === 'vocabulary')) return;
    for (const proposal of proposals) {
      if (proposal.state !== 'pending' || ['derived', 'vocabulary'].includes(proposal.mutation.kind)) continue;
      const reason = this.input.reason(this.state, proposal, this.context);
      if (reason !== undefined) { proposal.state = 'dismissed'; proposal.automaticHoldReason = reason; }
    }
  }
  private remember(job: StoredJevJob): void {
    job.state = 'completed'; job.updatedAt = new Date().toISOString();
    if (job.id !== this.root.id) {
      this.state.jobs = this.state.jobs.filter(item => item.id !== job.id);
      this.state.jobs.push(job);
    }
    if (!this.plan.completedActions.includes(job.request.action as JevCurrentAction)) this.plan.completedActions.push(job.request.action as JevCurrentAction);
    this.root.state = 'running';
    delete this.plan.activeJob;
    if (this.plan.failedAction === job.request.action) { delete this.plan.failedAction; delete this.plan.failureReason; }
    this.frontier();
  }

  private async accept(job: StoredJevJob, evaluated: JevEvaluation): Promise<void> {
    await this.input.files.serial(this.input.workspaceId, async () => {
      await this.checked(job);
      const principal = await currentPrincipal(this.input.store, job.principal);
      try { validateJevEvaluation(evaluated, this.context, job.request, principal); }
      catch (error) { await this.persistFailure(job, error); throw error; }
      job.result = evaluated.result;
      recordJevCandidates(this.state, job, evaluated, this.context);
      this.holdCanonicalCandidates(job);
      const completion = this.completion(job);
      const receiptCount = this.state.receipts.length;
      if (await stageWorkspaceJob(completion)) {
        this.plan.contextProof = advanceDocumentContext(this.plan.contextProof!, this.state.receipts.slice(receiptCount) as StoredJevReceipt[]);
        this.context = { ...this.context, vocabulary: this.state.vocabulary,
          indexes: currentDocumentIndexes(this.state, this.context.documents) };
        try { this.checkOutcome(job); }
        catch (error) { await this.persistFailure(job, error); throw error; }
        this.staged.push(completion);
        this.remember(job);
        return;
      }
      // The intent and previous successful actions must survive before an external artifact changes.
      this.plan.activeJob = job.id === this.root.id ? { ...job, documentPlan: undefined } as DocumentJob : job;
      await this.flush();
    });
    if (this.plan.activeJob) await this.finishCanonical(this.plan.activeJob);
  }

  private async flush(reload = true): Promise<void> {
    if (this.staged.length) await commitWorkspaceJobs(this.staged);
    else {
      await this.input.store.jevExecutor.serialized(async () => {
        await this.checkContext();
        await this.input.files.assertUnchanged(this.input.workspaceId, this.state);
        await this.checked(this.root);
        await this.input.files.write(this.input.workspaceId, this.state);
      });
    }
    this.staged = [];
    if (reload) this.state = await this.input.files.read(this.input.workspaceId);
  }

  private async applyCanonical(job: StoredJevJob, id: string): Promise<void> {
    const proposal = this.state.proposals.find(item => item.id === id)!;
    if (proposal.state !== 'pending') return;
    const reason = this.input.reason(this.state, proposal, this.context);
    if (proposal.mutation.kind !== 'derived' && reason !== undefined) {
      proposal.automaticHoldReason = reason; proposal.state = 'dismissed';
      await this.input.files.write(this.input.workspaceId, this.state);
      return;
    }
    try { await this.input.executor.applyInside(this.input.workspaceId, id, this.root.principal, true, undefined, undefined, true,
      async () => {
        await this.checkContext();
        checkFinishingPolicy(this.state, this.root, this.input.job, await currentPrincipal(this.input.store, this.root.principal), this.signal);
      }); }
    catch (error) { await this.rejectCanonical(job, id, error); }
  }

  private async rejectCanonical(job: StoredJevJob, id: string, error: unknown): Promise<void> {
    if (!(error instanceof ApiError) || ![400, 409].includes(error.status)) throw error;
    this.state = await this.input.files.read(this.input.workspaceId);
    const rejected = this.state.proposals.find(item => item.id === id)!;
    rejected.automaticHoldReason = error.message; rejected.state = error.status === 409 ? 'stale' : 'dismissed';
    const failures = job.result?.automaticFailures;
    job.result = { ...job.result, automaticFailures: [...(Array.isArray(failures) ? failures : []), { proposalId: id, reason: error.message }] };
    this.plan.activeJob = job;
    await this.input.files.write(this.input.workspaceId, this.state);
  }

  private async finishCanonical(job: StoredJevJob): Promise<void> {
    await this.input.files.serial(this.input.workspaceId, async () => {
      await this.input.files.assertUnchanged(this.input.workspaceId, this.state);
      if (this.state.prepared.length) {
        await this.input.executor.recoverInside(this.input.workspaceId);
        this.state = await this.input.files.read(this.input.workspaceId);
      }
      checkFinishingPolicy(this.state, this.root, this.input.job, await currentPrincipal(this.input.store, this.root.principal), this.signal);
      for (const id of job.proposalIds) {
        checkFinishingPolicy(this.state, this.root, this.input.job, await currentPrincipal(this.input.store, this.root.principal), this.signal);
        await this.applyCanonical(job, id);
        this.state = await this.input.files.read(this.input.workspaceId);
      }
      const root = this.root;
      await checkDocumentSources(this.input.store, this.input.workspaceId, root);
      const refreshJob = { ...root, request: { ...root.request, canvasId: root.sources[0].canvasId } };
      const refreshed = await this.input.refresh(this.state, refreshJob);
      assertDocumentContext(this.expectedContext(), refreshed);
      this.context = { ...refreshed, selectiveGroupAssessment: true };
      this.plan.contextProof = snapshotDocumentContext(this.context);
      this.checkOutcome(job);
      if (job.id === root.id) { root.result = job.result; root.proposalIds = job.proposalIds; }
      this.remember(job.id === root.id ? root : job);
    });
  }

  private async complete(): Promise<void> {
    await this.input.files.serial(this.input.workspaceId, async () => {
      if (this.plan.activeJob || documentActions.some(action => !this.plan.completedActions.includes(action))) {
        throw new ApiError(409, 'The document operation has unfinished actions');
      }
      await this.checked(this.root);
      const request = { ...this.root.request, canvasId: this.root.sources[0].canvasId };
      await this.input.checkpoint(this.state, request, this.key);
      this.root.state = 'completed'; this.root.updatedAt = new Date().toISOString();
      delete this.root.error;
      this.plan.completionPreparedAt = this.root.updatedAt;
      await this.flush(false);
    });
  }
}

/** One admitted root owns all action outcomes; external effects retain the existing transaction journal. */
export async function executeAutomaticDocument(input: DocumentExecution): Promise<void> {
  await new DocumentRunner(input).run();
}
