import { afterEach, expect, it } from 'vitest';
import type { JevActionRequest, JevWorkspaceState } from '../../shared/jev-types.js';
import { automationPrincipal, publicJevJob } from './authorization.js';
import { JevFollowupQueue } from './followups.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { enqueueJevJob } from './runtime-queue.js';
import type { StoredJevJob } from './runtime-queue.js';
import { JevWorkspaceFiles } from './workspace.js';
import { mkdir, rename, rm } from 'node:fs/promises';

const fixtures: QueueBoundaryFixture[] = [];
afterEach(async () => { for (const native of fixtures.splice(0)) await native.close(); });
async function fixture() { const native = await queueBoundaryFixture(); fixtures.push(native); return native; }
function observe(native: QueueBoundaryFixture) {
  const reads = native.files.read.bind(native.files); const writes = native.files.write.bind(native.files);
  const admitted: JevWorkspaceState[] = []; let readCount = 0;
  native.files.read = async id => { readCount += 1; return reads(id); };
  native.files.write = async (id, state) => { admitted.push(structuredClone(state)); await writes(id, state); };
  return { admitted, count: () => readCount, read: reads };
}
function folded(native: QueueBoundaryFixture) {
  return new JevFollowupQueue(native.store, native.files, (id, request, admission) =>
    enqueueJevJob(native.store, native.files, native.executor, id, request, automationPrincipal, admission));
}
function request(native: QueueBoundaryFixture): JevActionRequest {
  return { action: 'profile', canvasId: native.canvasId, blockIds: [native.primary.id] };
}

it('persists the complete server-owned followup fields in its first durable admission with one write and two canonical reads', async () => {
  const native = await fixture(); const operation = observe(native);
  const followups = folded(native);
  await followups.resume(native.workspaceId, request(native), ['label', 'link'], 'native-durable-chain');
  expect(operation.admitted).toHaveLength(1);
  expect(operation.count()).toBe(2);
  expect(operation.admitted[0].jobs[0]).toMatchObject({ followupKey: 'native-durable-chain', followupActions: ['link'] });
  const state = await operation.read(native.workspaceId);
  expect(state.jobs[0]).toMatchObject({ followupKey: 'native-durable-chain', followupActions: ['link'], followupSources: state.jobs[0].sources });
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('replays an exact durable admission without annotation I/O and preserves independent original vectors on disk reload', async () => {
  const native = await fixture(); const followups = folded(native);
  await followups.resume(native.workspaceId, request(native), ['label', 'link'], 'native-replay');
  const before = await native.files.read(native.workspaceId); const operation = observe(native);
  await followups.resume(native.workspaceId, request(native), ['label', 'link'], 'native-replay');
  expect(operation.admitted).toEqual([]); expect(operation.count()).toBe(2);
  const reloaded = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(reloaded).toEqual(before);
  const job = reloaded.jobs[0] as StoredJevJob;
  expect(job.followupSources).toEqual(job.sources);
  job.followupSources![0].metadataRevision += 5;
  expect(job.sources[0].metadataRevision).toBe(before.jobs[0].sources[0].metadataRevision);
  expect(await operation.read(native.workspaceId)).toEqual(before);
});

it('repairs a persisted legacy automatic step once while two-argument fixtures keep the checked annotation fallback', async () => {
  const native = await fixture(); const key = 'native-legacy-repair';
  const original = await native.admit({ action: 'label', canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: `${key}:label` }, automationPrincipal);
  const unrelated = await native.admit({ action: 'file', canvasId: native.otherCanvasId, blockIds: [native.secondary.id] });
  const operation = observe(native);
  await folded(native).resume(native.workspaceId, request(native), ['label', 'link'], key);
  expect(operation.admitted).toHaveLength(1); expect(operation.count()).toBe(2);
  const saved = await operation.read(native.workspaceId);
  const repaired = saved.jobs.find(item => item.id === original.id) as StoredJevJob;
  expect(saved.jobs.find(item => item.id === unrelated.id)).toEqual(unrelated);
  expect(repaired).toMatchObject({ id: original.id, createdAt: original.createdAt, state: 'queued', followupActions: ['link'], followupKey: key });
  expect(repaired.followupSources).toEqual(original.sources);
  const legacy = await fixture(); const oldOperation = observe(legacy);
  const oldQueue = new JevFollowupQueue(legacy.store, legacy.files, (id, step) => legacy.enqueue(id, step, automationPrincipal));
  await oldQueue.resume(legacy.workspaceId, request(legacy), ['label', 'link'], 'legacy-callback');
  expect(oldOperation.admitted).toHaveLength(2); expect(oldOperation.count()).toBe(3);
  expect((await oldOperation.read(legacy.workspaceId)).jobs[0]).toMatchObject({ followupKey: 'legacy-callback', followupActions: ['link'] });
});

it('rereads a legacy public callback result without rewriting already complete private durable fields', async () => {
  const native = await fixture();
  const legacy = new JevFollowupQueue(native.store, native.files, async (id, step) => publicJevJob(await native.enqueue(id, step, automationPrincipal)));
  await legacy.resume(native.workspaceId, request(native), ['label', 'link'], 'native-public-callback');
  const before = await native.files.read(native.workspaceId); const operation = observe(native);
  await legacy.resume(native.workspaceId, request(native), ['label', 'link'], 'native-public-callback');
  expect(operation.admitted).toEqual([]); expect(operation.count()).toBe(3);
  expect(await operation.read(native.workspaceId)).toEqual(before);
});

it('tags before retention so the first continuation keeps prior evidence and original sources despite newer unrelated history', async () => {
  const native = await fixture(); const key = 'native-retained-chain';
  const base = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] }, automationPrincipal);
  const previous: StoredJevJob = { ...base, id: 'earliest-chain-evidence', state: 'completed', followupKey: key,
    followupActions: ['label'], followupSources: structuredClone(base.sources), updatedAt: '2025-01-01T00:00:00Z' };
  const state = await native.files.read(native.workspaceId);
  state.jobs = [previous, ...Array.from({ length: 205 }, (_, index): StoredJevJob => ({ ...base,
    id: `newer-history-${index}`, state: 'completed', createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 2))).toISOString() }))];
  await native.files.write(native.workspaceId, state);
  await native.store.updateBlock(native.canvasId, native.primary.id, { tags: ['Manual retained label'] }, 'Browser');
  const operation = observe(native);
  await folded(native).resume(native.workspaceId, request(native), ['label', 'link'], key);
  expect(operation.admitted).toHaveLength(1);
  const written = operation.admitted[0]; const next = written.jobs.find(item => item.state === 'queued') as StoredJevJob;
  expect(written.jobs).toHaveLength(202);
  expect(written.jobs.map(item => item.id)).toContain(previous.id);
  expect(written.jobs.filter(item => item.id.startsWith('newer-history-'))).toHaveLength(200);
  expect(written.jobs.map(item => item.id)).not.toContain('newer-history-4');
  expect(written.jobs.map(item => item.id)).toContain('newer-history-5');
  expect(next.followupSources).toEqual(base.sources);
  expect(next.sources[0].metadataRevision).toBeGreaterThan(base.sources[0].metadataRevision);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).tags).toEqual(['Manual retained label']);
});

it('never converts a same-key manual job or accepts an unbound private payload and leaves durable sources untouched', async () => {
  const native = await fixture(); const key = 'native-manual-key';
  const step = { action: 'label' as const, canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: `${key}:label` };
  await native.admit(step);
  const before = await native.files.read(native.workspaceId); const operation = observe(native);
  await expect(folded(native).resume(native.workspaceId, request(native), ['label'], key)).rejects.toMatchObject({ status: 403 });
  await expect(enqueueJevJob(native.store, native.files, native.executor, native.workspaceId, step,
    automationPrincipal, { key: 'different-key', remaining: [] })).rejects.toMatchObject({ status: 400 });
  expect(operation.admitted).toEqual([]); expect(await operation.read(native.workspaceId)).toEqual(before);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('retries a real interrupted atomic write without a durable untagged step', async () => {
  const native = await fixture(); const file = native.files.file(native.workspaceId); const backup = `${file}.native-backup`;
  const originalWrite = native.files.write.bind(native.files);
  native.files.write = async (id, state) => { await rename(file, backup); await mkdir(file); await originalWrite(id, state); };
  try {
    await expect(folded(native).resume(native.workspaceId, request(native), ['label', 'link'], 'failed-first-write'))
      .rejects.toMatchObject({ code: 'EISDIR' });
  } finally {
    await rm(file, { recursive: true, force: true }); await rename(backup, file); native.files.write = originalWrite;
  }
  expect((await native.files.read(native.workspaceId)).jobs).toEqual([]);
  const operation = observe(native);
  await folded(native).resume(native.workspaceId, request(native), ['label', 'link'], 'failed-first-write');
  expect(operation.admitted).toHaveLength(1);
  expect(operation.admitted[0].jobs[0]).toMatchObject({ followupKey: 'failed-first-write', followupActions: ['link'] });
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('durably tags each of the five dependent admissions, including the final checkpoint boundary', async () => {
  const native = await fixture(); const followups = folded(native); const operation = observe(native);
  await followups.queue(native.workspaceId, request(native));
  const originals = (await operation.read(native.workspaceId)).jobs[0].sources;
  const actions: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    const state = await operation.read(native.workspaceId);
    const pending = state.jobs.find(item => item.state === 'queued') as StoredJevJob;
    expect(pending.followupSources).toEqual(originals);
    actions.push(pending.request.action); pending.state = 'completed'; await native.files.write(native.workspaceId, state);
    await followups.resume(native.workspaceId, pending.request, pending.followupActions!, pending.followupKey!);
  }
  expect(new Set(actions).size).toBe(5);
  const admissions = operation.admitted.filter(state => state.jobs.some(item => item.state === 'queued'));
  expect(admissions).toHaveLength(5);
  for (const state of admissions) expect(state.jobs.find(item => item.state === 'queued'))
    .toMatchObject({ followupKey: expect.any(String), followupActions: expect.any(Array), followupSources: originals });
  const finished = await operation.read(native.workspaceId);
  expect(finished.jobs.every(item => item.state === 'completed')).toBe(true);
  expect(finished.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toEqual(expect.any(String));
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});
