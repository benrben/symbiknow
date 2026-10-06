import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { acceptanceReflexProvider } from '../../features/acceptance-reflex-provider.js';
import { jevActions, type JevActionRequest } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { evaluateJevAction, type JevEvaluationContext } from './actions.js';
import { JevRuntime } from './runtime.js';

type Fixture = { root: string; store: CanvasStore; workspaceId: string; canvasId: string; documents: CanvasBlock[] };
type Evaluation = { id: string; action: JevActionRequest['action']; workspaceId: string; sources: string[]; signal?: AbortSignal };
type ProviderCall = { evaluation: Evaluation; active: Evaluation[]; closed: Promise<void> };
type ProviderBody = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
const scope = new AsyncLocalStorage<Evaluation>();
const localActions = new Set(['profile', 'label']);
const active = new Map<string, Evaluation>();
const held = new Set<ServerResponse>();
let provider: Server; let origin: string; let runtime: JevRuntime | undefined;
let profileFixture: Fixture; let completeFixture: Fixture;
let calls: ProviderCall[]; let started: Array<{ evaluation: Evaluation; active: Evaluation[] }>; let settled: Evaluation[];
let peak: number; let holdProfiles: boolean; let received: (() => void) | undefined;
let profileGate: Promise<void> | undefined; let releaseProfiles: (() => void) | undefined;

async function fixture(count: number): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-parallel-native-'));
  const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  const workspaceId = (await store.createWorkspace({ name: 'Independent automatic sources' })).id;
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  const documents = await Promise.all(Array.from({ length: count }, (_, index) => store.createBlock(canvasId, {
    title: `Atlas guide ${index + 1}`, x: 321 + index * 500, y: 654,
    content: `# Atlas guide ${index + 1}\nPlatform · Atlas delivery\nOwner: Alice\nAtlas delivery retains reviewed source history and release requirements.`,
  })));
  return { root, store, workspaceId, canvasId, documents };
}

function questionState(body: ProviderBody, id: string): Record<string, unknown> {
  const batch = /^(\d+)__/.exec(id);
  return batch ? (body.state.questionSets as Record<string, unknown>[])[Number(batch[1])] : body.state;
}
function choose(question: Extract<JevQuestion, { type: 'choice' }>, selected: string): JevAnswer {
  return { type: 'choice', choice: selected, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) };
}
function adjustedAnswer(id: string, question: JevQuestion, answer: JevAnswer, state: Record<string, unknown>): JevAnswer {
  const name = id.replace(/^\d+__/, '');
  if (question.type === 'noul' && ['conflict', 'synonymous'].includes(name)) return { type: 'noul', noul: 0.01 };
  if (question.type !== 'choice') return answer;
  if (['canvas', 'parent', 'pair'].includes(name)) return choose(question, 'none');
  if (name !== 'concept' || state.kind !== 'label') return answer;
  const source = state.source as { title: string };
  const exact = Object.keys(question.criteria).find(key => question.criteria[key] === source.title);
  return exact ? choose(question, exact) : answer;
}

beforeAll(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const evaluation = active.get(String(request.headers['x-native-evaluation']));
    if (!evaluation) throw new Error('Provider request lost its native evaluation');
    const call: ProviderCall = { evaluation, active: [...active.values()], closed: new Promise(resolve => response.once('close', resolve)) };
    calls.push(call); received?.();
    if (holdProfiles && evaluation.action === 'profile') { held.add(response); return; }
    if (profileGate && evaluation.action === 'profile') await profileGate;
    const body = JSON.parse(raw) as ProviderBody;
    const accepted = await acceptanceReflexProvider('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: raw });
    const result = await accepted.json() as { answers: Record<string, JevAnswer> };
    for (const [id, question] of Object.entries(body.questions)) {
      result.answers[id] = adjustedAnswer(id, question, result.answers[id], questionState(body, id));
    }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native parallel provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
  profileFixture = await fixture(6);
  completeFixture = await fixture(2);
  await completeFixture.store.updateBlock(completeFixture.canvasId, completeFixture.documents[1].id,
    { group: 'custom:human', tags: ['Human'], reviewer: 'Human reviewer' }, 'Browser');
});
beforeEach(() => { calls = []; started = []; settled = []; peak = 0; holdProfiles = false; received = undefined; profileGate = undefined; releaseProfiles = undefined; active.clear(); runtime = undefined; });
afterEach(async () => {
  runtime?.close(); releaseProfiles?.();
  await runtime?.shutdown();
  for (const response of held) response.destroy(); held.clear();
  provider.closeAllConnections();
});
afterAll(async () => {
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await Promise.all([rm(profileFixture.root, { recursive: true, force: true }), rm(completeFixture.root, { recursive: true, force: true })]);
  vi.unstubAllEnvs();
});

function start(fixture: Fixture): JevRuntime {
  return new JevRuntime(fixture.store, { apiKey: 'native-parallel-provider', startTimer: false,
    fetcher: (_url, options) => {
      const evaluation = scope.getStore(); if (!evaluation) throw new Error('Missing scoped SDK request');
      const headers = new Headers(options?.headers); headers.set('x-native-evaluation', evaluation.id);
      return fetch(origin, { ...options, headers });
    },
    evaluate: async (context: JevEvaluationContext, request: JevActionRequest) => {
      const evaluation: Evaluation = { id: randomUUID(), action: request.action, workspaceId: context.workspaceId,
        sources: (request.blockIds ?? []).map(id => `${request.canvasId}:${id}`), signal: context.signal };
      active.set(evaluation.id, evaluation); peak = Math.max(peak, active.size);
      started.push({ evaluation, active: [...active.values()] });
      try { return await scope.run(evaluation, () => evaluateJevAction(context, request)); }
      finally { active.delete(evaluation.id); settled.push(evaluation); }
    } });
}

async function withinHalfSecond(pending: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
  } finally { clearTimeout(timer); }
}

it('runs four distinct automatic profiles through concurrent native SDK requests and shutdown cancels and waits for all four', async () => {
  holdProfiles = true;
  let firstReceived!: () => void; let fourReceived!: () => void;
  const first = new Promise<void>(resolve => { firstReceived = resolve; });
  const four = new Promise<void>(resolve => { fourReceived = resolve; });
  received = () => { firstReceived(); if (calls.length === 4) fourReceived(); };
  runtime = start(profileFixture);
  await first;
  const concurrent = await withinHalfSecond(four);
  expect(concurrent, `Only ${calls.length} native profiles reached the provider together`).toBe(true);
  expect(calls).toHaveLength(4);
  expect(new Set(calls.map(call => call.evaluation.sources[0])).size).toBe(4);
  expect(calls.every(call => call.evaluation.action === 'profile')).toBe(true);
  expect(peak).toBe(4);
  const running = (await runtime.read(profileFixture.workspaceId)).jobs.filter(job => job.state === 'running');
  expect(running).toHaveLength(4);
  await runtime.shutdown();
  await Promise.all(calls.map(call => call.closed));
  expect(active.size).toBe(0);
  expect(settled).toHaveLength(4);
  expect(settled.every(evaluation => evaluation.signal?.aborted)).toBe(true);
  expect(calls).toHaveLength(4);
  expect(started).toHaveLength(4);
  for (const source of profileFixture.documents) {
    expect((await profileFixture.store.getCanvasBlock(profileFixture.canvasId, source.id)).content).toBe(source.content);
  }
});

it('completes all six checks on real sources while broad jobs stay exclusive and manual metadata survives reload', async () => {
  let firstReceived!: () => void; let twoReceived!: () => void;
  const first = new Promise<void>(resolve => { firstReceived = resolve; });
  const two = new Promise<void>(resolve => { twoReceived = resolve; });
  profileGate = new Promise<void>(resolve => { releaseProfiles = resolve; });
  received = () => {
    if (calls.filter(call => call.evaluation.action === 'profile').length === 1) firstReceived();
    if (calls.filter(call => call.evaluation.action === 'profile').length === 2) { releaseProfiles!(); twoReceived(); }
  };
  runtime = start(completeFixture);
  await first;
  const concurrent = await withinHalfSecond(two);
  releaseProfiles!();
  expect(concurrent, 'Two saved profiles must reach the native provider concurrently').toBe(true);
  await runtime.idle();
  const state = await runtime.read(completeFixture.workspaceId);
  expect(state.jobs.filter(job => job.state !== 'completed')).toEqual([]);
  expect(state.proposals.filter(proposal => ['pending', 'stale'].includes(proposal.state))).toEqual([]);
  expect(state.jobs.every(job => !job.result?.automaticFailures), JSON.stringify(state.jobs.filter(job => job.result?.automaticFailures))).toBe(true);
  for (const source of completeFixture.documents) {
    expect(new Set(state.jobs.filter(job => job.request.blockIds?.includes(source.id)).map(job => job.request.action))).toEqual(new Set(jevActions));
    expect(state.profiles[`${completeFixture.canvasId}:${source.id}`]).toMatchObject({ role: expect.any(String) });
  }
  expect(calls.length).toBeGreaterThan(6);
  expect(peak).toBeGreaterThanOrEqual(2); expect(peak).toBeLessThanOrEqual(4);
  for (const event of [...started, ...calls]) {
    const peers = event.active.filter(evaluation => evaluation.workspaceId === event.evaluation.workspaceId);
    if (!localActions.has(event.evaluation.action)) expect(peers).toHaveLength(1);
    if (peers.length > 1) {
      expect(peers.every(evaluation => localActions.has(evaluation.action))).toBe(true);
      const sources = peers.flatMap(evaluation => evaluation.sources);
      expect(new Set(sources).size).toBe(sources.length);
    }
  }
  expect(active.size).toBe(0);
  expect(settled).toHaveLength(started.length);
  const reloaded = new CanvasStore(completeFixture.root); await reloaded.init();
  for (const source of completeFixture.documents) {
    const saved = await reloaded.getCanvasBlock(completeFixture.canvasId, source.id);
    expect(saved).toMatchObject({ content: source.content, x: source.x, y: source.y, sourceGeneration: source.sourceGeneration });
  }
  expect(await reloaded.getCanvasBlock(completeFixture.canvasId, completeFixture.documents[1].id))
    .toMatchObject({ group: 'custom:human', tags: ['Human'], reviewer: 'Human reviewer' });
});
