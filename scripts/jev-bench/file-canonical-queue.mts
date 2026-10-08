/** Isolated, preprofiled sequential canonical filing; never an application-data migration. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JevEvaluation, JevJob, JevReceipt, JevSourceSnapshot, JevVocabularyTerm } from '../../shared/jev-types.js';
import type { JevDecider } from '../../server/jev.js';
import { CanvasStore } from '../../server/storage.js';
import { atomicJson } from '../../server/storage-files.js';
import { JevWorkspaceFiles } from '../../server/jev/workspace.js';
import { JevProposalExecutor } from '../../server/jev/proposals.js';
import { automationPrincipal } from '../../server/jev/authorization.js';
import { evaluationContext } from '../../server/jev/context.js';
import { sourceSnapshot } from '../../server/jev/stamps.js';
import { profile, label } from '../../server/jev/actions/profile.js';
import { JevRuntime } from '../../server/jev/runtime.js';
import { recordJevCandidates } from '../../server/jev/runtime-proposals.js';
import { JEV_QUESTION_VERSION, type JevEvaluationContext } from '../../server/jev/actions/context.js';
import { engineering } from './file-broad-start.mjs';

export type CanonicalPhase = 'profile' | 'label' | 'file' | 'startup';
export type CanonicalSource = { id: string; title: string; content: string; manual?: boolean };
export type CanonicalFailure = { document: string; phase: CanonicalPhase; error: string };
export type CanonicalSession = { root: string; store: CanvasStore; files: JevWorkspaceFiles; workspaceId: string; canvasId: string;
  ids: Array<{ frozenId: string; blockId: string; manual: boolean }>; initialSources: JevSourceSnapshot[]; runtime?: JevRuntime };
export type CanonicalQueueOptions = { sources: readonly CanonicalSource[]; decider: JevDecider; apiKey: string;
  phase?: (phase: CanonicalPhase, document?: string) => void; observe?: (session: CanonicalSession) => Promise<void> };

async function seed(options: CanonicalQueueOptions): Promise<CanonicalSession> {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-canonical-filing-'));
  try {
    await atomicJson(path.join(root, 'workspaces.json'), []);
    const store = new CanvasStore(root); await store.init();
    const workspace = await store.createWorkspace({ name: 'Frozen benchmark sources' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Project Atlas' });
    const ids: CanonicalSession['ids'] = [];
    for (const source of options.sources) {
      const block = await store.createBlock(canvas.id, { title: source.title, content: source.content,
        ...(source.manual ? { group: engineering.key } : {}) }, 'Browser');
      if (!source.manual) await store.jevExecutor.execute({ kind: 'document', canvasId: canvas.id, blockId: block.id, patch: { group: engineering.key } },
        [sourceSnapshot(workspace.id, canvas.id, block)], randomUUID(), 'benchmark-fixture', true, async () => undefined);
      ids.push({ frozenId: source.id, blockId: block.id, manual: source.manual === true });
    }
    const files = new JevWorkspaceFiles(root); const state = await files.read(workspace.id);
    state.settings.externalProcessing = true;
    state.settings.modes = Object.fromEntries(Object.keys(state.settings.modes).map(action => [action, action === 'file' ? 'auto' : 'off'])) as typeof state.settings.modes;
    const term: JevVocabularyTerm = { id: 'engineering', kind: 'group', name: engineering.name, definition: engineering.definition,
      groupKey: engineering.key, state: 'active', version: 1, aliases: [], members: ids.map(({ blockId }) => ({ canvasId: canvas.id, blockId })) };
    state.vocabulary = [term]; await files.write(workspace.id, state);
    const initial = await store.getCanvas(canvas.id);
    const initialSources = initial.blocks.map(block => sourceSnapshot(workspace.id, canvas.id, block));
    return { root, store, files, workspaceId: workspace.id, canvasId: canvas.id, ids, initialSources };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

async function currentContext(session: CanonicalSession, options: CanonicalQueueOptions, blockId: string) {
  const state = await session.files.read(session.workspaceId);
  const input = await evaluationContext(new CanvasStore(session.root), session.workspaceId, state,
    { action: 'file', canvasId: session.canvasId, blockIds: [blockId] }, automationPrincipal, new AbortController().signal);
  return { ...input, decider: options.decider, apiKey: options.apiKey, confidenceThreshold: .7 };
}

async function applyPrerequisite(session: CanonicalSession, evaluated: JevEvaluation, action: 'profile' | 'label', context: JevEvaluationContext): Promise<void> {
  const state = await session.files.read(session.workspaceId);
  const now = new Date().toISOString();
  const job: JevJob = { id: `benchmark-${action}-${randomUUID()}`, questionVersion: JEV_QUESTION_VERSION,
    request: { action, canvasId: session.canvasId }, sources: evaluated.proposals.flatMap(proposal => proposal.sources),
    state: 'completed', createdAt: now, updatedAt: now, proposalIds: [] };
  recordJevCandidates(state, job, evaluated, context);
  await session.files.write(session.workspaceId, state);
  const executor = new JevProposalExecutor(session.store, session.files);
  for (const id of job.proposalIds) await executor.applyInside(session.workspaceId, id, automationPrincipal, true);
}

function failure(document: string, phase: CanonicalPhase, error: unknown): CanonicalFailure {
  return { document, phase, error: error instanceof Error ? error.message : String(error) };
}

async function prerequisites(session: CanonicalSession, options: CanonicalQueueOptions, failures: CanonicalFailure[]) {
  const successful: string[] = [];
  const evaluations: Array<{ document: string; phase: 'profile' | 'label'; evaluation: JevEvaluation }> = [];
  for (const source of session.ids) {
    try {
      options.phase?.('profile', source.frozenId);
      const input = await currentContext(session, options, source.blockId);
      const evaluated = await profile(input, { action: 'profile', canvasId: session.canvasId, blockIds: [source.blockId] });
      await applyPrerequisite(session, evaluated, 'profile', input);
      evaluations.push({ document: source.frozenId, phase: 'profile', evaluation: evaluated }); successful.push(source.blockId);
    } catch (error) { failures.push(failure(source.frozenId, 'profile', error)); }
  }
  for (const source of session.ids.filter(source => successful.includes(source.blockId))) {
    try {
      options.phase?.('label', source.frozenId);
      const input = await currentContext(session, options, source.blockId);
      const evaluated = await label(input, { action: 'label', canvasId: session.canvasId, blockIds: [source.blockId] });
      await applyPrerequisite(session, evaluated, 'label', input);
      evaluations.push({ document: source.frozenId, phase: 'label', evaluation: evaluated });
    } catch (error) { failures.push(failure(source.frozenId, 'label', error)); }
  }
  return evaluations;
}

async function startFileRuntime(session: CanonicalSession, options: CanonicalQueueOptions): Promise<JevRuntime> {
  const before = await session.files.read(session.workspaceId); before.settings.paused = true;
  await session.files.write(session.workspaceId, before); options.phase?.('startup');
  const runtime = new JevRuntime(session.store, { startTimer: false, documentExecution: false,
    apiKey: options.apiKey, decider: async (...args) => {
      if ((await session.files.read(session.workspaceId)).settings.paused) throw new Error('Unexpected provider call during benchmark startup');
      return options.decider(...args);
    } });
  session.runtime = runtime; await runtime.idle();
  const ready = await session.files.read(session.workspaceId);
  if (ready.jobs.length) throw new Error('Benchmark startup unexpectedly admitted automatic jobs');
  ready.settings.paused = false; await session.files.write(session.workspaceId, ready);
  return runtime;
}

async function fileSequentially(session: CanonicalSession, options: CanonicalQueueOptions, failures: CanonicalFailure[]) {
  const runtime = await startFileRuntime(session, options); const jobs: JevJob[] = [];
  for (const source of session.ids) {
    if (failures.some(item => item.document === source.frozenId)) continue;
    options.phase?.('file', source.frozenId);
    try {
      const submitted = await runtime.run(session.workspaceId,
        { action: 'file', canvasId: session.canvasId, blockIds: [source.blockId], idempotencyKey: `canonical-file-${source.frozenId}` }, automationPrincipal);
      await runtime.idle();
      const state = await new JevWorkspaceFiles(session.root).read(session.workspaceId);
      const completed = state.jobs.find(job => job.id === submitted.id)!; jobs.push(completed);
      if (completed.state !== 'completed') failures.push(failure(source.frozenId, 'file', completed.error ?? completed.state));
      const uncommitted = state.proposals.filter(proposal => completed.proposalIds.includes(proposal.id) && proposal.state !== 'applied');
      for (const proposal of uncommitted) failures.push(failure(source.frozenId, 'file',
        proposal.automaticHoldReason ?? `Canonical proposal ${proposal.id} remained ${proposal.state}`));
    } catch (error) { failures.push(failure(source.frozenId, 'file', error)); }
    const state = await new JevWorkspaceFiles(session.root).read(session.workspaceId);
    if (state.jobs.some(job => job.request.action !== 'file' || !jobs.some(known => known.id === job.id)))
      throw new Error('Benchmark admitted an unexpected background job');
    await unchangedSources(session, options);
  }
  return jobs;
}

async function unchangedSources(session: CanonicalSession, options: CanonicalQueueOptions): Promise<void> {
  const canvas = await new CanvasStore(session.root).getCanvas(session.canvasId);
  if (canvas.blocks.length !== options.sources.length) throw new Error('Benchmark source corpus changed');
  for (const source of session.ids) {
    const block = canvas.blocks.find(block => block.id === source.blockId);
    const original = options.sources.find(item => item.id === source.frozenId)!;
    if (!block || block.content !== original.content || block.title !== original.title)
      throw new Error(`Benchmark source changed: ${source.frozenId}`);
  }
}

function publicReceipt(receipt: JevReceipt) {
  const { id, proposalId, action, createdAt, actor, before, after, sourcesAfter, state, automatic } = receipt;
  return { id, proposalId, action, createdAt, actor, before, after, sourcesAfter, state, automatic };
}

async function report(session: CanonicalSession, evaluations: Awaited<ReturnType<typeof prerequisites>>, jobs: JevJob[], failures: CanonicalFailure[]) {
  const store = new CanvasStore(session.root); const canvas = await store.getCanvas(session.canvasId);
  const state = await new JevWorkspaceFiles(session.root).read(session.workspaceId);
  const rows = session.ids.map(source => {
    const block = canvas.blocks.find(block => block.id === source.blockId)!;
    return { ...source, title: block.title, initialGroup: engineering.key, finalGroup: block.group ?? null,
      tags: block.tags ?? [], ownership: block.jevOwnership, source: sourceSnapshot(session.workspaceId, session.canvasId, block),
      job: jobs.find(job => job.request.blockIds?.includes(block.id)) };
  });
  const keys = [...new Set(rows.map(row => row.finalGroup))];
  return { scenario: 'preprofiled sequential canonical filing', order: session.ids.map(source => source.frozenId),
    initialGroup: engineering, prerequisites: evaluations, rows, rawFinalNativeGroups: keys.map(key => ({ key,
      members: rows.filter(row => row.finalGroup === key).map(row => row.frozenId) })), vocabulary: state.vocabulary,
    proposals: state.proposals, receipts: state.receipts.map(publicReceipt), failures, complete: failures.length === 0,
    finalReloadVerified: true, projectionOnly: false, automaticDocumentPipeline: false };
}

export async function runCanonicalFilingQueue(options: CanonicalQueueOptions) {
  if (!options.sources.length || new Set(options.sources.map(source => source.id)).size !== options.sources.length)
    throw new Error('Canonical filing requires unique source identifiers');
  const session = await seed(options); const failures: CanonicalFailure[] = [];
  try {
    const evaluated = await prerequisites(session, options, failures);
    await unchangedSources(session, options);
    const jobs = await fileSequentially(session, options, failures);
    await options.observe?.(session);
    const measured = await report(session, evaluated, jobs, failures);
    const workspaces = await new CanvasStore(session.root).listWorkspaces();
    return { ...measured, initialSnapshot: { workspaceCount: workspaces.length,
      canvasCount: workspaces.flatMap(workspace => workspace.canvases).length,
      documentCount: session.initialSources.length, sources: session.initialSources }, sourceBodiesUnchanged: true };
  } finally { await session.runtime?.shutdown(); await rm(session.root, { recursive: true, force: true }); }
}
