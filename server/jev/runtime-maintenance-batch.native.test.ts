import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevActionRequest } from '../../shared/jev-types.js';
import { atomicJson } from '../storage-files.js';
import { storedBlock, type StoredCanvas } from '../storage-shapes.js';
import { automationPrincipal } from './authorization.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { JevRuntimeMaintenance } from './runtime-maintenance.js';
import { enqueueJevJobs } from './runtime-queue-batch.js';
import { initializeJevStamp, sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

let native: QueueBoundaryFixture;
beforeEach(async () => {
  native = await queueBoundaryFixture();
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { processingExcluded: true }, 'Browser');
  const primary = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const blocks = [primary, ...Array.from({ length: 145 }, (_, index) => initializeJevStamp({
    ...primary, id: `backfill-source-${index}`, file: `docs/backfill-source-${index}.md`,
    title: `Atlas rollout ${index}`, content: `# Atlas rollout ${index}\nKeep the checked release evidence for Atlas rollout ${index}.`,
    incarnation: undefined, sourceGeneration: undefined, metadataRevision: undefined, jevOwnership: undefined,
    x: index * 32, y: index * 16,
  }))];
  await Promise.all(blocks.slice(1).map(block => writeFile(path.join(native.root, block.file), block.content)));
  const file = path.join(native.root, 'canvases', `${native.canvasId}.json`);
  const canvas = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
  await atomicJson(file, { ...canvas, blocks: blocks.map(storedBlock) });
});
afterEach(async () => { await native.close(); });

function maintenance() {
  return new JevRuntimeMaintenance(native.store, native.files, native.executor, native.followups,
    native.enqueue, native.running, async () => true, (id, requests) => enqueueJevJobs(
      native.store, native.files, native.executor, id, requests, automationPrincipal));
}
async function retainLastProfile() {
  const block = (await native.store.getCanvas(native.canvasId, true, false)).blocks.at(-1)!;
  const state = await native.files.read(native.workspaceId);
  state.profiles[`${native.canvasId}:${block.id}`] = {
    source: { ...sourceSnapshot(native.workspaceId, native.canvasId, block) },
    questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: .7,
  };
  await native.files.write(native.workspaceId, state);
  return block;
}

it('admits 146 independent native profiles with one corpus context and one durable ledger write', async () => {
  const before = await native.store.getCanvas(native.canvasId, true, false);
  let contextReads = 0; let ledgerWrites = 0;
  const getCanvas = native.store.getCanvas.bind(native.store);
  native.store.getCanvas = async (id, archived, labels) => {
    if (archived === true && labels === false) contextReads += 1;
    return getCanvas(id, archived, labels);
  };
  const write = native.files.write.bind(native.files);
  native.files.write = async (id, state) => { ledgerWrites += 1; await write(id, state); };
  const enqueueBatch = (id: string, requests: JevActionRequest[]) => enqueueJevJobs(
    native.store, native.files, native.executor, id, requests, automationPrincipal);
  const maintenance = new JevRuntimeMaintenance(native.store, native.files, native.executor, native.followups,
    native.enqueue, native.running, async () => true, enqueueBatch);
  const started = performance.now();
  await maintenance.reconcile(await native.workspace());
  const durationMs = performance.now() - started;
  expect(contextReads).toBe(2);
  expect(ledgerWrites).toBe(1);
  const durable = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(durable.jobs).toHaveLength(146);
  expect(new Set(durable.jobs.map(job => job.id)).size).toBe(146);
  expect(new Set(durable.jobs.map(job => job.request.idempotencyKey)).size).toBe(146);
  expect(durable.jobs.every(job => job.state === 'queued' && job.request.action === 'profile')).toBe(true);
  expect(durable.jobs.map(job => job.sources)).toEqual(before.blocks.map(block => [sourceSnapshot(native.workspaceId, native.canvasId, block)]));
  expect(await getCanvas(native.canvasId, true, false)).toEqual(before);
  ledgerWrites = 0; contextReads = 0;
  await maintenance.reconcile(await native.workspace());
  expect(ledgerWrites).toBe(0); expect(contextReads).toBe(0);
  expect(await native.files.read(native.workspaceId)).toEqual(durable);
  await writeFile('/tmp/jev-maintenance-batch-native-metrics.json', JSON.stringify({ documents: 146, contextReads: 2,
    ledgerWrites: 1, independentJobs: durable.jobs.length, durationMs }));
});

it('preserves source admission order by committing earlier profiles before a later ordinary followup', async () => {
  const retained = await retainLastProfile();
  await maintenance().reconcile(await native.workspace());
  const state = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(state.jobs).toHaveLength(146);
  expect(state.jobs.slice(0, -1).every(job => job.request.action === 'profile')).toBe(true);
  expect(state.jobs.at(-1)).toMatchObject({ state: 'queued', request: { action: 'label', blockIds: [retained.id] } });
  expect(state.jobs.at(-1)!.sources).toEqual([sourceSnapshot(native.workspaceId, native.canvasId, retained)]);
});

it('retains the admitted profile prefix and stops before a later followup when queue capacity is reached', async () => {
  await retainLastProfile();
  const held = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] });
  const before = await native.files.read(native.workspaceId);
  before.jobs = Array.from({ length: 199 }, (_, index) => ({ ...held, id: `held-owner-${index}` }));
  await native.files.write(native.workspaceId, before);
  await maintenance().reconcile(await native.workspace());
  const state = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(state.jobs).toHaveLength(200);
  expect(state.jobs.slice(0, 199)).toEqual(before.jobs);
  expect(state.jobs.at(-1)).toMatchObject({ state: 'queued', request: { action: 'profile', blockIds: [native.primary.id] } });
  expect(state.jobs.filter(job => job.id.startsWith('held-owner-'))).toHaveLength(199);
  expect(state.jobs.filter(job => job.request.action === 'profile')).toHaveLength(1);
});

it('propagates an actual failed batch persistence boundary without changing source files or the original ledger', async () => {
  const before = await native.files.read(native.workspaceId);
  const sources = await native.store.getCanvas(native.canvasId, true, false);
  const file = native.files.file(native.workspaceId); const backup = `${file}.before`;
  const broken = new JevRuntimeMaintenance(native.store, native.files, native.executor, native.followups,
    native.enqueue, native.running, async () => true, async (id, requests) => {
      await rename(file, backup); await mkdir(file);
      return enqueueJevJobs(native.store, native.files, native.executor, id, requests, automationPrincipal);
    });
  try { await expect(broken.reconcile(await native.workspace())).rejects.toMatchObject({ code: 'EISDIR' }); }
  finally { await rm(file, { recursive: true }); await rename(backup, file); }
  expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
  expect(await native.store.getCanvas(native.canvasId, true, false)).toEqual(sources);
});

it.each([undefined, 'checked-profile-evaluation'])('refreshes completed native profiling after a changed confidence cutoff with evaluation %s', async profileEvaluationId => {
  const current = maintenance();
  await current.reconcile(await native.workspace());
  let state = await native.files.read(native.workspaceId);
  const original = state.jobs[0]; original.state = 'completed';
  await native.files.write(native.workspaceId, state);
  const previous = await native.admit({ ...original.request, idempotencyKey: `${original.request.idempotencyKey}:retry:previous` }, automationPrincipal);
  state = await native.files.read(native.workspaceId);
  state.jobs.find(job => job.id === previous.id)!.state = 'completed';
  const block = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  state.profiles[`${native.canvasId}:${block.id}`] = {
    source: { ...sourceSnapshot(native.workspaceId, native.canvasId, block) },
    questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: .99,
    ...(profileEvaluationId ? { profileEvaluationId } : {}),
  };
  await native.files.write(native.workspaceId, state);
  await current.reconcile(await native.workspace());
  const fresh = (await new JevWorkspaceFiles(native.root).read(native.workspaceId)).jobs
    .filter(job => job.state === 'queued' && job.request.blockIds?.includes(block.id));
  expect(fresh).toHaveLength(1);
  expect(fresh[0].id).not.toBe(original.id); expect(fresh[0].id).not.toBe(previous.id);
  expect(fresh[0].request.idempotencyKey).toContain(':retry:profile-cutoff:');
  expect(fresh[0].sources).toEqual([sourceSnapshot(native.workspaceId, native.canvasId, block)]);
});
