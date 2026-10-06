import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jevActions, type JevPrincipal } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './actions/question-state-pool.test.helpers.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';
import type { DocumentJob } from './runtime-document.js';

type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime | undefined; let provider: Server;
let workspaceId: string; let canvasId: string; let source: CanvasBlock; let taskId: string; let origin: string;
let invalid = true; let badCalls = 0;
const calls: Body[] = [];

function scoped(body: Body, id: string) {
  let state = body.state; let name = id; let match: RegExpExecArray | null;
  while ((match = /^(\d+)__(.+)$/.exec(name))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(match[1])]; name = match[2];
  }
  return { state: resolveSharedQuestionSources(state, body.state.sourceStates), name };
}
function selectedName(name: string, state: Record<string, unknown>, keys: string[]): string {
  const fixed: Record<string, string> = { parent: 'none', pair: 'none', role: 'specification', canvas: 'c0' };
  if (/^evidence(?:_\d+)?$/.test(name) && 'assignment' in state) return 'p1';
  return fixed[name] ?? keys[0];
}
function decision(body: Body, id: string, submitted: JevQuestion): JevAnswer {
  const question = resolveSharedQuestionTexts(submitted, body.state.questionTexts);
  const { state, name } = scoped(body, id);
  if (question.type === 'noul') return { type: 'noul', noul: ['addressesAi', 'conflict', 'synonymous'].includes(name) ? .01 : .98 };
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const selected = question.type === 'choice' ? selectedName(name, state, keys) : keys.at(-1)!;
  const probabilities = Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0]));
  if (invalid && name === 'canvas') return { type: 'choice', choice: 'none', confidence: .98, probabilities };
  return question.type === 'choice' ? { type: 'choice', choice: selected, confidence: .98, probabilities }
    : { type: 'score', score: keys.length - 1, confidence: .98, probabilities };
}

beforeEach(async () => {
  invalid = true; badCalls = 0; calls.length = 0; runtime = undefined;
  vi.stubEnv('TYPESAFE_API_KEY', '');
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body; calls.push(body);
    if (invalid && Object.keys(body.questions).some(id => scoped(body, id).name === 'canvas')) badCalls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, decision(body, id, question)])) }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native isolated runtime provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'jev-question-isolation-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Native isolated questions' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  await store.createCanvas(workspaceId, { name: 'Alternative destination' });
  taskId = (await store.createTask(canvasId, { title: 'Atlas release', detail: 'Carry out Atlas release requirements.' }, 'Browser')).id;
  source = await store.createBlock(canvasId, { title: 'Atlas', x: 123, y: 456,
    content: '# Atlas\nOwner: Alice\nAtlas release requirements.' });
});
afterEach(async () => {
  vi.useRealTimers(); await runtime?.shutdown();
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

it.each([false, true])('isolates invalid optional answers and resumes all six after cooldown (document execution: %s)', async documentExecution => {
  runtime = new JevRuntime(store, { apiKey: 'native-isolated-runtime', startTimer: false,
    documentExecution,
    fetcher: (_url, options) => fetch(origin, options) });
  await runtime.idle();
  const first = await runtime.read(workspaceId, owner);
  const profile = first.jobs.find(job => job.request.action === 'profile')!;
  expect(profile, JSON.stringify(first.jobs.map(job => ({ action: job.request.action, state: job.state, error: job.error })))).toMatchObject({ state: documentExecution ? 'failed' : 'completed', result: { prefetchDeferredActions: ['suggest_home_canvas'] } });
  const failed = first.jobs.find(job => job.request.action === 'suggest_home_canvas')!;
  expect(failed).toMatchObject({ state: 'failed', error: 'Jev selected a non-leading choice' });
  expect(badCalls).toBe(3);
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).jobs.find(job => job.id === failed.id)).toMatchObject({ state: 'failed', attempts: 2 });
  expect(first.jobs.filter(job => job.request.action === 'profile')).toHaveLength(1);
  expect(calls.flatMap(body => Object.keys(body.questions).map(id => scoped(body, id).name)).filter(name => name === 'role')).toHaveLength(1);
  expect(first.profiles[`${canvasId}:${source.id}`]).toMatchObject({ role: 'specification' });
  if (documentExecution) {
    const durableProfile = (await new JevWorkspaceFiles(root).read(workspaceId)).jobs.find(job => job.id === profile.id) as DocumentJob;
    expect(durableProfile.documentPlan).toMatchObject({ failedAction: 'suggest_home_canvas', retryAt: expect.any(String) });
    expect(durableProfile.documentPlan?.completedActions).toHaveLength(5);
    expect(first.profiles[`${canvasId}:${source.id}`].organizationContextKey).toBeUndefined();
  } else expect(first.profiles[`${canvasId}:${source.id}`].organizationRetryAt).toEqual(expect.any(String));
  const nativeBefore = await new CanvasStore(root).getCanvasBlock(canvasId, source.id);
  expect(nativeBefore).toMatchObject({ content: source.content, x: source.x, y: source.y, group: 'custom:atlas', tags: ['Atlas'] });
  expect((await new CanvasStore(root).listTasks(canvasId)).find(task => task.id === taskId))
    .toMatchObject({ blockIds: [] });
  const stopped = calls.length;
  await runtime.tick(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual(first.jobs); expect(calls).toHaveLength(stopped);
  invalid = false; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61_000);
  await runtime.tick(); await runtime.idle();
  const recovered = await runtime.read(workspaceId, owner);
  expect(new Set(recovered.jobs.filter(job => job.state === 'completed').map(job => job.request.action))).toEqual(new Set(jevActions));
  const retry = recovered.jobs.find(job => job.request.action === 'suggest_home_canvas' && job.state === 'completed')!;
  if (documentExecution) expect(retry.id).toBe(failed.id);
  else { expect(retry.id).not.toBe(failed.id); expect(retry.request.idempotencyKey).toContain(':retry:'); }
  expect(recovered.profiles[`${canvasId}:${source.id}`].organizationRetryAt).toBeUndefined();
  expect(recovered.profiles[`${canvasId}:${source.id}`].organizationContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(recovered.proposals.filter(proposal => proposal.state === 'pending')).toEqual([]);
  expect(await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).toMatchObject({ content: source.content, x: source.x, y: source.y });
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).jobs.find(job => job.id === retry.id)).toMatchObject({ state: 'completed' });
  const settled = calls.length;
  await runtime.tick(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual(recovered.jobs); expect(calls).toHaveLength(settled);
});
