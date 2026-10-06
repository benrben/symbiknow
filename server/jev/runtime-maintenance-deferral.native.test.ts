import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jevActions, type JevActionRequest, type JevEvaluation } from '../../shared/jev-types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { JEV_QUESTION_VERSION, type JevEvaluationContext } from './actions.js';
import { resolveSharedQuestionTexts } from './actions/question-state-pool.test.helpers.js';
import { automationPrincipal } from './authorization.js';
import { JEV_ORGANIZATION_VERSION } from './followups.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { processingPolicyKey } from './runtime-guards.js';
import { JevRuntime } from './runtime.js';
import type { StoredJevJob } from './runtime-queue.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

type Evaluation = { action: JevActionRequest['action']; blockIds: string[] };
type Body = { state: { questionTexts?: string[] }; questions: Record<string, JevQuestion> };
type Call = { evaluation: Evaluation; body: Body; response: ServerResponse };
const scope = new AsyncLocalStorage<Evaluation>();
let native: QueueBoundaryFixture; let runtime: JevRuntime | undefined; let provider: Server | undefined;
let calls: Call[]; let holdProfile: string; let released: boolean; let failProfile: string;
let received: (() => void) | undefined;

function unsupported(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .01 };
  if (question.type === 'score') return { type: 'score', score: 0, confidence: 1,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === 0)])) };
  const choice = Object.hasOwn(question.criteria, 'none') ? 'none' : Object.keys(question.criteria)[0];
  return { type: 'choice', choice, confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) };
}
function respond(call: Call): void {
  const questions = resolveSharedQuestionTexts(call.body.questions, call.body.state.questionTexts);
  call.response.writeHead(200, { 'content-type': 'application/json' });
  call.response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(questions)
    .map(([id, question]) => [id, unsupported(question)])) }));
}
function held(call: Call): boolean {
  return call.evaluation.action === 'profile' && call.evaluation.blockIds.includes(holdProfile);
}
async function untilHeld(): Promise<void> {
  while (!calls.some(call => held(call) && !call.response.writableEnded)) await new Promise<void>(resolve => { received = resolve; });
  received = undefined;
}

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', ''); calls = []; holdProfile = ''; released = false; failProfile = ''; received = undefined;
  native = await queueBoundaryFixture();
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { processingExcluded: true }, 'Browser');
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const evaluation = JSON.parse(String(request.headers['x-native-evaluation'])) as Evaluation;
    const call = { evaluation, body: JSON.parse(raw) as Body, response }; calls.push(call);
    if (call.evaluation.action === 'profile' && call.evaluation.blockIds.includes(failProfile)) {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Native initial profile transport unavailable' }));
    } else if (!held(call) || released) respond(call);
    received?.();
  });
  await new Promise<void>((resolve, reject) => { provider!.once('error', reject); provider!.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native maintenance provider did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  // This suite verifies admission/retry ordering for separate legacy jobs; document-operation recovery has its own native suite.
  runtime = new JevRuntime(native.store, { apiKey: '', startTimer: false, documentExecution: false }); await runtime.idle();
  // Observe the actual built-in evaluator only to tag native HTTP calls; all SDK guards and persistence remain real.
  const observed = runtime as unknown as { evaluateJob(context: JevEvaluationContext, job: StoredJevJob): Promise<JevEvaluation> };
  const evaluate = observed.evaluateJob.bind(runtime);
  observed.evaluateJob = (context, job) => scope.run({ action: job.request.action, blockIds: job.request.blockIds ?? [] },
    () => evaluate(context, job));
  runtime.useTransport({ apiKey: 'native-maintenance-deferral', fetcher: (_url, init) => {
    const headers = new Headers(init?.headers); headers.set('x-native-evaluation', JSON.stringify(scope.getStore()));
    return fetch(origin, { ...init, headers });
  } });
});
afterEach(async () => {
  // A failed no-repeat-root assertion can leave native profile requests held. Release sockets before shutdown.
  provider?.closeAllConnections();
  await runtime?.shutdown();
  if (provider) await new Promise<void>(resolve => provider!.close(() => resolve()));
  await native.close(); vi.unstubAllEnvs();
});

it('defers periodic repeat organization while fresh profiling is pending, then durably rechecks the latest context after the backlog drains', async () => {
  await runtime!.tick(); await runtime!.idle();
  const first = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const originalJobs = first.jobs.filter(job => job.request.blockIds?.includes(native.primary.id)).sort((a, b) => a.id.localeCompare(b.id));
  expect(originalJobs.map(job => job.request.action).sort()).toEqual([...jevActions].sort());
  expect(originalJobs.every(job => job.state === 'completed')).toBe(true);
  const originalCallCount = calls.filter(call => call.evaluation.blockIds.includes(native.primary.id)).length;
  const initialContext = first.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey;
  expect(initialContext).toMatch(/^[a-f0-9]{64}$/);

  // Real import admission precedes periodic maintenance, as in the saved large import backlog.
  const fresh = await native.store.createBlock(native.canvasId, {
    title: 'New Atlas release requirements', content: '# New Atlas\nRetain the new release requirements and checked rollback evidence.', x: 510, y: 91,
  }, automationPrincipal.id);
  holdProfile = fresh.id;
  const pending = await native.files.read(native.workspaceId);
  const source = sourceSnapshot(native.workspaceId, native.canvasId, fresh);
  const policy = createHash('sha256').update(processingPolicyKey(pending)).digest('hex').slice(0, 12);
  const key = `source:${source.canvasId}:${source.blockId}:${source.incarnation}:${source.sourceGeneration}:${JEV_QUESTION_VERSION}:${JEV_ORGANIZATION_VERSION}:${policy}`;
  const admitted = await native.admit({ action: 'profile', canvasId: native.canvasId, blockIds: [fresh.id], idempotencyKey: key }, automationPrincipal);
  await runtime!.tick();
  const atFirstTick = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(atFirstTick.jobs.filter(job => job.request.blockIds?.includes(native.primary.id)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(originalJobs);
  await untilHeld();
  expect(atFirstTick.jobs.some(job => job.id === admitted.id)).toBe(true);

  // An external correction makes the previous successful global context stale while the fresh native provider remains held.
  const corrected = await native.store.updateBlock(native.canvasId, native.primary.id,
    { quality: { score: .37, at: '2026-10-06T00:00:00Z' } }, 'Browser');
  await runtime!.tick(); await runtime!.tick();
  const deferred = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(deferred.jobs.filter(job => job.request.blockIds?.includes(native.primary.id)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(originalJobs);
  expect(deferred.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).toBe(initialContext);
  expect(deferred.jobs.find(job => job.id === admitted.id)).toMatchObject({ state: 'running', attempts: 1 });
  expect(calls.filter(call => call.evaluation.blockIds.includes(native.primary.id))).toHaveLength(originalCallCount);

  released = true;
  for (const call of calls.filter(call => held(call) && !call.response.writableEnded)) respond(call);
  await runtime!.idle();
  const understood = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(understood.jobs.filter(job => job.request.blockIds?.includes(fresh.id) && job.state === 'completed')
    .map(job => job.request.action).sort()).toEqual([...jevActions].sort());
  expect(understood.profiles[`${native.canvasId}:${fresh.id}`].organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(understood.jobs.filter(job => job.request.blockIds?.includes(native.primary.id)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(originalJobs);

  await runtime!.tick(); await runtime!.idle();
  const rechecked = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const originalIds = new Set(originalJobs.map(job => job.id));
  const renewed = rechecked.jobs.filter(job => job.request.blockIds?.includes(native.primary.id) && !originalIds.has(job.id));
  expect(renewed.map(job => job.request.action).sort()).toEqual(jevActions.filter(action => action !== 'profile').sort());
  expect(renewed.every(job => job.state === 'completed')).toBe(true);
  expect(rechecked.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).not.toBe(initialContext);
  const canonical = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  expect({ content: canonical.content, x: canonical.x, y: canonical.y, quality: canonical.quality })
    .toEqual({ content: corrected.content, x: corrected.x, y: corrected.y, quality: corrected.quality });
  const imported = await native.store.getCanvasBlock(native.canvasId, fresh.id);
  expect({ content: imported.content, x: imported.x, y: imported.y }).toEqual({ content: fresh.content, x: fresh.x, y: fresh.y });
  const noNewWork = rechecked.jobs.map(job => job.id).sort();
  await runtime!.tick(); await runtime!.idle();
  expect((await new JevWorkspaceFiles(native.root).read(native.workspaceId)).jobs.map(job => job.id).sort()).toEqual(noNewWork);
});

it('admits a cooldown-eligible failed initial profile before new completed-source rechecks, without an existing pending backlog', async () => {
  await runtime!.tick(); await runtime!.idle();
  const original = await native.files.read(native.workspaceId);
  let oldJobs = original.jobs.filter(job => job.request.blockIds?.includes(native.primary.id)).sort((a, b) => a.id.localeCompare(b.id));
  expect(oldJobs.map(job => job.request.action).sort()).toEqual([...jevActions].sort());
  expect(oldJobs.every(job => job.state === 'completed')).toBe(true);
  let oldCheckpoint = original.profiles[`${native.canvasId}:${native.primary.id}`];
  expect(oldCheckpoint.organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  const fresh = await native.store.createBlock(native.canvasId, {
    title: 'Atlas retry source', content: '# Atlas retry\nKeep the checked initial release and rollback requirements.', x: 611, y: 103,
  }, automationPrincipal.id);
  failProfile = fresh.id;
  await runtime!.tick(); await runtime!.idle();
  const failed = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const attempt = failed.jobs.find(job => job.request.action === 'profile' && job.request.blockIds?.includes(fresh.id))!;
  expect(attempt).toMatchObject({ state: 'failed', attempts: 2 });
  expect(calls.some(call => call.evaluation.action === 'profile' && call.evaluation.blockIds.includes(fresh.id))).toBe(true);
  expect(failed.jobs.every(job => !['queued', 'running'].includes(job.state))).toBe(true);
  // Observe the real idle checkpoint immediately before recovery. This assertion targets the retry scan even on the unfixed implementation.
  oldJobs = failed.jobs.filter(job => job.request.blockIds?.includes(native.primary.id)).sort((a, b) => a.id.localeCompare(b.id));
  oldCheckpoint = failed.profiles[`${native.canvasId}:${native.primary.id}`];
  expect(oldJobs.every(job => job.state === 'completed')).toBe(true);
  expect(oldCheckpoint.organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  await native.store.updateBlock(native.canvasId, native.primary.id,
    { quality: { score: .38, at: '2026-10-06T00:00:00Z' } }, 'Browser');

  // Persist a genuinely failed attempt just beyond the existing real-clock retry boundary. No timer, evaluator, or guard is replaced.
  failed.jobs.find(job => job.id === attempt.id)!.updatedAt = new Date(Date.now() - 61_000).toISOString();
  await native.files.write(native.workspaceId, failed);
  failProfile = ''; holdProfile = fresh.id;
  const oldCalls = calls.filter(call => call.evaluation.blockIds.includes(native.primary.id)).length;
  await runtime!.tick(); await untilHeld();
  const admitted = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const retry = admitted.jobs.find(job => job.request.action === 'profile' && job.state === 'running'
    && job.request.blockIds?.includes(fresh.id))!;
  expect(retry.id).not.toBe(attempt.id);
  expect(retry.request.idempotencyKey).toContain(':retry:');
  expect(retry).toMatchObject({ attempts: 1, sources: [sourceSnapshot(native.workspaceId, native.canvasId, fresh)] });
  expect(admitted.jobs.filter(job => job.request.blockIds?.includes(native.primary.id)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(oldJobs);
  expect(admitted.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(oldCheckpoint);
  expect(calls.filter(call => call.evaluation.blockIds.includes(native.primary.id))).toHaveLength(oldCalls);

  released = true;
  for (const call of calls.filter(call => held(call) && !call.response.writableEnded)) respond(call);
  await runtime!.idle();
  const completed = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const successes = completed.jobs.filter(job => job.state === 'completed' && job.request.blockIds?.includes(fresh.id));
  expect(successes.map(job => job.request.action).sort()).toEqual([...jevActions].sort());
  const profile = completed.profiles[`${native.canvasId}:${fresh.id}`];
  expect(profile).toMatchObject({ source: sourceSnapshot(native.workspaceId, native.canvasId, fresh),
    questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: .7 });
  expect(profile.organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(profile.organizationFailedContextKey).toBeUndefined();
  expect(completed.jobs.filter(job => job.request.blockIds?.includes(native.primary.id)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(oldJobs);
  const canonical = await native.store.getCanvasBlock(native.canvasId, fresh.id);
  expect({ content: canonical.content, x: canonical.x, y: canonical.y }).toEqual({ content: fresh.content, x: fresh.x, y: fresh.y });
  await runtime!.tick(); await runtime!.idle();
  const eventual = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const oldIds = new Set(oldJobs.map(job => job.id));
  const rechecks = eventual.jobs.filter(job => job.request.blockIds?.includes(native.primary.id) && !oldIds.has(job.id));
  expect(rechecks.map(job => job.request.action).sort()).toEqual(jevActions.filter(action => action !== 'profile').sort());
  expect(rechecks.every(job => job.state === 'completed')).toBe(true);
  expect(eventual.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey).not.toBe(oldCheckpoint.organizationContextKey);
});
