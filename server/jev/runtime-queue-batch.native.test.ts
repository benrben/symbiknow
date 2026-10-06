import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevActionRequest } from '../../shared/jev-types.js';
import { automationPrincipal } from './authorization.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { enqueueJevJobs } from './runtime-queue-batch.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

let native: QueueBoundaryFixture;
beforeEach(async () => { native = await queueBoundaryFixture(); });
afterEach(async () => { await native.close(); });
function request(canvasId = native.canvasId, blockId = native.primary.id): JevActionRequest {
  return { action: 'profile', canvasId, blockIds: [blockId], idempotencyKey: `native-source:${canvasId}:${blockId}` };
}
function admit(requests: JevActionRequest[], principal = automationPrincipal) {
  return native.files.serial(native.workspaceId, () => enqueueJevJobs(native.store, native.files, native.executor,
    native.workspaceId, requests, principal));
}
function disk() { return readFile(native.files.file(native.workspaceId)); }

it('shares a fresh native context across canvases while retaining independent source jobs and exact idempotent bytes', async () => {
  const requests = [request(), request(native.otherCanvasId, native.secondary.id)];
  const result = await admit(requests);
  expect(result.full).toBe(false); expect(result.jobs).toHaveLength(2);
  expect(result.jobs.map(job => job.sources)).toEqual([
    [sourceSnapshot(native.workspaceId, native.canvasId, await native.store.getCanvasBlock(native.canvasId, native.primary.id))],
    [sourceSnapshot(native.workspaceId, native.otherCanvasId, await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id))],
  ]);
  expect(result.jobs[0].contextSources).toEqual(result.jobs[1].contextSources);
  const bytes = await disk();
  expect(await admit(requests)).toEqual(result); expect(await disk()).toEqual(bytes);
  requests[0].blockIds![0] = 'caller-edit'; result.jobs[0].sources[0].contentHash = 'caller-edit';
  expect((await new JevWorkspaceFiles(native.root).read(native.workspaceId)).jobs[0].sources[0].contentHash).not.toBe('caller-edit');
});

it('handles an empty authorized batch without reading or writing a new ledger', async () => {
  const bytes = await disk(); expect(await admit([])).toEqual({ jobs: [], full: false }); expect(await disk()).toEqual(bytes);
});

it.each([
  { action: 'label' }, { blockIds: [] }, { query: 'different scope' }, { options: { operation: 'explicit' } },
] as Partial<JevActionRequest>[])('refuses a non-source-profile batch without changing durable bytes: %j', async patch => {
  const bytes = await disk(); await expect(admit([{ ...request(), ...patch }])).rejects.toMatchObject({ status: 400 });
  expect(await disk()).toEqual(bytes);
});

it('refuses changed automatic authorization and commits no earlier valid source when a later canvas selection is unavailable', async () => {
  const bytes = await disk();
  await expect(admit([request()], boundaryOwner)).rejects.toMatchObject({ status: 403 });
  await expect(admit([request(), request(native.otherCanvasId, 'missing-source')])).rejects.toMatchObject({ status: 404 });
  expect(await disk()).toEqual(bytes);
  await expect(admit([request(), { ...request(native.otherCanvasId, native.secondary.id),
    idempotencyKey: request().idempotencyKey }])).rejects.toMatchObject({ status: 409 });
  expect(await disk()).toEqual(bytes);
});

it('retains queue capacity and permits exact idempotent replay even when two hundred jobs are pending', async () => {
  const first = (await admit([request()])).jobs[0];
  const owner = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] });
  const state = await native.files.read(native.workspaceId);
  state.jobs = [first, ...Array.from({ length: 199 }, (_, index) => ({ ...owner, id: `native-held-${index}` }))];
  await native.files.write(native.workspaceId, state); const bytes = await disk();
  expect(await admit([request()])).toEqual({ jobs: [first], full: false });
  expect(await admit([request(native.otherCanvasId, native.secondary.id)])).toEqual({ jobs: [], full: true });
  expect(await disk()).toEqual(bytes);
});

it('honors the current native Pause policy before admitting a source', async () => {
  const state = await native.files.read(native.workspaceId);
  state.settings.paused = true;
  await native.files.write(native.workspaceId, state); const bytes = await disk();
  await expect(admit([request()])).rejects.toMatchObject({ status: 409 }); expect(await disk()).toEqual(bytes);
});

it('retains the mandatory automatic-mode migration for legacy off settings during native admission', async () => {
  const state = await native.files.read(native.workspaceId); state.settings.modes.profile = 'off';
  await native.files.write(native.workspaceId, state);
  expect((await admit([request()])).jobs[0]).toMatchObject({ state: 'queued', request: request() });
  expect((await new JevWorkspaceFiles(native.root).read(native.workspaceId)).settings.modes.profile).toBe('auto');
});
