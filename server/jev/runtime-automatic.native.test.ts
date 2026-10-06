import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jevActions, type JevPrincipal } from '../../shared/jev-types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './actions/question-state-pool.test.helpers.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let provider: Server;
let workspaceId: string; let canvasId: string; let origin: string; let calls: number; let unavailable: boolean;
let supported: boolean; let moveToSecond: boolean;

function questionInput(id: string, state: Record<string, unknown>) {
  const pool = state.sourceStates;
  let batch: RegExpExecArray | null;
  while ((batch = /^(\d+)__(.+)$/.exec(id))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(batch[1])];
    id = batch[2];
  }
  return { id, state: resolveSharedQuestionSources(state, pool) };
}

function decision(key: string, submitted: JevQuestion, state: Record<string, unknown>): JevAnswer {
  const question = resolveSharedQuestionTexts(submitted, state.questionTexts);
  const { id, state: local } = questionInput(key, state);
  if (question.type === 'noul') return { type: 'noul', noul: ['addressesAi', 'conflict', 'synonymous'].includes(id) || !supported ? 0.01 : 0.98 };
  if (question.type === 'score') return { type: 'score', score: 2, confidence: 0.98,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 2 ? 1 : 0])) };
  const keys = Object.keys(question.criteria);
  const choices: Record<string, string> = { parent: 'none', pair: 'none', role: 'specification',
    canvas: moveToSecond ? 'c1' : 'c0', evidence: 'assignment' in local ? 'p1' : keys[0] };
  const selected = /^evidence_\d+$/.test(id) && 'assignment' in local ? 'p1' : choices[id] ?? keys[0];
  return { type: 'choice', choice: selected, confidence: 0.98,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) };
}

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  calls = 0; unavailable = false; supported = true; moveToSecond = false;
  provider = createServer(async (request, response) => {
    calls += 1;
    if (unavailable) { response.statusCode = 503; response.end('Provider unavailable'); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'jev-native-automatic', answers: Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [id, decision(id, question, body.state)])) }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native provider failed');
  origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'jev-automatic-native-'));
  store = new CanvasStore(root); await store.init();
  await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Automatic knowledge' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  runtime = new JevRuntime(store, { apiKey: 'native-automatic-provider', startTimer: false,
    fetcher: (url, options) => fetch(`${origin}${new URL(String(url)).pathname}`, options) });
  await runtime.idle();
});

afterEach(async () => {
  vi.useRealTimers();
  await runtime.shutdown();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('runs all retained actions after an ordinary save with no action configuration or action requests and reloads the applied results', async () => {
  const task = await store.createTask(canvasId, { title: 'Atlas release', detail: 'Carry out Atlas release requirements.' }, 'Browser');
  const review = await store.createTask(canvasId, { title: 'Atlas release checkpoint', detail: 'Carry out Atlas release requirements at the checkpoint.' }, 'Browser');
  await runtime.idle();
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nOwner: Alice\nAtlas release requirements.' });
  await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(new Set(state.jobs.map(job => job.request.action))).toEqual(new Set(jevActions));
  expect(state.settings.externalProcessing).toBe(true);
  expect(jevActions.every(action => state.settings.modes[action] === 'auto')).toBe(true);
  expect(state.jobs.every(job => job.state === 'completed')).toBe(true);
  expect(state.proposals.filter(proposal => proposal.state === 'pending')).toEqual([]);
  expect(state.vocabulary.some(term => term.kind === 'label')).toBe(false);
  const reloaded = new CanvasStore(root); await reloaded.init();
  expect(await reloaded.getCanvasBlock(canvasId, source.id)).toMatchObject({ content: source.content, group: 'custom:atlas', tags: ['Atlas'] });
  expect((await reloaded.listTasks(canvasId)).find(item => item.id === task.id)).toMatchObject({ blockIds: [] });
  expect((await reloaded.listTasks(canvasId)).find(item => item.id === review.id)).toMatchObject({ blockIds: [] });
  const assignments = state.proposals.filter(proposal => proposal.action === 'assign_owner');
  expect(assignments).toHaveLength(0);
  expect(assignments.every(proposal => proposal.evidence.some(passage => passage.quote === 'Owner: Alice'))).toBe(true);
  expect(state.profiles[`${canvasId}:${source.id}`]).toMatchObject({ role: 'specification' });
});

it('preserves task attachments after ordinary task saves and stops repeating work when the context is unchanged', async () => {
  await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nOwner: Alice\nAtlas release requirements.' });
  await runtime.idle();
  const initial = await runtime.read(workspaceId, owner);
  const firstCalls = calls;
  await runtime.tick(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual(initial.jobs);
  expect(calls).toBe(firstCalls);
  const task = await store.createTask(canvasId, { title: 'Atlas release', detail: 'Carry out Atlas release requirements.' }, 'Browser');
  await runtime.idle();
  const work = await runtime.read(workspaceId, owner);
  expect(work.jobs.length).toBeGreaterThan(initial.jobs.length);
  expect((await store.listTasks(canvasId)).find(item => item.id === task.id)?.blockIds).toEqual([]);
  const finalCalls = calls;
  await runtime.tick(); await runtime.idle();
  const stable = await runtime.read(workspaceId, owner);
  expect(stable.jobs).toEqual(work.jobs);
  expect(stable.proposals).toEqual(work.proposals);
  expect(calls).toBe(finalCalls);
});

it('refreshes derived evidence after ordinary source edits and persists the current source revision across reload', async () => {
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nOwner: Alice\nAtlas release requirements.' });
  await runtime.idle();
  const edited = await store.updateBlock(canvasId, source.id, { content: '# Atlas\nOwner: Bob\nAtlas updated release requirements.' }, 'Browser');
  await runtime.idle();
  const changed = await runtime.read(workspaceId, owner);
  expect(changed.profiles[`${canvasId}:${source.id}`].source).toMatchObject({ sourceGeneration: edited.sourceGeneration, contentHash: edited.contentHash });
  const finalCalls = calls;
  await runtime.tick(); await runtime.idle();
  const stable = await runtime.read(workspaceId, owner);
  expect(stable.jobs).toEqual(changed.jobs);
  expect(stable.proposals).toEqual(changed.proposals);
  expect(calls).toBe(finalCalls);
  const reloaded = new CanvasStore(root); await reloaded.init();
  expect((await reloaded.getCanvasBlock(canvasId, source.id)).content).toBe(edited.content);
});

it('preserves explicit manual membership and owner corrections without opening proposals that need a user decision', async () => {
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nOwner: Alice\nAtlas release requirements.' });
  await runtime.idle();
  const manual = await store.updateBlock(canvasId, source.id, { group: 'custom:human', tags: ['Human'] }, 'Browser');
  const task = await store.createTask(canvasId, { title: 'Atlas release', detail: 'Carry out Atlas release requirements.', assignee: 'human-owner' }, 'Browser');
  await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(await store.getCanvasBlock(canvasId, source.id)).toMatchObject({ group: manual.group, tags: manual.tags });
  expect((await store.listTasks(canvasId)).find(item => item.id === task.id)?.assignee).toBe('human-owner');
  expect(state.proposals.filter(proposal => proposal.state === 'pending')).toEqual([]);
  expect(state.proposals.some(proposal => ['assign_owner', 'attach_doc_to_task'].includes(proposal.action))).toBe(false);
});

it('keeps unsupported classification findings advisory and never invents applied metadata', async () => {
  supported = false;
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nAtlas discussion.' });
  await runtime.idle();
  const saved = await store.getCanvasBlock(canvasId, source.id);
  expect(saved.content).toBe(source.content);
  expect(saved.tags ?? []).toEqual([]);
  expect(saved.group).toBeUndefined();
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.every(job => job.state === 'completed')).toBe(true);
  expect(state.proposals.every(proposal => proposal.state !== 'pending')).toBe(true);
});

it('does not enqueue repeated failed work when no processing provider is configured', async () => {
  await runtime.shutdown();
  runtime = new JevRuntime(store, { apiKey: '', startTimer: false });
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nAtlas requirements.' });
  await runtime.idle();
  await runtime.tick(); await runtime.idle();
  await runtime.tick(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual([]);
  expect(calls).toBe(0);
  expect((await store.getCanvasBlock(canvasId, source.id)).content).toBe(source.content);
});

it('settles supported canvas moves and does not repeat move or organization chains on unchanged maintenance', async () => {
  const destination = await store.createCanvas(workspaceId, { name: 'Delivery' });
  moveToSecond = true;
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nAtlas delivery requirements.', x: 123, y: 456 });
  await runtime.idle();
  expect(await store.getCanvasBlock(destination.id, source.id)).toMatchObject({ content: source.content, x: 123, y: 456 });
  await runtime.tick(); await runtime.idle();
  const settled = await runtime.read(workspaceId, owner);
  const moved = settled.receipts.filter(receipt => receipt.after.kind === 'move');
  expect(moved).toHaveLength(1);
  const settledCalls = calls;
  await runtime.tick(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual(settled.jobs);
  expect(calls).toBe(settledCalls);
});

it('bounds an unavailable provider and resumes automatically after its cooldown when the provider recovers', async () => {
  unavailable = true;
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nAtlas release requirements.' });
  await runtime.idle();
  const failed = await runtime.read(workspaceId, owner);
  expect(failed.jobs.filter(job => job.state === 'failed')).toHaveLength(1);
  expect(calls).toBeLessThanOrEqual(2);
  const failedCalls = calls;
  await runtime.tick(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual(failed.jobs);
  expect(calls).toBe(failedCalls);
  expect((await store.getCanvasBlock(canvasId, source.id)).content).toBe(source.content);
  unavailable = false;
  const resumeAt = Date.now() + 61000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(resumeAt);
  await runtime.tick(); await runtime.idle();
  const recovered = await runtime.read(workspaceId, owner);
  expect(new Set(recovered.jobs.filter(job => job.state === 'completed').map(job => job.request.action))).toEqual(new Set(jevActions));
  expect(recovered.profiles[`${canvasId}:${source.id}`]).toMatchObject({ role: 'specification' });
  const recoveredCalls = calls;
  await runtime.tick(); await runtime.idle();
  expect(calls).toBe(recoveredCalls);
});
