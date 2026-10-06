import { mkdir,rename,rm } from 'node:fs/promises';
import { afterEach,expect,it } from 'vitest';
import { acceptanceReflexProvider } from '../../features/acceptance-reflex-provider.js';
import type { JevJob } from '../../shared/jev-types.js';
import { decideWithJev } from '../jev.js';
import { evaluateJevAction,JEV_QUESTION_VERSION } from './actions.js';
import { evaluationContext } from './context.js';
import { boundaryOwner,queueBoundaryFixture,type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { JevRuntimeMaintenance } from './runtime-maintenance.js';
import { recordJevCandidates } from './runtime-proposals.js';
import { sourceSnapshot } from './stamps.js';

const fixtures: QueueBoundaryFixture[] = [];
async function fixture(initialize = true) { const native = await queueBoundaryFixture(initialize); fixtures.push(native); return native; }
afterEach(async () => { for (const native of fixtures.splice(0)) await native.close(); });
async function recordProposal(native: QueueBoundaryFixture, job: JevJob) {
  const state = await native.files.read(native.workspaceId);
  const context = await evaluationContext(native.store, native.workspaceId, state, job.request, boundaryOwner, new AbortController().signal);
  context.apiKey = 'native-boundary-provider';
  context.decider = (key, input, questions, _fetcher, options) => decideWithJev(key, input, questions, acceptanceReflexProvider, options);
  const evaluation = await evaluateJevAction(context, job.request);
  expect(evaluation.proposals.length).toBeGreaterThan(0);
  recordJevCandidates(state, state.jobs.find(item => item.id === job.id)!, evaluation, context);
  await native.files.write(native.workspaceId, state);
}

it('keeps completed native profile followups idempotent and does not backfill explicitly excluded sources', async () => {
  const native = await fixture();
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { processingExcluded: true }, 'Browser');
  const block = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const state = await native.files.read(native.workspaceId);
  state.settings.modes.profile = 'auto';
  state.profiles[`${native.canvasId}:${block.id}`] = { source: { ...sourceSnapshot(native.workspaceId, native.canvasId, block) },
    questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: 0.7 };
  await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  const completed = await native.files.read(native.workspaceId);
  expect(completed.jobs).toHaveLength(1); expect(completed.jobs[0].request.action).toBe('label');
  await native.maintenance.reconcile(await native.workspace()); expect(await native.files.read(native.workspaceId)).toEqual(completed);
});

it('does not admit duplicate native backfill requests and requeues only unowned interrupted jobs', async () => {
  const native = await fixture();
  await native.maintenance.reconcile(await native.workspace());
  const first = await native.files.read(native.workspaceId); expect(first.jobs).toHaveLength(2);
  await native.maintenance.reconcile(await native.workspace()); expect(await native.files.read(native.workspaceId)).toEqual(first);
  const interrupted = structuredClone(first); for (const job of interrupted.jobs) job.state = 'running';
  native.running.set(interrupted.jobs[1].id, new AbortController());
  interrupted.settings.paused = true; await native.files.write(native.workspaceId, interrupted);
  await native.maintenance.reconcile(await native.workspace());
  const recovered = await native.files.read(native.workspaceId);
  expect(recovered.jobs.map(job => job.state)).toEqual(['queued', 'running']);
});

it('propagates native non-capacity queue failures while preserving the independent source write', async () => {
  const native = await fixture(); const stateFile = native.files.file(native.workspaceId); const backup = stateFile + '.backup';
  const maintenance = new JevRuntimeMaintenance(native.store, native.files, native.executor, native.followups, async (id, request) => {
    await rename(stateFile, backup); await mkdir(stateFile);
    return native.enqueue(id, request);
  }, native.running);
  try { await expect(maintenance.reconcile(await native.workspace())).rejects.toMatchObject({ code: 'EISDIR' }); }
  finally { await rm(stateFile, { recursive: true }); await rename(backup, stateFile); }
  expect((await native.files.read(native.workspaceId)).jobs).toEqual([]);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('aborts and prunes native jobs whose request or candidate context disappeared after a real deletion', async () => {
  const native = await fixture();
  const direct = await native.admit({ action: 'profile', canvasId: native.canvasId, blockIds: [native.primary.id] });
  await recordProposal(native, direct);
  const related = await native.admit({ action: 'file', canvasId: native.otherCanvasId, blockIds: [native.secondary.id] });
  const scoped = await native.admit({ action: 'file', canvasId: native.otherCanvasId, blockIds: [native.secondary.id] },
    { ...boundaryOwner, allowedCanvasIds: [native.otherCanvasId] });
  const directController = new AbortController(); const relatedController = new AbortController();
  native.running.set(direct.id, directController); native.running.set(related.id, relatedController);
  await native.store.deleteBlock(native.canvasId, native.primary.id, 'Browser');
  await native.maintenance.deleted({ workspaceId: native.workspaceId, canvasId: native.canvasId, blockIds: [native.primary.id], kind: 'delete', actor: 'Browser' });
  expect(directController.signal.aborted).toBe(true); expect(relatedController.signal.aborted).toBe(true);
  expect((await native.files.read(native.workspaceId)).jobs.map(job => job.id)).toEqual([scoped.id]);
  expect((await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id)).content).toBe(native.secondary.content);
});

it('prunes orphaned native context on recovery before backfilling remaining sources', async () => {
  const native = await fixture();
  const job = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] });
  await native.store.deleteBlock(native.canvasId, native.primary.id, 'Browser');
  await native.maintenance.reconcile(await native.workspace());
  const recovered = await native.files.read(native.workspaceId);
  expect(recovered.jobs.some(item => item.id === job.id)).toBe(false);
  expect(recovered.jobs.map(item => item.request.canvasId)).toEqual([native.otherCanvasId]);
  expect((await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id)).content).toBe(native.secondary.content);
});

it('handles a real deletion before Reflex has any saved workspace state without creating an empty ledger', async () => {
  const native = await fixture(false);
  await native.store.deleteBlock(native.canvasId, native.primary.id, 'Browser');
  await native.maintenance.deleted({ workspaceId: native.workspaceId, canvasId: native.canvasId, blockIds: [native.primary.id], kind: 'delete', actor: 'Browser' });
  expect((await native.files.read(native.workspaceId)).revision).toBe(0);
  expect((await native.store.getCanvas(native.canvasId)).blocks).toEqual([]);
});
