import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { jevActions, type JevPrincipal } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './actions/question-state-pool.test.helpers.js';

type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime | undefined; let provider: Server;
let workspaceId: string; let canvasId: string; let source: CanvasBlock; let taskId: string; let origin: string;
const calls: Body[] = [];

function scoped(body: Body, id: string) {
  const pool = body.state.sourceStates;
  let state = body.state; let name = id; let match: RegExpExecArray | null;
  while ((match = /^(\d+)__(.+)$/.exec(name))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(match[1])]; name = match[2];
  }
  return { state: resolveSharedQuestionSources(state, pool), name };
}
function decision(body: Body, id: string, submitted: JevQuestion): JevAnswer {
  const question = resolveSharedQuestionTexts(submitted, body.state.questionTexts);
  const { state, name } = scoped(body, id);
  if (question.type === 'noul') return { type: 'noul', noul: ['addressesAi', 'conflict', 'synonymous'].includes(name) ? 0.01 : 0.98 };
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const fixed: Record<string, string> = { parent: 'none', pair: 'none', role: 'specification', canvas: 'c0',
    evidence: 'assignment' in state ? 'p1' : keys[0] };
  const selected = question.type === 'choice' ? /^evidence_\d+$/.test(name) && 'assignment' in state ? 'p1' : fixed[name] ?? keys[0] : keys.at(-1)!;
  const probabilities = Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0]));
  return question.type === 'choice' ? { type: 'choice', choice: selected, confidence: 0.98, probabilities }
    : { type: 'score', score: keys.length - 1, confidence: 0.98, probabilities };
}

beforeAll(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body; calls.push(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'native-prefetch-provider', answers: Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [id, decision(body, id, question)])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native prefetch provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'jev-prefetch-native-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Native question prefetch' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  taskId = (await store.createTask(canvasId, { title: 'Atlas release', detail: 'Carry out Atlas release requirements.' }, 'Browser')).id;
  source = await store.createBlock(canvasId, { title: 'Atlas', x: 123, y: 456,
    content: '# Atlas\nOwner: Alice\nAtlas release requirements.' });
});
afterAll(async () => {
  await runtime?.shutdown(); provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

it('retains validated answers across a sixty-one-second queue delay and commits all six fresh guarded jobs through the real typed SDK', async () => {
  const write = JevWorkspaceFiles.prototype.write; let delayed = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  JevWorkspaceFiles.prototype.write = async function (workspace, state) {
    await write.call(this, workspace, state);
    if (!delayed && state.jobs.some(job => job.request.action === 'profile' && job.state === 'completed')) {
      delayed = true; vi.setSystemTime(Date.now() + 61_000);
    }
  };
  try {
    runtime = new JevRuntime(store, { apiKey: 'native-prefetch-key', startTimer: false,
      fetcher: (_url, options) => fetch(origin, options) });
    await runtime.idle();
    expect(delayed).toBe(true);
  } finally { JevWorkspaceFiles.prototype.write = write; vi.useRealTimers(); }
  const names = Object.keys(calls[0].questions).map(id => scoped(calls[0], id).name);
  expect(names, `${calls.length} native SDK requests were made`).toEqual(expect.arrayContaining([
    'role', 'keyPassage',
  ]));
  expect(names).not.toContain('canvas');
  expect(names).not.toEqual(expect.arrayContaining(['specificity', 'matches', 'person']));
  expect(calls.length).toBeLessThan(6);
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs).toHaveLength(6);
  expect(new Set(state.jobs.map(job => job.request.action))).toEqual(new Set(jevActions));
  expect(state.jobs.every(job => job.state === 'completed')).toBe(true);
  expect(state.proposals.filter(proposal => proposal.state === 'pending')).toEqual([]);
  for (const name of ['role']) {
    expect(calls.flatMap(body => Object.keys(body.questions).map(id => scoped(body, id).name)).filter(id => id === name)).toHaveLength(1);
  }
  await writeFile('/tmp/jev-question-prefetch-native-metrics.json', JSON.stringify({ requests: calls.length,
    questions: calls.reduce((sum, body) => sum + Object.keys(body.questions).length, 0), initialQuestions: names }, null, 2));
  const reloaded = new CanvasStore(root);
  expect(await reloaded.getCanvasBlock(canvasId, source.id)).toMatchObject({ content: source.content, x: source.x, y: source.y,
    group: 'custom:atlas', tags: ['Atlas'] });
  expect((await reloaded.listTasks(canvasId)).find(task => task.id === taskId)).toMatchObject({ blockIds: [] });
  expect(state.profiles[`${canvasId}:${source.id}`]).toMatchObject({ role: 'specification' });
  const before = calls.length; await runtime.tick(); await runtime.idle();
  expect(calls).toHaveLength(before);
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual(state.jobs);
});
