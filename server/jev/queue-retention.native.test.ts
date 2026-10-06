import { afterEach, expect, it } from 'vitest';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import type { StoredJevJob } from './runtime-queue.js';

const fixtures: QueueBoundaryFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

it('retains completed evidence from an active automatic chain while bounding unrelated history', async () => {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  const base = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] });
  const state = await native.files.read(native.workspaceId);
  const running: StoredJevJob = { ...base, id: 'active-chain', state: 'running', followupKey: 'automatic-chain' };
  const older: StoredJevJob = { ...base, id: 'older-chain-decision', state: 'completed', followupKey: 'automatic-chain', updatedAt: '2025-01-01T00:00:00Z' };
  const failed: StoredJevJob = { ...older, id: 'failed-chain-decision', state: 'failed' };
  const history = Array.from({ length: 205 }, (_, index): StoredJevJob => ({ ...base, id: `history-${index}`, state: 'completed', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() }));
  state.jobs = [running, older, failed, ...history]; await native.files.write(native.workspaceId, state);
  const admitted = await native.admit({ action: 'label', canvasId: native.canvasId, blockIds: [native.primary.id] });
  const saved = await native.files.read(native.workspaceId);
  expect(saved.jobs.filter(job => ['queued', 'running'].includes(job.state)).map(job => job.id)).toEqual([running.id, admitted.id]);
  expect(saved.jobs.filter(job => job.id.startsWith('history-'))).toHaveLength(200);
  expect(saved.jobs.map(job => job.id)).toEqual(expect.arrayContaining([older.id, failed.id]));
  expect(saved.jobs.map(job => job.id)).not.toContain('history-0');
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('compacts completed chains after their final action while retaining the newest durable history', async () => {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  const base = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] });
  const state = await native.files.read(native.workspaceId);
  state.jobs = Array.from({ length: 205 }, (_, index) => ({ ...base, id: `done-${index}`, state: 'completed', followupKey: 'finished-chain', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() } as StoredJevJob));
  await native.files.write(native.workspaceId, state);
  const admitted = await native.admit({ action: 'label', canvasId: native.canvasId, blockIds: [native.primary.id] });
  const saved = await native.files.read(native.workspaceId);
  expect(saved.jobs).toHaveLength(201); expect(saved.jobs[0].id).toBe(admitted.id);
  expect(saved.jobs.some(job => job.id === 'done-0')).toBe(false);
  expect(saved.jobs.some(job => job.id === 'done-204')).toBe(true);
});

it('waits at queue capacity and preserves every independently saved source for later automatic admission', async () => {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  const base = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] });
  const state = await native.files.read(native.workspaceId);
  state.jobs = Array.from({ length: 200 }, (_, index) => ({ ...base, id: `queued-${index}`, state: 'queued' } as StoredJevJob));
  await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  expect((await native.files.read(native.workspaceId)).jobs).toHaveLength(200);
  await expect(native.admit({ action: 'label', canvasId: native.canvasId, blockIds: [native.primary.id] })).rejects.toMatchObject({ status: 429 });
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
  expect((await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id)).content).toBe(native.secondary.content);
});
