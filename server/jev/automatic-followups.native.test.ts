import { afterEach, expect, it } from 'vitest';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import type { JevAction, JevJob } from '../../shared/jev-types.js';
import { JEV_ORGANIZATION_VERSION } from './followups.js';
import { atomicJson } from '../storage-files.js';

const fixtures: QueueBoundaryFixture[] = [];
const automaticActions: JevAction[] = ['label', 'link', 'flag_duplicate', 'file', 'suggest_home_canvas'];
type ChainedJob = JevJob & { followupActions: JevAction[]; followupKey: string };

async function fixture() { const native = await queueBoundaryFixture(); fixtures.push(native); return native; }
afterEach(async () => { for (const native of fixtures.splice(0)) await native.close(); });
function request(native: QueueBoundaryFixture) {
  return { action: 'profile' as const, canvasId: native.canvasId, blockIds: [native.primary.id],
    idempotencyKey: `automatic:${JEV_ORGANIZATION_VERSION}` };
}

async function finishChain(native: QueueBoundaryFixture, failedAction?: JevAction,
  beforeFinish?: (job: ChainedJob) => Promise<void>) {
  const actions: JevAction[] = [];
  for (let index = 0; index < automaticActions.length; index += 1) {
    const state = await native.files.read(native.workspaceId);
    const job = state.jobs.find(item => item.state === 'queued') as ChainedJob;
    expect(job).toBeDefined(); actions.push(job.request.action);
    await beforeFinish?.(job);
    job.state = job.request.action === failedAction ? 'failed' : 'completed';
    await native.files.write(native.workspaceId, state);
    await native.followups.resume(native.workspaceId, job.request, job.followupActions, job.followupKey);
  }
  return actions;
}

it('automatically schedules the six retained actions in dependency order without querying or enabling removed work', async () => {
  const native = await fixture();
  const profile = await native.admit(request(native));
  const state = await native.files.read(native.workspaceId); state.jobs[0].state = 'completed';
  await native.files.write(native.workspaceId, state);
  await native.followups.queue(native.workspaceId, profile.request);
  expect(await finishChain(native, 'flag_duplicate')).toEqual(automaticActions);
  const completed = await native.files.read(native.workspaceId);
  expect(completed.jobs.map(job => job.request.action).sort()).toEqual(['profile', ...automaticActions].sort());
  expect(completed.jobs.every(job => !job.request.query && !job.request.options)).toBe(true);
  expect(completed.jobs.find(job => job.request.action === 'flag_duplicate')?.state).toBe('failed');
  expect(completed.jobs.find(job => job.request.action === 'suggest_home_canvas')?.state).toBe('completed');
  await native.followups.queue(native.workspaceId, profile.request);
  expect(await native.files.read(native.workspaceId)).toEqual(completed);
});

it('does not duplicate a running source chain when its automatic writes change context and checkpoints the final context', async () => {
  const native = await fixture();
  await native.followups.queue(native.workspaceId, request(native));
  await native.store.updateBlock(native.canvasId, native.primary.id, { quality: { score: 0.9, at: '2026-10-04T12:00:00Z' } }, 'jev');
  const running = await native.files.read(native.workspaceId);
  await native.followups.queue(native.workspaceId, request(native));
  expect(await native.files.read(native.workspaceId)).toEqual(running);
  await finishChain(native);
  const completed = await native.files.read(native.workspaceId);
  expect(completed.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  await native.followups.queue(native.workspaceId, request(native));
  expect(await native.files.read(native.workspaceId)).toEqual(completed);
  await native.store.updateBlock(native.canvasId, native.primary.id,
    { x: 320, quality: { score: 0.9, at: '2026-10-04T13:00:00Z' } }, 'jev');
  await native.followups.queue(native.workspaceId, request(native));
  expect(await native.files.read(native.workspaceId)).toEqual(completed);
});

const contextChanges = {
  document: async (native: QueueBoundaryFixture) => {
    await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { content: '# Rollback\nCurrent supporting reference.' }, 'Browser');
  },
  task: async (native: QueueBoundaryFixture) => {
    await native.store.createTask(native.canvasId, { title: 'Check rollout', detail: 'Attach checked rollout evidence.', blockIds: [] }, 'Browser');
  },
  canvas: async (native: QueueBoundaryFixture) => { await native.store.createCanvas(native.workspaceId, { name: 'Delivery decisions' }); },
  groupPurpose: async (native: QueueBoundaryFixture) => {
    const workspaces = await native.store.listWorkspaces();
    const workspace = workspaces.find(item => item.id === native.workspaceId)!;
    Object.assign(workspace.canvases.find(canvas => canvas.id === native.canvasId)!, {
      groups: [{ id: 'custom:release', name: 'Release', definition: 'Checked release decisions and rollout evidence' }] });
    await atomicJson(`${native.root}/workspaces.json`, workspaces);
  },
  vocabulary: async (native: QueueBoundaryFixture) => {
    const state = await native.files.read(native.workspaceId);
    state.vocabulary.push({ id: 'rollout-label', kind: 'label', name: 'Rollout', definition: 'Rollout evidence', aliases: [],
      state: 'active', version: 1, members: [{ canvasId: native.canvasId, blockId: native.primary.id }] });
    await native.files.write(native.workspaceId, state);
  },
  people: async (native: QueueBoundaryFixture) => {
    const state = await native.files.read(native.workspaceId);
    state.settings.people.push({ id: 'owner', name: 'Ben', role: 'Rollout owner' });
    await native.files.write(native.workspaceId, state);
  },
};

it.each(Object.entries(contextChanges))('automatically refreshes the completed source after a %s change', async (_name, change) => {
  const native = await fixture();
  await native.followups.queue(native.workspaceId, request(native)); await finishChain(native);
  const completed = await native.files.read(native.workspaceId);
  const previous = completed.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey;
  await change(native); await native.followups.queue(native.workspaceId, request(native));
  const refreshed = await native.files.read(native.workspaceId);
  const next = refreshed.jobs.find(job => job.state === 'queued') as ChainedJob;
  expect(next.request.action).toBe('label');
  expect(completed.jobs.some(job => job.id === next.id)).toBe(false);
  expect(next.followupKey.endsWith(String(previous))).toBe(false);
  await native.followups.queue(native.workspaceId, request(native));
  expect(await native.files.read(native.workspaceId)).toEqual(refreshed);
});

it('checkpoints a moved source in its current home after all other dependent actions finish', async () => {
  const native = await fixture();
  await native.followups.queue(native.workspaceId, request(native));
  await finishChain(native, undefined, async job => {
    if (job.request.action === 'suggest_home_canvas') {
      await native.store.moveBlockToCanvas(native.canvasId, native.primary.id, native.otherCanvasId, 'jev');
    }
  });
  const completed = await native.files.read(native.workspaceId);
  expect((await native.store.getCanvas(native.canvasId)).blocks).toEqual([]);
  expect(completed.profiles[`${native.otherCanvasId}:${native.primary.id}`].organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  await native.followups.queue(native.workspaceId, { ...request(native), canvasId: native.otherCanvasId });
  expect(await native.files.read(native.workspaceId)).toEqual(completed);
});

it('does not mark newly edited source content as checked by an older dependent chain', async () => {
  const native = await fixture();
  await native.followups.queue(native.workspaceId, request(native));
  await native.store.updateBlock(native.canvasId, native.primary.id, { content: '# Changed delivery commitment' }, 'Browser');
  await finishChain(native);
  const completed = await native.files.read(native.workspaceId);
  expect(completed.profiles[`${native.canvasId}:${native.primary.id}`]?.organizationContextKey).toBeUndefined();
  await native.followups.queue(native.workspaceId, request(native));
  expect((await native.files.read(native.workspaceId)).jobs.filter(job => job.state === 'queued')).toHaveLength(1);
});

it('handles a whole-canvas automatic chain, skips unavailable sources, and preserves excluded documents', async () => {
  const native = await fixture();
  const excluded = await native.store.createBlock(native.canvasId, { title: 'Private source', content: 'Excluded source.' });
  await native.store.updateBlock(native.canvasId, excluded.id, { processingExcluded: true }, 'Browser');
  const wholeCanvas = { action: 'profile' as const, canvasId: native.canvasId };
  await native.followups.queue(native.workspaceId, { ...wholeCanvas, blockIds: ['missing-source'] });
  expect((await native.files.read(native.workspaceId)).jobs).toEqual([]);
  await native.followups.queue(native.workspaceId, wholeCanvas);
  const queued = await native.files.read(native.workspaceId);
  await native.followups.queue(native.workspaceId, wholeCanvas);
  expect(await native.files.read(native.workspaceId)).toEqual(queued);
  await finishChain(native);
  const completed = await native.files.read(native.workspaceId);
  expect(completed.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(completed.profiles[`${native.canvasId}:${excluded.id}`]).toBeUndefined();
  expect((await native.store.getCanvasBlock(native.canvasId, excluded.id)).content).toBe('Excluded source.');
  await native.followups.queue(native.workspaceId, wholeCanvas);
  expect(await native.files.read(native.workspaceId)).toEqual(completed);
});

it('keeps a source added during a whole-canvas chain eligible for its own automatic checks', async () => {
  const native = await fixture();
  const wholeCanvas = { action: 'profile' as const, canvasId: native.canvasId };
  await native.followups.queue(native.workspaceId, wholeCanvas);
  const added = await native.store.createBlock(native.canvasId, { title: 'New source', content: '# New source' });
  await finishChain(native);
  const completed = await native.files.read(native.workspaceId);
  expect(completed.profiles[`${native.canvasId}:${added.id}`]).toBeUndefined();
  await native.followups.queue(native.workspaceId, { ...wholeCanvas, blockIds: [added.id] });
  expect((await native.files.read(native.workspaceId)).jobs.filter(job => job.state === 'queued')).toHaveLength(1);
});

it('includes the persisted task discussion and vocabulary definitions in automatic context', async () => {
  const native = await fixture();
  const first = await native.store.createTask(native.canvasId, { title: 'First task', detail: 'Declared work', blockIds: [] }, 'Browser');
  await native.store.createTask(native.canvasId, { title: 'Second task', detail: 'Independent work', blockIds: [] }, 'Browser');
  await native.store.commentTask(native.canvasId, first.id, 'Ben owns the rollout evidence.', 'Browser');
  const state = await native.files.read(native.workspaceId);
  state.vocabulary = ['Rollout', 'Rollback'].map((name, index) => ({ id: `native-label-${index}`, kind: 'label' as const, name,
    definition: `${name} supporting evidence`, aliases: [], state: 'active' as const, version: 1, members: [] }));
  await native.files.write(native.workspaceId, state);
  await native.followups.queue(native.workspaceId, request(native)); await finishChain(native);
  const completed = await native.files.read(native.workspaceId);
  await native.followups.queue(native.workspaceId, request(native));
  expect(await native.files.read(native.workspaceId)).toEqual(completed);
});

it('drops obsolete steps from a persisted older chain while completing the retained work', async () => {
  const native = await fixture();
  const original = request(native);
  await native.followups.resume(native.workspaceId, original, ['set_headline', 'vocab_lifecycle', 'file', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall', 'set_freshness', 'label', 'digest'] as JevAction[], original.idempotencyKey);
  const queued = await native.files.read(native.workspaceId);
  expect(queued.jobs.map(job => job.request.action)).toEqual(['file']);
  expect((queued.jobs[0] as ChainedJob).followupActions).toEqual(['label']);
});

it('preserves retained saved order and requests while skipping a retired vocabulary-first step', async () => {
  const native = await fixture();
  const original = request(native);
  const key = `${original.idempotencyKey}:saved-vocabulary-first`;
  await native.followups.resume(native.workspaceId, original, ['vocab_lifecycle', 'label', 'file'], key);
  const saved = await native.files.read(native.workspaceId);
  const first = saved.jobs[0] as ChainedJob;
  expect(first.request.action).toBe('label');
  expect(first.followupActions).toEqual(['file']);
  await native.followups.queue(native.workspaceId, original);
  expect(await native.files.read(native.workspaceId)).toEqual(saved);
  first.state = 'completed';
  await native.files.write(native.workspaceId, saved);
  await native.followups.resume(native.workspaceId, first.request, first.followupActions, first.followupKey);
  const resumed = await native.files.read(native.workspaceId);
  expect(resumed.jobs).toHaveLength(2);
  expect(resumed.jobs.find(job => job.id === first.id)).toEqual(first);
  const next = resumed.jobs.filter(job => job.state === 'queued') as ChainedJob[];
  expect(next).toHaveLength(1);
  expect(next[0].request.action).toBe('file');
  expect(next[0].request.idempotencyKey).toBe(`${key}:file`);
  expect(next[0].followupActions).toEqual([]);
});

it('reports the missing workspace instead of starting an automatic chain in another scope', async () => {
  const native = await fixture();
  await expect(native.followups.queue('missing-workspace', request(native))).rejects.toMatchObject({ status: 404, message: 'Workspace not found' });
  expect((await native.files.read(native.workspaceId)).jobs).toEqual([]);
});

it('automatically retries failed dependent checks after a bounded delay and clears the failure checkpoint on recovery', async () => {
  const native = await fixture();
  await native.followups.queue(native.workspaceId, request(native)); await finishChain(native, 'flag_duplicate');
  const failed = await native.files.read(native.workspaceId);
  const profile = failed.profiles[`${native.canvasId}:${native.primary.id}`];
  expect(profile.organizationContextKey).toBeUndefined();
  expect(profile.organizationFailedContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(Date.parse(String(profile.organizationRetryAt))).toBeGreaterThan(Date.now());
  expect(Date.parse(String(profile.organizationRetryAt))).toBeLessThanOrEqual(Date.now() + 60_000);
  await native.followups.queue(native.workspaceId, request(native));
  expect(await native.files.read(native.workspaceId)).toEqual(failed);
  profile.organizationRetryAt = '2000-01-01T00:00:00.000Z';
  await native.files.write(native.workspaceId, failed);
  await native.followups.queue(native.workspaceId, request(native));
  const retrying = await native.files.read(native.workspaceId);
  const retry = retrying.jobs.find(job => job.state === 'queued')!;
  expect(retry.request.idempotencyKey).toContain(':retry:2000-01-01T00:00:00.000Z:');
  expect(failed.jobs.some(job => job.id === retry.id)).toBe(false);
  await finishChain(native);
  const recovered = await native.files.read(native.workspaceId);
  const saved = recovered.profiles[`${native.canvasId}:${native.primary.id}`];
  expect(saved.organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.organizationFailedContextKey).toBeUndefined(); expect(saved.organizationRetryAt).toBeUndefined();
  await native.followups.queue(native.workspaceId, request(native));
  expect(await native.files.read(native.workspaceId)).toEqual(recovered);
});
