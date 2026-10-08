import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jevActions, type JevActionRequest } from '../../shared/jev-types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { acceptanceReflexProvider } from '../../features/acceptance-reflex-provider.js';
import { evaluateJevAction } from './actions.js';
import { automationPrincipal } from './authorization.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { JevRuntime } from './runtime.js';
import { enqueueJevJob } from './runtime-queue.js';

let native: QueueBoundaryFixture; let provider: Server; let runtime: JevRuntime | undefined;
let origin: string; let calls: number; let started: JevActionRequest[];
let questionCalls: string[][];

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  calls = 0; started = []; questionCalls = []; runtime = undefined;
  native = await queueBoundaryFixture();
  provider = createServer(async (request, response) => {
    calls += 1;
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { questions: Record<string, JevQuestion> };
    questionCalls.push(Object.keys(body.questions).map(key => key.replace(/^(\d+__)+/, '')));
    const accepted = await acceptanceReflexProvider('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: raw });
    const result = await accepted.json() as { answers: Record<string, JevAnswer> };
    // The provider can decline a canvas move; this fixture measures scheduling on stable saved sources.
    for (const [key, question] of Object.entries(body.questions)) {
      if (['place', 'gate'].includes(key.replace(/^(?:\d+__)+/, '')) && question.type === 'choice') {
        result.answers[key] = { type: 'choice', choice: 'none', confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(choice => [choice, choice === 'none' ? 1 : 0])) };
      }
    }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native scheduler provider failed');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await runtime?.shutdown(); provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await native.close(); vi.unstubAllEnvs();
});

function startSavedJobs() {
  runtime = new JevRuntime(native.store, { apiKey: 'native-scheduler-provider', startTimer: false,
    fetcher: (_url, options) => fetch(`${origin}/v1/systemone`, options),
    evaluate: async (context, request) => { started.push(request); return evaluateJevAction(context, request); } });
}
async function processSavedJobs() {
  startSavedJobs();
  await runtime!.idle();
  return runtime!.read(native.workspaceId);
}

it('consumes a checked persisted relationship chain before an older fresh profile through the real SDK', async () => {
  await native.store.updateBlock(native.canvasId, native.primary.id, { group: 'custom:manual', tags: ['Reviewed'],
    crossLinks: [{ canvasId: native.otherCanvasId, blockId: native.secondary.id, relation: 'related' }] }, 'Browser');
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { group: 'custom:manual', tags: ['Manual'] }, 'Browser');
  const key = 'persisted-native-chain';
  const chain = await native.files.serial(native.workspaceId, () => enqueueJevJob(native.store, native.files, native.executor,
    native.workspaceId, { action: 'link', canvasId: native.canvasId, blockIds: [native.primary.id],
      idempotencyKey: `${key}:link` }, automationPrincipal, { key, remaining: [] }));
  const fresh = await native.admit({ action: 'profile', canvasId: native.otherCanvasId,
    idempotencyKey: 'older-fresh-source-profile' }, automationPrincipal);
  const queued = await native.files.read(native.workspaceId);
  queued.jobs.find(job => job.id === fresh.id)!.createdAt = '2020-01-01T00:00:00Z';
  queued.jobs.find(job => job.id === chain.id)!.createdAt = '2021-01-01T00:00:00Z';
  await native.files.write(native.workspaceId, queued);
  startSavedJobs();
  await expect.poll(async () => {
    const state = await native.files.read(native.workspaceId);
    return [chain.id, fresh.id].map(id => {
      const job = state.jobs.find(job => job.id === id); return { state: job?.state, error: job?.error };
    });
  }, { timeout: 3000 }).toEqual([{ state: 'completed', error: undefined }, { state: 'completed', error: undefined }]);
  await runtime!.shutdown();
  expect(started[0]).toMatchObject({ action: 'link', idempotencyKey: `${key}:link` });
  expect(started.findIndex(request => request.idempotencyKey === fresh.request.idempotencyKey)).toBeGreaterThan(0);
  expect(questionCalls[0]).toContain('supported');
  expect(questionCalls[0]).not.toContain('role');
  expect(questionCalls.some(questions => questions.includes('role'))).toBe(true);
  const durable = await native.files.read(native.workspaceId);
  expect(durable.jobs.find(job => job.id === chain.id)).toMatchObject({ state: 'completed', followupKey: key, followupActions: [] });
  const reloaded = new CanvasStore(native.root); await reloaded.init();
  expect(await reloaded.getCanvasBlock(native.canvasId, native.primary.id)).toMatchObject({
    content: native.primary.content, group: 'custom:manual', tags: ['Reviewed'], x: native.primary.x, y: native.primary.y });
  expect(await reloaded.getCanvasBlock(native.otherCanvasId, native.secondary.id)).toMatchObject({
    content: native.secondary.content, group: 'custom:manual', tags: ['Manual'], x: native.secondary.x, y: native.secondary.y });
});

it('executes newer filing and understanding while rejecting an older relationship scope after checked metadata changes', async () => {
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { group: 'custom:manual', tags: ['Manual'] }, 'Browser');
  await native.store.updateBlock(native.canvasId, native.primary.id, { group: 'custom:atlas-manual', tags: ['Reviewed'] }, 'Browser');
  // Whole-canvas requests remain distinct from maintenance's selected roots.
  // The older relationship snapshot must still reject newer checked metadata.
  const older = await native.admit({ action: 'link', canvasId: native.otherCanvasId,
    idempotencyKey: 'older-ready-relationship' }, automationPrincipal);
  const newer = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id],
    idempotencyKey: 'newer-ready-file' }, automationPrincipal);
  const profile = await native.admit({ action: 'profile', canvasId: native.canvasId,
    idempotencyKey: 'newest-ready-profile' }, automationPrincipal);
  const queued = await native.files.read(native.workspaceId);
  queued.jobs.find(job => job.id === older.id)!.createdAt = '2020-01-01T00:00:00Z';
  queued.jobs.find(job => job.id === newer.id)!.createdAt = '2021-01-01T00:00:00Z';
  queued.jobs.find(job => job.id === profile.id)!.createdAt = '2022-01-01T00:00:00Z';
  await native.files.write(native.workspaceId, queued);
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { purpose: 'Updated while queued' }, 'Browser');
  startSavedJobs();
  await expect.poll(async () => {
    const state = await native.files.read(native.workspaceId);
    return [newer.id, profile.id, older.id].map(id => {
      const job = state.jobs.find(job => job.id === id); return { state: job?.state, error: job?.error };
    });
  }, { timeout: 3000 }).toEqual([{ state: 'completed', error: undefined }, { state: 'completed', error: undefined },
    { state: 'failed', error: 'The source changed since Symbi Reflex reviewed it' }]);
  await runtime!.idle();
  await runtime!.shutdown();
  const state = await runtime!.read(native.workspaceId);
  expect(started[0]).toMatchObject({ action: 'file', idempotencyKey: 'newer-ready-file' });
  const profilePosition = started.findIndex(request => request.idempotencyKey === 'newest-ready-profile');
  expect(profilePosition).toBeGreaterThan(0);
  expect(started.some(request => request.idempotencyKey === 'older-ready-relationship')).toBe(false);
  expect(state.jobs.find(job => job.id === newer.id)?.state).toBe('completed');
  const stale = state.jobs.find(job => job.id === older.id)!;
  expect(stale).toMatchObject({ state: 'failed', error: 'The source changed since Symbi Reflex reviewed it' });
  expect(Date.parse(stale.updatedAt)).toBeGreaterThanOrEqual(Date.parse(state.jobs.find(job => job.id === profile.id)!.updatedAt));
  const durable = await native.files.read(native.workspaceId);
  expect(durable.jobs.filter(job => job.request.action === 'link' && job.request.blockIds?.includes(native.secondary.id)))
    .toContainEqual(expect.objectContaining({ state: 'completed', followupKey: expect.any(String) }));
  expect(state.jobs.find(job => job.id === profile.id)?.state).toBe('completed');
  expect(state.profiles[`${native.canvasId}:${native.primary.id}`]).toMatchObject({ role: expect.any(String) });
  expect(calls).toBeGreaterThan(0);
  const reloaded = new CanvasStore(native.root); await reloaded.init();
  expect((await reloaded.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
  expect(await reloaded.getCanvasBlock(native.canvasId, native.primary.id)).toMatchObject({ group: 'custom:atlas-manual', tags: ['Reviewed'] });
  expect((await reloaded.getCanvasBlock(native.otherCanvasId, native.secondary.id)).content).toBe(native.secondary.content);
  expect(await reloaded.getCanvasBlock(native.otherCanvasId, native.secondary.id)).toMatchObject({ group: 'custom:manual', tags: ['Manual'] });
});

it('keeps every automatic action progressing across a saved-source backlog without starving supporting checks', async () => {
  const third = await native.store.createBlock(native.canvasId, { title: 'Atlas release reference', content: '# Atlas release reference\nDeployment requirements.' });
  await native.store.updateBlock(native.canvasId, third.id, { group: 'custom:manual', tags: ['Manual'] }, 'Browser');
  const sources = [{ canvasId: native.canvasId, block: third }, { canvasId: native.canvasId, block: native.primary }, { canvasId: native.otherCanvasId, block: native.secondary }];
  // Keep this saved source's manual organization stable while its already-ready
  // advisory check waits beside the automatic classification backlog.
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { group: 'custom:manual', tags: ['Manual'] }, 'Browser');
  const supporting = await native.admit({ action: 'flag_duplicate', canvasId: native.otherCanvasId,
    idempotencyKey: 'older-ready-duplicate' }, automationPrincipal);
  const state = await processSavedJobs();
  expect(state.jobs.filter(job => ['queued', 'running', 'failed'].includes(job.state)).map(job => ({
    action: job.request.action, state: job.state, error: job.error }))).toEqual([]);
  for (const { canvasId, block } of sources) {
    const completed = state.jobs.filter(job => job.state === 'completed' && job.request.blockIds?.includes(block.id));
    expect(new Set(completed.map(job => job.request.action))).toEqual(new Set(jevActions));
    expect(state.profiles[`${canvasId}:${block.id}`]).toMatchObject({ role: expect.any(String) });
    expect((await native.store.getCanvasBlock(canvasId, block.id)).content).toBe(block.content);
  }
  const firstBackground = started.findIndex(request => !['file', 'label', 'profile'].includes(request.action));
  const lastOrganization = started.map(request => ['file', 'label', 'profile'].includes(request.action)).lastIndexOf(true);
  expect(firstBackground).toBeGreaterThanOrEqual(0); expect(firstBackground).toBeLessThan(lastOrganization);
  expect(started[firstBackground]).toMatchObject({ action: 'flag_duplicate', idempotencyKey: 'older-ready-duplicate' });
  expect(state.jobs.find(job => job.id === supporting.id)?.state).toBe('completed');
  expect(await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id)).toMatchObject({ group: 'custom:manual', tags: ['Manual'] });
  expect(calls).toBeGreaterThan(sources.length);
});
