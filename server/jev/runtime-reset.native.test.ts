import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jevActions, type JevPrincipal } from '../../shared/jev-types.js';
import { acceptanceReflexProvider } from '../../features/acceptance-reflex-provider.js';
import { CanvasStore } from '../storage.js';
import { evaluateJevAction } from './actions.js';
import type { JevEvaluator } from './actions/context.js';
import { prepareJevReset, type StoredJevResetWorkspace } from './reset.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let files: JevWorkspaceFiles;
let workspaceId: string; let canvasId: string; let blockId: string; let evaluate: JevEvaluator;
beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  root = await mkdtemp(path.join(tmpdir(), 'jev-reset-runtime-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Reset runtime' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nOwner: Alice\nAtlas release requirements.', x: 123, y: 456 })).id;
  files = new JevWorkspaceFiles(root); evaluate = evaluateJevAction;
  runtime = new JevRuntime(store, { apiKey: '', startTimer: false, fetcher: acceptanceReflexProvider,
    evaluate: (context, request) => evaluate(context, request) });
  await runtime.idle();
});
afterEach(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('returns saved thresholds while startup and a workspace mutation are still waiting on native storage', async () => {
  await runtime.shutdown();
  const state = await files.read(workspaceId); state.settings.confidenceThresholds!.profile = 0.85;
  await files.write(workspaceId, state);
  let releaseStorage!: () => void; let releaseWorkspace!: () => void; let storageEntered!: () => void; let workspaceEntered!: () => void;
  const storageHeld = new Promise<void>(resolve => { releaseStorage = resolve; });
  const workspaceHeld = new Promise<void>(resolve => { releaseWorkspace = resolve; });
  const storageStarted = new Promise<void>(resolve => { storageEntered = resolve; });
  const workspaceStarted = new Promise<void>(resolve => { workspaceEntered = resolve; });
  const storageWork = store.jevExecutor.serialized(async () => { storageEntered(); await storageHeld; });
  const workspaceWork = files.serial(workspaceId, async () => { workspaceEntered(); await workspaceHeld; });
  await Promise.all([storageStarted, workspaceStarted]);
  runtime = new JevRuntime(store, { apiKey: '', startTimer: false });
  let received: Awaited<ReturnType<JevRuntime['read']>> | undefined;
  const reading = runtime.read(workspaceId, owner).then(value => { received = value; });
  try {
    await expect.poll(() => received?.settings.confidenceThresholds?.profile, { timeout: 500, interval: 10 }).toBe(0.85);
    expect(received!.jobs).toEqual([]);
    expect(received).not.toHaveProperty('resetJournal');
  } finally {
    releaseWorkspace(); releaseStorage();
    await Promise.all([workspaceWork, storageWork, reading]);
  }
});

it('rejects non-owner and canvas-limited callers and unavailable processing before modifying saved results', async () => {
  const state = await files.read(workspaceId); state.profiles[`${canvasId}:${blockId}`] = { role: 'Previous analysis' };
  await files.write(workspaceId, state); const baseline = await files.read(workspaceId);
  for (const principal of [
    { ...owner, kind: 'automation' as const }, { ...owner, canConfigure: false },
    { ...owner, access: 'read' as const }, { ...owner, allowedCanvasIds: [canvasId] },
  ]) await expect(runtime.reset(workspaceId, principal)).rejects.toMatchObject({ status: 403 });
  await expect(runtime.reset('missing-workspace', owner)).rejects.toMatchObject({ status: 404 });
  await expect(runtime.reset(workspaceId, owner)).rejects.toMatchObject({ status: 503, message: 'Connect a processing provider before resetting Jev' });
  expect(await files.read(workspaceId)).toEqual(baseline);
  runtime.useTransport({ apiKey: 'native-reset-provider' });
  await runtime.configure(workspaceId, { externalProcessing: false }, owner);
  const disabled = await files.read(workspaceId);
  await expect(runtime.reset(workspaceId, owner)).rejects.toMatchObject({ status: 503, message: 'Enable automatic processing before resetting Jev' });
  expect(await files.read(workspaceId)).toEqual(disabled);
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas\nOwner: Alice\nAtlas release requirements.');
});

it('pauses explicit checks and reset for the session without changing saved state', async () => {
  const before = await files.read(workspaceId);
  vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '1');
  await expect(runtime.run(workspaceId, { action: 'profile', canvasId, blockIds: [blockId] }, owner))
    .rejects.toMatchObject({ status: 503, message: 'Jev checks are paused for this app session; saved decisions remain available' });
  await expect(runtime.reset(workspaceId, owner))
    .rejects.toMatchObject({ status: 503, message: 'Jev checks are paused for this app session; saved decisions remain available' });
  expect(await files.read(workspaceId)).toEqual(before);
});

it('cancels an older provider result before clearing results and executes a fresh complete automatic chain', async () => {
  runtime.useTransport({ apiKey: 'native-reset-provider' });
  let release!: () => void; let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  evaluate = async (context, request) => {
    const evaluation = await evaluateJevAction(context, request);
    if (first) {
      first = false;
      for (const proposal of evaluation.proposals) if (proposal.mutation.kind === 'derived') proposal.mutation.values.role = 'Old provider marker';
      started(); await held;
    }
    return evaluation;
  };
  const oldJob = await runtime.run(workspaceId, { action: 'profile', canvasId, blockIds: [blockId] }, owner);
  await entered;
  const source = await store.getCanvasBlock(canvasId, blockId);
  try {
    const reset = await runtime.reset(workspaceId, owner);
    expect(reset.jobs.some(job => job.id === oldJob.id)).toBe(false);
    expect(reset).not.toHaveProperty('resetJournal');
  } finally { release(); }
  await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(new Set(state.jobs.map(job => job.request.action))).toEqual(new Set(jevActions));
  expect(state.jobs.every(job => job.state === 'completed')).toBe(true);
  expect(state.jobs.some(job => job.id === oldJob.id)).toBe(false);
  expect(JSON.stringify(state.profiles)).not.toContain('Old provider marker');
  expect(state.profiles[`${canvasId}:${blockId}`]).toMatchObject({ role: 'specification', organizationContextKey: expect.any(String) });
  expect(state.profiles[`${canvasId}:${blockId}`]).not.toHaveProperty('qualityRubric');
  expect(await store.getCanvasBlock(canvasId, blockId)).toMatchObject({ content: source.content, contentHash: source.contentHash,
    sourceGeneration: source.sourceGeneration, incarnation: source.incarnation, x: 123, y: 456, group: 'custom:atlas', tags: ['Atlas'] });
});

it('recovers a persisted reset before startup backfill and preserves current manual metadata and thresholds', async () => {
  await store.updateBlock(canvasId, blockId, { group: 'custom:manual', tags: ['Manual'] }, 'Browser');
  await runtime.idle(); await runtime.shutdown();
  const state = await files.read(workspaceId) as StoredJevResetWorkspace;
  state.profiles[`${canvasId}:${blockId}`] = { role: 'Previous analysis' };
  state.settings.confidenceThresholds!.profile = 0.85;
  state.settings.paused = true; state.resetJournal = await prepareJevReset(store, workspaceId, state);
  await files.write(workspaceId, state);
  runtime = new JevRuntime(store, { apiKey: 'native-reset-provider', startTimer: false, fetcher: acceptanceReflexProvider });
  await runtime.idle();
  const recovered = await runtime.read(workspaceId, owner);
  expect(recovered.settings).toMatchObject({ paused: false, confidenceThresholds: { profile: 0.85 } });
  expect(new Set(recovered.jobs.map(job => job.request.action))).toEqual(new Set(jevActions));
  expect(recovered.jobs.every(job => job.state === 'completed')).toBe(true);
  expect(recovered).not.toHaveProperty('resetJournal');
  expect(await files.read(workspaceId)).not.toHaveProperty('resetJournal');
  expect(JSON.stringify(recovered.profiles)).not.toContain('Previous analysis');
  expect(await store.getCanvasBlock(canvasId, blockId)).toMatchObject({ group: 'custom:manual', tags: ['Manual'], x: 123, y: 456,
    content: '# Atlas\nOwner: Alice\nAtlas release requirements.' });
});
