import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { jevActions, type JevPrincipal } from '../../shared/jev-types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { resolveSharedQuestionTexts } from './actions/question-state-pool.test.helpers.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let runtime: JevRuntime; let provider: Server;

function unsupported(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: 0.01 };
  if (question.type === 'score') return { type: 'score', score: 2.5, confidence: .99,
    probabilities: { 0: 0, 1: 0, 2: .5, 3: .5 } };
  const keys = Object.keys(question.criteria);
  const selected = keys.find(key => question.criteria[key].includes('"Atlas destination"'))
    ?? ('none' in question.criteria ? 'none' : keys[0]);
  const probabilities = Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0]));
  return { type: 'choice', choice: selected, confidence: 0.99, probabilities };
}

afterEach(async () => {
  vi.useRealTimers();
  await runtime?.shutdown();
  provider?.closeAllConnections();
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.each([
  { status: 503, format: 'text', attempts: 2, failedRequests: 3, body: 'Provider unavailable' },
  { status: 402, format: 'text', attempts: 1, failedRequests: 2, body: 'Payment required' },
  { status: 402, format: 'JSON', attempts: 1, failedRequests: 2,
    body: JSON.stringify({ detail: { error_type: 'insufficient_balance' } }) },
])('bounds an exhausted dependent HTTP $status $format provider failure and automatically restarts its chain after cooldown', async ({ status, attempts, failedRequests, body: failureBody }) => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  let calls = 0; let unavailable = true; let failedCalls = 0;
  provider = createServer(async (request, response) => {
    calls += 1;
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { state: { questionTexts?: unknown }; questions: Record<string, JevQuestion> };
    if (unavailable && JSON.stringify(body.state).includes('"selectedCanvas"') && Object.keys(body.questions).some(id => id.replace(/^(\d+__)+/, '') === 'evidence')) {
      failedCalls += 1; response.statusCode = status; response.end(failureBody); return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'native-followup-retry', answers: Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [id, unsupported(resolveSharedQuestionTexts(question, body.state.questionTexts))])) }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native provider unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'jev-followup-retry-'));
  const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  const workspaceId = (await store.createWorkspace({ name: 'Dependent recovery' })).id;
  await store.createCanvas(workspaceId, { name: 'Atlas destination' });
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  // These assertions cover separate followup jobs; document-root retries have their own native coverage.
  runtime = new JevRuntime(store, { apiKey: 'native-provider', startTimer: false, documentExecution: false,
    fetcher: (url, options) => fetch(`${origin}${new URL(String(url)).pathname}`, options) });
  await runtime.idle();
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nAtlas release requirements.' });
  await runtime.idle();
  const failed = await runtime.read(workspaceId, owner);
  // One optional read is deferred; only a transient failure receives a second durable attempt.
  expect(failedCalls).toBe(failedRequests);
  expect(failed.jobs.map(job => [job.request.action, job.state]).sort()).toEqual([
    ['file', 'completed'], ['flag_duplicate', 'completed'], ['label', 'completed'], ['link', 'completed'], ['profile', 'completed'], ['suggest_home_canvas', 'failed'],
  ]);
  const profile = failed.jobs.find(job => job.request.action === 'profile')!;
  expect(profile.result).toMatchObject({ prefetchDeferredActions: ['suggest_home_canvas'] });
  const failedDependent = failed.jobs.find(job => job.request.action === 'suggest_home_canvas')!;
  const durable = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(durable.jobs.find(job => job.id === failedDependent.id)).toMatchObject({ state: 'failed', attempts });
  expect(Date.parse(failedDependent.createdAt)).toBeGreaterThanOrEqual(Date.parse(profile.updatedAt));
  const checkpoint = failed.profiles[`${canvasId}:${source.id}`];
  expect(checkpoint.organizationContextKey).toBeUndefined();
  expect(checkpoint.organizationFailedContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(Date.parse(String(checkpoint.organizationRetryAt))).toBeGreaterThan(Date.now());
  const stoppedCalls = calls;
  await runtime.tick(); await runtime.idle();
  await runtime.reconcile(workspaceId); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual(failed.jobs);
  expect(calls).toBe(stoppedCalls);
  unavailable = false;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61_000);
  await runtime.tick(); await runtime.idle();
  const recovered = await runtime.read(workspaceId, owner);
  expect(new Set(recovered.jobs.filter(job => job.state === 'completed').map(job => job.request.action))).toEqual(new Set(jevActions));
  const next = recovered.jobs.find(job => job.request.action === 'suggest_home_canvas' && job.state === 'completed')!;
  expect(next.id).not.toBe(failedDependent.id);
  expect(next.request.idempotencyKey).toContain(':retry:');
  expect(recovered.profiles[`${canvasId}:${source.id}`].organizationFailedContextKey).toBeUndefined();
  expect(recovered.profiles[`${canvasId}:${source.id}`].organizationRetryAt).toBeUndefined();
  expect(recovered.profiles[`${canvasId}:${source.id}`].organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(recovered.proposals.filter(proposal => proposal.state === 'pending')).toEqual([]);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).content).toBe(source.content);
  const recoveredCalls = calls;
  await runtime.tick(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual(recovered.jobs);
  expect(calls).toBe(recoveredCalls);
});
