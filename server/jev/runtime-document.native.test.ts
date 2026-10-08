import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { JevEvaluation, JevProposal } from '../../shared/jev-types.js';
import { randomUUID } from 'node:crypto';
import { derived, type JevEvaluationContext } from './actions/context.js';
import { ApiError } from '../errors.js';
import { automationPrincipal } from './authorization.js';
import { evaluationContext } from './context.js';
import { automaticHoldReason } from './eligibility.js';
import { JevRuntime } from './runtime.js';
import type { PreparedJevMutation } from './proposals.js';
import type { QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { queueBoundaryCopies } from './queue-boundary-copy.test.fixture.js';
import { automaticDocumentEligible, checkDocumentSources, documentActions, executeAutomaticDocument,
  initializeDocumentPlan, type DocumentExecution, type DocumentJob } from './runtime-document.js';
import type { StoredJevJob } from './runtime-queue.js';
import { sourceSnapshot } from './stamps.js';

let native: QueueBoundaryFixture;
let copies: Awaited<ReturnType<typeof queueBoundaryCopies>>;
let job: DocumentJob;
let calls: string[];
let controller: AbortController;
beforeAll(async () => { copies = await queueBoundaryCopies(); });
afterAll(async () => { await copies.close(); });
beforeEach(async () => {
  native = await copies.fixture(); calls = []; controller = new AbortController();
  job = await native.admit({ action: 'profile', canvasId: native.canvasId, blockIds: [native.primary.id] }, automationPrincipal);
  const state = await native.files.read(native.workspaceId);
  job = state.jobs.find(item => item.id === job.id) as DocumentJob;
  job.state = 'running'; job.attempts = 1; initializeDocumentPlan(job);
  await native.files.write(native.workspaceId, state);
});
afterEach(async () => { await native.close(); });

function result(context: JevEvaluationContext, current: StoredJevJob): JevEvaluation {
  calls.push(current.request.action);
  const source = context.documents.find(document => document.block.id === native.primary.id)!;
  return { result: { checked: current.request.action }, proposals: [derived(current.request, source, { [current.request.action]: true })] };
}
async function input(evaluate: DocumentExecution['evaluate'] = async (context, current) => result(context, current)): Promise<DocumentExecution> {
  await checkDocumentSources(native.store, native.workspaceId, job);
  const state = await native.files.read(native.workspaceId);
  const refresh: DocumentExecution['refresh'] = (current, action) => evaluationContext(native.store, native.workspaceId,
    current, action.request, automationPrincipal, controller.signal, { activity: 'validate' });
  return { workspaceId: native.workspaceId, job, context: await refresh(state, job), store: native.store,
    files: native.files, executor: native.executor, evaluate, reason: () => undefined, refresh,
    checkpoint: async (current, request, key) => { await native.followups.checkpointInside(native.workspaceId, current, request, key); } };
}

it('admits only the exact automatic single-document all-action scope', async () => {
  const state = await native.files.read(native.workspaceId);
  expect(automaticDocumentEligible(job, state)).toBe(true);
  expect(automaticDocumentEligible({ ...job, principal: { ...job.principal, tools: ['jev_do'] } }, state)).toBe(false);
  expect(automaticDocumentEligible({ ...job, request: { ...job.request, blockIds: [] } }, state)).toBe(false);
  expect(automaticDocumentEligible({ ...job, request: { ...job.request, query: 'manual scope' } }, state)).toBe(false);
  expect(automaticDocumentEligible(job, { settings: { ...state.settings, modes: { ...state.settings.modes, label: 'off' } } })).toBe(false);
});

it('recovers a prepared canonical record before claiming a resumed document job', async () => {
  const runtime = new JevRuntime(native.store, { startTimer: false, documentExecution: false });
  try {
    await runtime.idle();
    const state = await native.files.read(native.workspaceId);
    const saved = state.jobs.find(item => item.id === job.id) as DocumentJob;
    saved.state = 'queued'; saved.attempts = 0; initializeDocumentPlan(saved);
    const proposal: JevProposal = { id: randomUUID(), jobId: job.id, action: 'profile', title: 'Prepared profile',
      explanation: 'Durable workspace result', evidence: [], sources: [], mutation: { kind: 'derived', values: {} },
      state: 'pending', createdAt: new Date().toISOString() };
    state.proposals.push(proposal);
    state.prepared.push({ id: randomUUID(), proposal, before: proposal.mutation, after: proposal.mutation, artifacts: [] } as PreparedJevMutation);
    await native.files.write(native.workspaceId, state);
    const admission = runtime as unknown as {
      takeJob(workspaceId: string, jobId: string, controller: AbortController): Promise<StoredJevJob | undefined>;
    };
    const claimed = await admission.takeJob(native.workspaceId, job.id, new AbortController());
    expect(claimed).toMatchObject({ id: job.id, state: 'running', attempts: 1 });
    const recovered = await native.files.read(native.workspaceId);
    expect(recovered.prepared).toEqual([]);
    expect(recovered.receipts.some(receipt => receipt.proposalId === proposal.id)).toBe(true);
  } finally { await runtime.shutdown(); }
});

it('rejects a document recheck outside the workspace canvas before admission', async () => {
  const runtime = new JevRuntime(native.store, { startTimer: false, documentExecution: false });
  try {
    await runtime.idle();
    await expect(runtime.recheckDocument(native.workspaceId, 'missing-canvas', native.primary.id,
      native.primary.contentHash!, { id: 'owner', kind: 'user', access: 'write', canConfigure: true, canApprove: true }))
      .rejects.toMatchObject({ status: 404, message: 'Canvas not found' });
  } finally { await runtime.shutdown(); }
});

it('refuses provider-paused execution before loading or mutating a durable document plan', async () => {
  const execution = await input(); const before = await native.files.read(native.workspaceId);
  vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '1');
  try {
    await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual([]);
    expect(await native.files.read(native.workspaceId)).toEqual(before);
  } finally { vi.unstubAllEnvs(); }
});

it('uses a local abort signal when an evaluation context has none', async () => {
  const execution = await input();
  execution.context.signal = undefined;
  await executeAutomaticDocument(execution);
  expect(calls).toEqual(documentActions);
  expect((await native.files.read(native.workspaceId)).jobs.find(item => item.id === job.id)?.state).toBe('completed');
});

it('rejects a missing root and a completed prefix without its source-context proof before inference', async () => {
  const missing = await input(); missing.state = { ...await native.files.read(native.workspaceId), jobs: [] };
  await expect(executeAutomaticDocument(missing)).rejects.toMatchObject({ status: 409 });
  const incomplete = await input();
  incomplete.state = await native.files.read(native.workspaceId);
  const root = incomplete.state!.jobs.find(item => item.id === job.id) as DocumentJob;
  root.documentPlan!.completedActions = ['profile']; delete root.documentPlan!.contextProof;
  await expect(executeAutomaticDocument(incomplete)).rejects.toMatchObject({ status: 409,
    message: 'The saved document context requires a fresh review' });
  expect(calls).toEqual([]);
});

it('keeps the original source when an interrupted receipt has no matching replacement and does not retarget multi-source scope', async () => {
  const original = structuredClone(job.sources[0]);
  const state = await native.files.read(native.workspaceId);
  const root = state.jobs.find(item => item.id === job.id) as DocumentJob;
  root.documentPlan!.activeJob = { ...structuredClone(root), proposalIds: ['unrelated-proposal'] };
  state.receipts.push({ proposalId: 'unrelated-proposal', state: 'applied', sourcesAfter: [] } as unknown as typeof state.receipts[number]);
  await native.files.write(native.workspaceId, state);
  await checkDocumentSources(native.store, native.workspaceId, root);
  expect(root.sources).toEqual([original]);
  const secondary = sourceSnapshot(native.workspaceId, native.otherCanvasId, native.secondary);
  const multi = { ...root, documentPlan: undefined, sources: [original, secondary],
    request: { ...root.request, canvasId: native.otherCanvasId } };
  await checkDocumentSources(native.store, native.workspaceId, multi);
  expect(multi.sources).toEqual([original, secondary]);
  expect(multi.request.canvasId).toBe(native.otherCanvasId);
});

it('rejects a source outside the original content proof before checking native artifacts', async () => {
  const changed = structuredClone(job);
  changed.sources[0].contentHash = 'changed-without-a-receipt';
  await expect(checkDocumentSources(native.store, native.workspaceId, changed)).rejects.toMatchObject({ status: 409,
    message: 'The document changed during automatic processing' });
  expect(calls).toEqual([]);
});

it('rejects an interrupted removed action before replaying its proposals or evaluating another action', async () => {
  const state = await native.files.read(native.workspaceId);
  const root = state.jobs.find(item => item.id === job.id) as DocumentJob;
  const execution = await input();
  root.documentPlan!.activeJob = { ...structuredClone(job), id: `${job.id}:assign_owner`,
    request: { ...job.request, action: 'assign_owner' } };
  const before = structuredClone(state);
  execution.state = state;
  await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 409,
    message: 'The document action plan changed' });
  expect(calls).toEqual([]);
  expect(state).toEqual(before);
});

it('rejects an older filing-first plan before resuming its completed prefix or active intent', async () => {
  const state = await native.files.read(native.workspaceId);
  const root = state.jobs.find(item => item.id === job.id) as DocumentJob;
  Object.assign(root.documentPlan!, { version: 1, completedActions: ['profile', 'file'] });
  root.documentPlan!.activeJob = { ...structuredClone(job), id: `${job.id}:label`, request: { ...job.request, action: 'label' } };
  const before = structuredClone(state);
  await expect(executeAutomaticDocument({ ...await input(), state })).rejects.toMatchObject({ status: 409,
    message: 'The document action plan changed' });
  expect(calls).toEqual([]);
  expect(state).toEqual(before);
});

it('durably commits six separately verifiable workspace results and their current checkpoint in one write', async () => {
  const execution = await input();
  let writes = 0;
  const write = native.files.write.bind(native.files);
  native.files.write = async (...args) => { writes += 1; return write(...args); };
  await executeAutomaticDocument(execution);
  expect(writes).toBe(1);
  expect(calls).toEqual(documentActions);
  const state = await native.files.read(native.workspaceId);
  expect(state.jobs).toHaveLength(6);
  expect(state.jobs.every(item => item.state === 'completed')).toBe(true);
  expect(state.receipts).toHaveLength(6);
  expect((state.jobs.find(item => item.id === job.id) as DocumentJob).documentPlan?.completedActions).toEqual(documentActions);
  expect(state.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
  const beforeUndo = state.receipts.at(-1)!;
  await native.files.serial(native.workspaceId, () => native.executor.undoInside(native.workspaceId, beforeUndo.id,
    { id: 'owner', kind: 'user', access: 'write', canApprove: true }));
  expect((await native.files.read(native.workspaceId)).receipts.find(receipt => receipt.id === beforeUndo.id)?.state).toBe('undone');
});

it('files only after earlier labels and links are durable and present in its refreshed context', async () => {
  let observedFiling = false;
  const execution = await input(async (context, current) => {
    const evaluated = result(context, current);
    const source = context.documents.find(document => document.block.id === native.primary.id)!;
    const connection = { canvasId: native.otherCanvasId, blockId: native.secondary.id, relation: 'related' as const };
    if (current.request.action === 'label' || current.request.action === 'link') {
      evaluated.proposals[0].mutation = { kind: 'document', canvasId: native.canvasId, blockId: native.primary.id,
        patch: current.request.action === 'label' ? { tags: ['Release evidence'] } : { crossLinks: [connection] } };
      evaluated.proposals[0].confidence = .99;
      evaluated.proposals[0].evidence = [{ source: source.snapshot, start: 0, end: 7, quote: '# Atlas' }];
    }
    if (current.request.action === 'file') {
      expect(calls).toEqual(['profile', 'label', 'link', 'flag_duplicate', 'file']);
      expect(source.block.tags).toEqual(['Release evidence']);
      expect(source.block.crossLinks).toEqual([connection]);
      const durable = await native.files.read(native.workspaceId);
      expect(durable.receipts.filter(receipt => ['label', 'link'].includes(receipt.action)))
        .toEqual([expect.objectContaining({ action: 'label', state: 'applied' }), expect.objectContaining({ action: 'link', state: 'applied' })]);
      const saved = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
      expect(source.snapshot).toEqual(sourceSnapshot(native.workspaceId, native.canvasId, saved));
      observedFiling = true;
    }
    return evaluated;
  });
  execution.reason = automaticHoldReason;
  await executeAutomaticDocument(execution);
  expect(observedFiling).toBe(true);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id))).toMatchObject({
    content: native.primary.content, x: native.primary.x, y: native.primary.y, tags: ['Release evidence'] });
});

it('makes the current staged logical index available to filing without an extra workspace commit', async () => {
  const logicalIndex = { version: 1, topics: [{ name: 'Release evidence', confidence: .99 }] };
  let writes = 0; let observedFiling = false;
  const write = native.files.write.bind(native.files);
  native.files.write = async (...args) => { writes += 1; return write(...args); };
  const execution = await input(async (context, current) => {
    const evaluated = result(context, current);
    if (current.request.action === 'profile') {
      const mutation = evaluated.proposals[0].mutation;
      if (mutation.kind === 'derived') mutation.values.logicalIndex = logicalIndex;
    }
    if (current.request.action === 'file') {
      expect(context.indexes?.[`${native.canvasId}:${native.primary.id}`]).toEqual(logicalIndex);
      expect(writes).toBe(0);
      observedFiling = true;
    }
    return evaluated;
  });
  await executeAutomaticDocument(execution);
  expect(observedFiling).toBe(true); expect(writes).toBe(1);
  expect((await native.files.read(native.workspaceId)).profiles[`${native.canvasId}:${native.primary.id}`].logicalIndex).toEqual(logicalIndex);
});

it('commits a pinned label no-change result once without writing an external intent or altering manual ownership', async () => {
  const pinned = await native.store.updateBlock(native.canvasId, native.primary.id, { tags: ['Manual review'] }, 'Browser');
  const initial = await native.files.read(native.workspaceId);
  job = initial.jobs.find(item => item.id === job.id) as DocumentJob;
  job.sources = [sourceSnapshot(native.workspaceId, native.canvasId, pinned)];
  delete job.documentPlan; initializeDocumentPlan(job);
  await native.files.write(native.workspaceId, initial);
  const execution = await input(async (context, current) => {
    const evaluated = result(context, current);
    if (current.request.action === 'label') {
      const candidate = evaluated.proposals[0];
      candidate.mutation = { kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { tags: [] } };
      candidate.confidence = .99;
      candidate.evidence = [{ source: candidate.sources[0], start: 0, end: 7, quote: '# Atlas' }];
    }
    return evaluated;
  });
  execution.reason = automaticHoldReason;
  let writes = 0; let canonicalCalls = 0;
  const write = native.files.write.bind(native.files); const apply = native.executor.applyInside.bind(native.executor);
  native.files.write = async (...args) => { writes += 1; return write(...args); };
  native.executor.applyInside = async (...args) => { canonicalCalls += 1; return apply(...args); };
  await executeAutomaticDocument(execution);
  expect(writes).toBe(1); expect(canonicalCalls).toBe(0);
  const state = await native.files.read(native.workspaceId);
  expect(state.jobs).toHaveLength(6);
  expect(state.jobs.every(current => current.state === 'completed')).toBe(true);
  expect(state.proposals.find(proposal => proposal.action === 'label')).toMatchObject({ state: 'dismissed',
    automaticHoldReason: 'A field is pinned or managed manually' });
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id))).toMatchObject({ tags: pinned.tags, jevOwnership: pinned.jevOwnership });
});

it('records protected automatic filing as a durable no-change result without calling its evaluator', async () => {
  const pinned = await native.store.updateBlock(native.canvasId, native.primary.id, { group: 'custom:manual-review' }, 'Browser');
  const initial = await native.files.read(native.workspaceId);
  job = initial.jobs.find(item => item.id === job.id) as DocumentJob;
  job.sources = [sourceSnapshot(native.workspaceId, native.canvasId, pinned)];
  delete job.documentPlan; initializeDocumentPlan(job);
  await native.files.write(native.workspaceId, initial);
  let writes = 0;
  const execution = await input(); const write = native.files.write.bind(native.files);
  native.files.write = async (...args) => { writes += 1; return write(...args); };
  await executeAutomaticDocument(execution);
  expect(calls).toEqual(documentActions.filter(action => action !== 'file'));
  expect(writes).toBe(1);
  const state = await native.files.read(native.workspaceId);
  expect(state.jobs).toHaveLength(6);
  expect(state.jobs.find(current => current.request.action === 'file')).toMatchObject({ state: 'completed', proposalIds: [],
    result: { status: 'no_change', reason: 'A field is pinned or managed manually',
      documents: { [native.primary.id]: { status: 'no_change', reason: 'A field is pinned or managed manually' } } } });
  expect(state.receipts.some(receipt => receipt.action === 'file')).toBe(false);
  expect(state.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(await native.store.getCanvasBlock(native.canvasId, native.primary.id)).toMatchObject({
    group: pinned.group, content: pinned.content, x: pinned.x, y: pinned.y, jevOwnership: pinned.jevOwnership,
    incarnation: pinned.incarnation, sourceGeneration: pinned.sourceGeneration, metadataRevision: pinned.metadataRevision });
});

async function canonical(context: JevEvaluationContext, current: StoredJevJob): Promise<JevEvaluation> {
  const evaluated = result(context, current);
  if (current.request.action === 'file') evaluated.proposals[0].mutation = { kind: 'document', canvasId: native.canvasId,
    blockId: native.primary.id, patch: { purpose: 'Release guide' } };
  return evaluated;
}

it.each([400, 409])('retains rejected canonical evidence and marks its proposal for status %i', async status => {
  const apply = native.executor.applyInside.bind(native.executor);
  native.executor.applyInside = async (...args) => {
    const state = await native.files.read(native.workspaceId);
    const proposal = state.proposals.find(item => item.id === args[1]);
    if (proposal?.action === 'file') throw new ApiError(status, 'Offline native policy rejected this change');
    return apply(...args);
  };
  await expect(executeAutomaticDocument(await input(canonical))).rejects.toMatchObject({ status: 409,
    message: 'An automatic action could not apply its checked result' });
  const state = await native.files.read(native.workspaceId);
  const fileJob = state.jobs.find(item => item.request.action === 'file') as DocumentJob;
  expect(fileJob).toBeUndefined();
  const fileProposal = state.proposals.find(item => item.action === 'file')!;
  expect(fileProposal).toMatchObject({ state: status === 409 ? 'stale' : 'dismissed',
    automaticHoldReason: 'Offline native policy rejected this change' });
  const root = state.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(root.documentPlan?.activeJob?.result).toMatchObject({ automaticFailures: [{ proposalId: fileProposal.id,
    reason: 'Offline native policy rejected this change' }] });
  expect(root.documentPlan?.completedActions).toEqual(documentActions.slice(0, 4));
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).purpose).not.toBe('Release guide');
});

it('retains each rejected canonical option in one action without applying either', async () => {
  const evaluate = async (context: JevEvaluationContext, current: StoredJevJob): Promise<JevEvaluation> => {
    const value = await canonical(context, current);
    if (current.request.action === 'file') value.proposals.push({ ...structuredClone(value.proposals[0]),
      title: 'Second checked filing', mutation: { kind: 'document', canvasId: native.canvasId,
        blockId: native.primary.id, patch: { purpose: 'Alternate release guide' } } });
    return value;
  };
  const apply = native.executor.applyInside.bind(native.executor);
  native.executor.applyInside = async (...args) => {
    const proposal = (await native.files.read(native.workspaceId)).proposals.find(item => item.id === args[1]);
    if (proposal?.action === 'file') throw new ApiError(400, 'Offline policy rejected filing');
    return apply(...args);
  };
  await expect(executeAutomaticDocument(await input(evaluate))).rejects.toMatchObject({ status: 409 });
  const state = await native.files.read(native.workspaceId);
  const root = state.jobs.find(item => item.id === job.id) as DocumentJob;
  const rejected = state.proposals.filter(item => item.action === 'file');
  expect(rejected).toHaveLength(2);
  expect(rejected.every(item => item.state === 'dismissed')).toBe(true);
  expect(root.documentPlan?.activeJob?.result?.automaticFailures).toHaveLength(2);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).purpose).not.toBe('Release guide');
});

it('dismisses a canonical proposal when its hold reason changes after the durable intent', async () => {
  const execution = await input(canonical);
  execution.reason = (state, proposal) => proposal.action === 'file'
    && (state.jobs.find(item => item.id === job.id) as DocumentJob).documentPlan?.activeJob
    ? 'The checked action is held after staging' : undefined;
  await executeAutomaticDocument(execution);
  const state = await native.files.read(native.workspaceId);
  expect(state.jobs.every(item => item.state === 'completed')).toBe(true);
  expect(state.proposals.find(item => item.action === 'file')).toMatchObject({ state: 'dismissed',
    automaticHoldReason: 'The checked action is held after staging' });
  expect(state.receipts.some(item => item.action === 'file')).toBe(false);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).purpose).not.toBe('Release guide');
});

it('recovers a crash after a canonical receipt without replaying successful actions or applying twice', async () => {
  const execution = await input(canonical);
  const apply = native.executor.applyInside.bind(native.executor);
  let crash = true;
  native.executor.applyInside = async (...args) => {
    const receipt = await apply(...args);
    if (crash) { crash = false; throw new Error('Crash after durable canonical receipt'); }
    return receipt;
  };
  await expect(executeAutomaticDocument(execution)).rejects.toThrow('Crash after durable canonical receipt');
  const partial = await native.files.read(native.workspaceId);
  expect(partial.jobs).toHaveLength(4);
  expect(partial.jobs[0].state).toBe('running');
  expect(partial.receipts).toHaveLength(5);
  expect(partial.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toBeUndefined();
  job = partial.jobs[0] as DocumentJob;
  calls = [];
  await executeAutomaticDocument(await input(canonical));
  expect(calls).toEqual(documentActions.slice(5));
  const state = await native.files.read(native.workspaceId);
  expect(state.jobs).toHaveLength(6);
  expect(state.receipts).toHaveLength(6);
  expect(state.receipts.filter(receipt => receipt.action === 'file')).toHaveLength(1);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).purpose).toBe('Release guide');
});

it('halts restart before evaluating a suffix when a prepared canonical record lacks recovery artifacts', async () => {
  const apply = native.executor.applyInside.bind(native.executor);
  native.executor.applyInside = async () => { throw new Error('Offline crash before native writer'); };
  await expect(executeAutomaticDocument(await input(canonical))).rejects.toThrow('Offline crash before native writer');
  const state = await native.files.read(native.workspaceId);
  const proposal = state.proposals.find(item => item.action === 'file')!;
  expect(proposal.state).toBe('pending');
  state.prepared.push({ id: 'interrupted-file', proposal, before: proposal.mutation, after: proposal.mutation });
  await native.files.write(native.workspaceId, state);
  native.executor.applyInside = apply;
  job = state.jobs.find(item => item.id === job.id) as DocumentJob;
  calls = [];
  await expect(executeAutomaticDocument(await input(canonical))).rejects.toMatchObject({ status: 503,
    message: 'Symbi Reflex recovery metadata is incomplete' });
  expect(calls).toEqual([]);
  const after = await native.files.read(native.workspaceId);
  expect(after.prepared).toHaveLength(1);
  expect((after.jobs.find(item => item.id === job.id) as DocumentJob).documentPlan?.completedActions)
    .toEqual(documentActions.slice(0, 4));
});

it('does not duplicate a completed action when an interrupted intent is replayed from a legacy plan', async () => {
  const apply = native.executor.applyInside.bind(native.executor);
  let crash = true;
  native.executor.applyInside = async (...args) => {
    const receipt = await apply(...args);
    if (crash) { crash = false; throw new Error('Crash after canonical receipt'); }
    return receipt;
  };
  await expect(executeAutomaticDocument(await input(canonical))).rejects.toThrow('Crash after canonical receipt');
  const state = await native.files.read(native.workspaceId);
  const root = state.jobs.find(item => item.id === job.id) as DocumentJob;
  root.documentPlan!.completedActions.push('file');
  await native.files.write(native.workspaceId, state);
  job = root;
  calls = [];
  await executeAutomaticDocument(await input(canonical));
  const finished = (await native.files.read(native.workspaceId)).jobs.find(item => item.id === job.id) as DocumentJob;
  expect(calls).toEqual(['suggest_home_canvas']);
  expect(finished.documentPlan?.completedActions).toEqual(documentActions);
  expect(new Set(finished.documentPlan?.completedActions).size).toBe(documentActions.length);
});

it('rejects a manual metadata edit after an interrupted canonical effect', async () => {
  const execution = await input(canonical);
  const apply = native.executor.applyInside.bind(native.executor);
  native.executor.applyInside = async (...args) => { await apply(...args); throw new Error('Interrupted'); };
  await expect(executeAutomaticDocument(execution)).rejects.toThrow('Interrupted');
  await native.store.updateBlock(native.canvasId, native.primary.id, { tags: ['Manual review'] }, 'Browser');
  job = (await native.files.read(native.workspaceId)).jobs[0] as DocumentJob;
  await expect(checkDocumentSources(native.store, native.workspaceId, job)).rejects.toMatchObject({ status: 409 });
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).tags).toEqual(['Manual review']);
});

it.each(['supporting source', 'task', 'vocabulary'] as const)('does not reuse a completed prefix when its %s changed during downtime', async change => {
  const execution = await input(canonical);
  const apply = native.executor.applyInside.bind(native.executor);
  native.executor.applyInside = async (...args) => { await apply(...args); throw new Error('Interrupted'); };
  await expect(executeAutomaticDocument(execution)).rejects.toThrow('Interrupted');
  if (change === 'supporting source') await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { content: '# New supporting evidence' }, 'Browser');
  else if (change === 'task') await native.store.createTask(native.canvasId, { title: 'Task added during downtime', detail: 'New context' }, 'Browser');
  else {
    const changed = await native.files.read(native.workspaceId);
    changed.vocabulary.push({ id: 'new-reviewed-label', kind: 'label', name: 'Reviewed', definition: 'Manually approved label',
      aliases: [], state: 'active', version: 1, members: [{ canvasId: native.canvasId, blockId: native.primary.id }] });
    await native.files.write(native.workspaceId, changed);
  }
  job = (await native.files.read(native.workspaceId)).jobs[0] as DocumentJob;
  native.executor.applyInside = apply;
  calls = [];
  await expect(executeAutomaticDocument(await input(canonical))).rejects.toMatchObject({ status: 409 });
  expect(calls).toEqual([]);
  expect((await native.files.read(native.workspaceId)).profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toBeUndefined();
});

it('revalidates supporting evidence between the durable intent and canonical application', async () => {
  const execution = await input(canonical);
  const write = native.files.write.bind(native.files);
  let changed = false;
  native.files.write = async (...args) => {
    await write(...args);
    const root = args[1].jobs.find(item => item.id === job.id) as DocumentJob;
    if (!changed && root.documentPlan?.activeJob) {
      changed = true;
      await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { content: '# Evidence changed before application' }, 'Browser');
    }
  };
  await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 409 });
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).purpose).toBeUndefined();
  expect((await native.files.read(native.workspaceId)).profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toBeUndefined();
});

it.each(['supporting source', 'task', 'new source'] as const)('refuses a current checkpoint when the %s changes during evaluation', async change => {
  const execution = await input(async (context, current) => {
    const evaluated = result(context, current);
    if (current.request.action === 'suggest_home_canvas') {
      if (change === 'supporting source') await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { content: '# Changed evidence' }, 'Browser');
      else if (change === 'task') await native.store.createTask(native.canvasId, { title: 'New task', detail: 'Context changed' }, 'Browser');
      else await native.store.createBlock(native.canvasId, { title: 'New evidence', content: '# New evidence' }, 'Browser');
    }
    return evaluated;
  });
  await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 409 });
  const state = await native.files.read(native.workspaceId);
  expect(state.receipts).toEqual([]);
  expect(state.jobs).toHaveLength(1);
  expect(state.jobs[0].state).toBe('running');
  expect(state.profiles[`${native.canvasId}:${native.primary.id}`]?.organizationContextKey).toBeUndefined();
});

it('refuses to mark aborted staged work complete', async () => {
  const execution = await input(async (context, current) => {
    if (current.request.action === 'suggest_home_canvas') controller.abort('shutdown');
    return result(context, current);
  });
  await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 409 });
  const state = await native.files.read(native.workspaceId);
  expect(state.receipts).toEqual([]);
  expect(state.jobs[0].state).toBe('running');
});

it('does not apply a canonical effect after shutdown aborts its wait for the native writer', async () => {
  const execution = await input(canonical);
  const apply = native.executor.applyInside.bind(native.executor);
  const execute = native.store.jevExecutor.execute.bind(native.store.jevExecutor);
  let release!: () => void;
  let blockedWriter: Promise<void> | undefined;
  native.executor.applyInside = async (...args) => {
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    blockedWriter = native.store.jevExecutor.serialized(async () => { entered(); await held; });
    await acquired;
    return apply(...args);
  };
  native.store.jevExecutor.execute = (...args) => {
    const pending = execute(...args);
    controller.abort('shutdown'); release();
    return pending;
  };
  try { await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 409 }); }
  finally { release?.(); await blockedWriter; }
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).purpose).toBeUndefined();
  const state = await native.files.read(native.workspaceId);
  expect(state.receipts.some(receipt => receipt.action === 'file')).toBe(false);
  expect(state.prepared).toEqual([]);
  expect(state.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toBeUndefined();
});

it('persists a successful prefix after provider failure and retries only its missing action suffix', async () => {
  const execution = await input(async (context, current) => {
    if (current.request.action === 'flag_duplicate') throw new Error('Provider unavailable');
    return result(context, current);
  });
  await expect(executeAutomaticDocument(execution)).rejects.toThrow('Provider unavailable');
  const partial = await native.files.read(native.workspaceId);
  job = partial.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(job.documentPlan?.completedActions).toEqual(documentActions.slice(0, 3));
  expect(job.documentPlan?.failedAction).toBe('flag_duplicate');
  expect(partial.receipts).toHaveLength(3);
  expect(partial.jobs.find(item => item.request.action === 'flag_duplicate')).toMatchObject({ state: 'failed' });
  expect(partial.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toBeUndefined();
  calls = [];
  await executeAutomaticDocument(await input());
  expect(calls).toEqual(documentActions.slice(3));
  const complete = await native.files.read(native.workspaceId);
  expect(complete.jobs).toHaveLength(6);
  expect(complete.jobs.every(item => item.state === 'completed')).toBe(true);
  expect(complete.receipts).toHaveLength(6);
});

it('persists a failed root action and clears its failure marker after a successful retry', async () => {
  await expect(executeAutomaticDocument(await input(async () => { throw new ApiError(502, 'Offline model failed'); })))
    .rejects.toMatchObject({ status: 502 });
  const failed = await native.files.read(native.workspaceId);
  job = failed.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(failed.jobs).toHaveLength(1);
  expect(job).toMatchObject({ state: 'running', documentPlan: { failedAction: 'profile', failureReason: 'Offline model failed',
    completedActions: [] } });
  await executeAutomaticDocument(await input());
  job = (await native.files.read(native.workspaceId)).jobs.find(item => item.id === job.id) as DocumentJob;
  expect(job.state).toBe('completed');
  expect(job.documentPlan?.failedAction).toBeUndefined();
  expect(job.documentPlan?.failureReason).toBeUndefined();
  expect(job.documentPlan?.completedActions).toEqual(documentActions);
});

it('does not save a provider failure after cancellation wins the workspace lock', async () => {
  const before = await native.files.read(native.workspaceId);
  const serial = native.files.serial.bind(native.files);
  native.files.serial = async (...args) => {
    controller.abort('shutdown');
    return serial(...args);
  };
  await expect(executeAutomaticDocument(await input(async () => { throw new Error('Offline provider stopped'); })))
    .rejects.toThrow('Offline provider stopped');
  expect(await native.files.read(native.workspaceId)).toEqual(before);
  expect(controller.signal.aborted).toBe(true);
});

it('does not persist a provider failure when evaluation itself observes cancellation', async () => {
  const before = await native.files.read(native.workspaceId);
  await expect(executeAutomaticDocument(await input(async () => {
    controller.abort('shutdown');
    throw new Error('Offline evaluation cancelled');
  }))).rejects.toThrow('Offline evaluation cancelled');
  expect(await native.files.read(native.workspaceId)).toEqual(before);
});

it('rejects a source that changes in memory between the profiled prefix and next action', async () => {
  const execution = await input();
  const serial = native.files.serial.bind(native.files);
  let changed = false;
  native.files.serial = async (...args) => {
    const result = await serial(...args);
    if (!changed && calls.includes('profile')) {
      changed = true;
      execution.context.documents.find(document => document.block.id === native.primary.id)!.snapshot.contentHash = 'stale-after-profile';
    }
    return result;
  };
  await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 409,
    message: 'The document changed during automatic processing' });
  expect(calls).toEqual(['profile']);
  expect((await native.files.read(native.workspaceId)).receipts).toEqual([]);
});

it('refuses durable completion when a completed action disappears from the in-memory prefix', async () => {
  const execution = await input();
  const state = await native.files.read(native.workspaceId);
  execution.state = state;
  const serial = native.files.serial.bind(native.files);
  let changed = false;
  native.files.serial = async (...args) => {
    if (!changed && calls.length === documentActions.length) {
      changed = true;
      (state.jobs.find(item => item.id === job.id) as DocumentJob).documentPlan!.completedActions = ['profile'];
    }
    return serial(...args);
  };
  await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 409,
    message: 'The document operation has unfinished actions' });
  expect(changed).toBe(true);
  expect((await native.files.read(native.workspaceId)).jobs.find(item => item.id === job.id)?.state).toBe('running');
});

it('commits a canonical root action once and retains its result across the six-action checkpoint', async () => {
  const evaluated = async (context: JevEvaluationContext, current: StoredJevJob): Promise<JevEvaluation> => {
    const value = result(context, current);
    if (current.request.action === 'profile') value.proposals[0].mutation = { kind: 'document', canvasId: native.canvasId,
      blockId: native.primary.id, patch: { purpose: 'Root profile review' } };
    return value;
  };
  await executeAutomaticDocument(await input(evaluated));
  const state = await native.files.read(native.workspaceId);
  const root = state.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(root).toMatchObject({ state: 'completed', result: { checked: 'profile' }, proposalIds: [expect.any(String)] });
  expect(root.documentPlan?.completedActions).toEqual(documentActions);
  expect(state.receipts.filter(item => item.action === 'profile')).toHaveLength(1);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).purpose).toBe('Root profile review');
});

it('preserves the valid prefix when an optional evaluator returns evidence that does not match its source', async () => {
  const execution = await input(async (context, current) => {
    const evaluated = result(context, current);
    if (current.request.action === 'flag_duplicate') evaluated.proposals[0].evidence = [{
      source: evaluated.proposals[0].sources[0], start: 0, end: 7, quote: 'Invalid',
    }];
    return evaluated;
  });
  await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 502 });
  const partial = await native.files.read(native.workspaceId);
  expect(partial.receipts).toHaveLength(3);
  job = partial.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(job.documentPlan?.completedActions).toEqual(documentActions.slice(0, 3));
  expect(partial.jobs.find(item => item.request.action === 'flag_duplicate')).toMatchObject({ state: 'failed' });
  expect(partial.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toBeUndefined();
  calls = [];
  await executeAutomaticDocument(await input());
  expect(calls).toEqual(documentActions.slice(3));
  const complete = await native.files.read(native.workspaceId);
  expect(complete.jobs).toHaveLength(6);
  expect(complete.receipts).toHaveLength(6);
  expect(complete.jobs.every(current => current.state === 'completed')).toBe(true);
});

it('keeps valid receipts and a failed action when a later workspace proposal violates vocabulary constraints', async () => {
  const state = await native.files.read(native.workspaceId);
  const term = { id: 'existing-label', kind: 'label' as const, name: 'Reviewed', definition: 'Reviewed source',
    aliases: [], state: 'active' as const, version: 1, members: [{ canvasId: native.canvasId, blockId: native.primary.id }] };
  state.vocabulary.push(term); await native.files.write(native.workspaceId, state);
  const execution = await input(async (context, current) => {
    const evaluated = result(context, current);
    if (current.request.action === 'file') evaluated.proposals.push({ ...evaluated.proposals[0],
      mutation: { kind: 'vocabulary', operation: 'define', term: { ...term, id: 'colliding-label' } } });
    return evaluated;
  });
  await expect(executeAutomaticDocument(execution)).rejects.toMatchObject({ status: 409 });
  const partial = await native.files.read(native.workspaceId);
  expect(partial.receipts).toHaveLength(5);
  expect(partial.vocabulary).toEqual([term]);
  expect(partial.jobs.find(current => current.request.action === 'file')).toMatchObject({ state: 'failed',
    result: { automaticFailures: [{ reason: 'Vocabulary name or group path collision' }] } });
  job = partial.jobs.find(current => current.id === job.id) as DocumentJob;
  expect(job.documentPlan?.completedActions).toEqual(documentActions.slice(0, 4));
  expect(partial.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toBeUndefined();
  await executeAutomaticDocument(await input());
  const complete = await native.files.read(native.workspaceId);
  expect(complete.receipts).toHaveLength(6);
  expect(complete.jobs.every(current => current.state === 'completed')).toBe(true);
});
