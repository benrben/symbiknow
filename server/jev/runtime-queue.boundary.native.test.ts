import { afterEach,expect,it } from 'vitest';
import { automationPrincipal } from './authorization.js';
import { queueBoundaryFixture,type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';

const fixtures: QueueBoundaryFixture[] = [];
async function fixture() { const current = await queueBoundaryFixture(); fixtures.push(current); return current; }
afterEach(async () => { for (const current of fixtures.splice(0)) await current.close(); });

it('replays a persisted legacy operation key only for its original exact request', async () => {
  const native = await fixture();
  const request = { action: 'file' as const, canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: 'legacy-native-operation' };
  const admitted = await native.admit(request);
  const state = await native.files.read(native.workspaceId);
  delete (state.jobs[0] as typeof admitted).requestFingerprint;
  await native.files.write(native.workspaceId, state);
  const before = await native.files.read(native.workspaceId);
  expect((await native.admit(request)).id).toBe(admitted.id);
  await expect(native.admit({ ...request, query: 'A different request under the same key' })).rejects.toMatchObject({ status: 409 });
  expect(await native.files.read(native.workspaceId)).toEqual(before);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('coalesces only queued automation requests while preserving actual queued owner work', async () => {
  const native = await fixture();
  const request = { action: 'file' as const, canvasId: native.canvasId, blockIds: [native.primary.id] };
  const owner = await native.admit(request);
  const running = await native.admit(request, automationPrincipal);
  const state = await native.files.read(native.workspaceId); state.jobs.find(job => job.id === running.id)!.state = 'running';
  await native.files.write(native.workspaceId, state);
  const first = await native.admit(request, automationPrincipal);
  const other = await native.admit({ ...request, canvasId: native.otherCanvasId, blockIds: [native.secondary.id] }, automationPrincipal);
  const newest = await native.admit(request, automationPrincipal);
  const saved = await native.files.read(native.workspaceId);
  expect(saved.jobs.find(job => job.id === owner.id)?.state).toBe('queued');
  expect(saved.jobs.find(job => job.id === running.id)?.state).toBe('running');
  expect(saved.jobs.find(job => job.id === first.id)?.state).toBe('cancelled');
  expect(saved.jobs.find(job => job.id === other.id)?.state).toBe('queued');
  expect(saved.jobs.find(job => job.id === newest.id)?.state).toBe('queued');
});

it('records selected source guards and workspace context and rejects paused or removed action admission without canonical writes', async () => {
  const native = await fixture();
  const queued = await native.admit({ action: 'link', canvasId: native.canvasId, blockIds: [native.primary.id] });
  expect(queued.sources.map(source => source.canvasId)).toEqual([native.canvasId]);
  expect(queued.contextSources?.map(source => source.canvasId)).toEqual([native.canvasId, native.otherCanvasId]);
  const state = await native.files.read(native.workspaceId); state.settings.paused = true; await native.files.write(native.workspaceId, state);
  await expect(native.admit({ action: 'file', canvasId: native.canvasId })).rejects.toMatchObject({ status: 409 });
  state.settings.paused = false; state.settings.modes.file = 'auto'; await native.files.write(native.workspaceId, state);
  await expect(native.admit({ action: 'set_headline', canvasId: native.canvasId })).rejects.toMatchObject({ status: 400 });
  expect((await native.files.read(native.workspaceId)).jobs.map(job => job.id)).toEqual([queued.id]);
});
