import { afterEach, expect, it } from 'vitest';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { JEV_ORGANIZATION_VERSION } from './followups.js';

const fixtures: QueueBoundaryFixture[] = [];
async function fixture() { const native = await queueBoundaryFixture(); fixtures.push(native); return native; }
afterEach(async () => { for (const native of fixtures.splice(0)) await native.close(); });

it('durably queues rechecking actual existing connections after the earlier organization actions', async () => {
  const native = await fixture();
  const peer = await native.store.createBlock(native.canvasId, { title: 'Linked rollout source', content: '# Rollout reference' });
  await native.store.updateBlock(native.canvasId, native.primary.id, { links: [peer.id] }, 'Browser');
  const request = { action: 'profile' as const, canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: `source:${JEV_ORGANIZATION_VERSION}` };
  await native.followups.queue(native.workspaceId, request);
  const first = await native.files.read(native.workspaceId);
  expect(first.jobs).toHaveLength(1);
  const queued = first.jobs[0] as typeof first.jobs[0] & { followupActions: string[]; followupKey: string };
  expect(queued.request.action).toBe('label');
  expect(queued.followupActions).toEqual(['link', 'flag_duplicate', 'file', 'suggest_home_canvas']);
  expect(queued.followupKey).toMatch(new RegExp(`^${request.idempotencyKey}:`));
  await native.followups.queue(native.workspaceId, request);
  expect(await native.files.read(native.workspaceId)).toEqual(first);
});

it('finishes native source organization once and keeps the completion revision unchanged on resume', async () => {
  const native = await fixture();
  const request = { action: 'profile' as const, canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: 'completed-native-organization' };
  await native.followups.resume(native.workspaceId, request, [], request.idempotencyKey);
  const completed = await native.files.read(native.workspaceId);
  expect(completed.profiles[`${native.canvasId}:${native.primary.id}`].organizationKey).toBe(request.idempotencyKey);
  expect(completed.jobs).toEqual([]);
  await native.followups.resume(native.workspaceId, request, [], request.idempotencyKey);
  await native.followups.queue(native.workspaceId, request);
  expect(await native.files.read(native.workspaceId)).toEqual(completed);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('resumes durable terminal steps and takes a fresh native source snapshot for each dependent job', async () => {
  const native = await fixture();
  const request = { action: 'profile' as const, canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: 'terminal-native-chain' };
  await native.followups.resume(native.workspaceId, request, ['file', 'label'], request.idempotencyKey);
  const state = await native.files.read(native.workspaceId); const first = state.jobs[0]; first.state = 'completed';
  await native.files.write(native.workspaceId, state);
  const changed = await native.store.updateBlock(native.canvasId, native.primary.id, { headline: 'Current checked source' }, 'Browser');
  await native.followups.resume(native.workspaceId, request, ['file', 'label'], request.idempotencyKey);
  const resumed = await native.files.read(native.workspaceId); expect(resumed.jobs).toHaveLength(2);
  const second = resumed.jobs.find(job => job.request.action === 'label')!;
  expect(second.sources[0].metadataRevision).toBe(changed.metadataRevision);
  expect(second.id).not.toBe(first.id); expect(resumed.jobs.find(job => job.id === first.id)?.state).toBe('completed');
  second.state = 'failed'; await native.files.write(native.workspaceId, resumed);
  await native.followups.resume(native.workspaceId, request, ['file', 'label'], request.idempotencyKey);
  const completed = await native.files.read(native.workspaceId);
  expect(completed.profiles[`${native.canvasId}:${native.primary.id}`].organizationKey).toBe(request.idempotencyKey);
  expect(completed.jobs).toHaveLength(2);
  expect(completed.jobs.find(job => job.id === first.id)?.state).toBe('completed');
  expect(completed.jobs.find(job => job.id === second.id)?.state).toBe('failed');
});
