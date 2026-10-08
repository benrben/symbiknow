import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jevActions, type JevPrincipal } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import { decideWithJev, type JevAnswer, type JevDecider, type JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { getJevRuntime, type JevRuntime } from './runtime.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';
import { resolveSharedQuestionSources } from './actions/question-state-pool.test.helpers.js';

type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
type NativeProvider = { calls: Body[]; fetcher: typeof fetch; decider: JevDecider;
  hold: (stage: 'scores' | 'evidence') => void; waiting: () => boolean; release: () => void; close: () => Promise<void> };
const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const key = 'native-transport-generation-key';
function name(id: string): string { return id.replace(/^(?:\d+__)+/, ''); }
function named(provider: NativeProvider, question: string): number {
  return provider.calls.flatMap(body => Object.keys(body.questions)).filter(id => name(id) === question).length;
}
function questionState(body: Body, id: string) {
  let state = body.state; let scoped = id; let prefix: RegExpExecArray | null;
  while ((prefix = /^(\d+)__(.+)$/.exec(scoped))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(prefix[1])]; scoped = prefix[2];
  }
  return resolveSharedQuestionSources(state, body.state.sourceStates);
}
function purposeProof(provider: NativeProvider, quote: string) {
  const checks = provider.calls.flatMap(body => Object.keys(body.questions).flatMap(id => {
    const index = /^purpose_(\d+)$/.exec(name(id));
    return index ? [{ state: questionState(body, id), index: Number(index[1]) }] : [];
  }));
  expect(checks).toHaveLength(1);
  expect(checks[0].state.selectedGroup).toMatchObject({ key: 'custom:release-guidance' });
  const proof = (checks[0].state.localEvidence as Array<{ quote: string }>)[checks[0].index];
  expect(proof.quote).toBe(quote);
}
function answer(id: string, question: JevQuestion, evidence: string, body: Body): JevAnswer {
  if (question.type === 'noul') {
    const state = questionState(body, id);
    const index = /^purpose_(\d+)$/.exec(name(id));
    const group = state.selectedGroup as { key?: string } | undefined;
    const passages = state.localEvidence as Array<{ quote: string }> | undefined;
    const quote = index ? passages?.[Number(index[1])]?.quote : undefined;
    const supported = group?.key === 'custom:release-guidance'
      && /^Evidence (?:one establishes|two independently supports) release guidance\.$/.test(quote ?? '');
    return { type: 'noul', noul: supported ? .98 : .01 };
  }
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  let selected = keys.at(-1)!;
  if (question.type === 'choice') {
    selected = name(id) === 'evidence' ? evidence : keys.includes('none') ? 'none' : keys[0];
    if (['place', 'gate'].includes(name(id)) && 'groups' in questionState(body, id)) selected = keys[0];
  }
  const probabilities = Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0]));
  return question.type === 'choice' ? { type: 'choice', choice: selected, confidence: .98, probabilities }
    : { type: 'score', score: 2.5, confidence: .98, probabilities };
}
async function provider(evidence: string): Promise<NativeProvider> {
  const calls: Body[] = []; let stage: 'scores' | 'evidence' | undefined; let waiting = false; let release = () => {};
  const server: Server = createServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as Body; calls.push(body);
    const names = Object.keys(body.questions).map(name);
    if ((stage === 'scores' && names.includes('role')) || (stage === 'evidence' && names.includes('evidence'))) {
      stage = undefined; waiting = true; await new Promise<void>(resolve => { release = resolve; }); waiting = false;
    }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answers: Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [id, answer(id, question, evidence, body)])) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native provider did not listen');
  const origin = `http://127.0.0.1:${address.port}`; const fetcher: typeof fetch = (_url, options) => fetch(origin, options);
  const decider: JevDecider = (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, fetcher, options);
  return { calls, fetcher, decider, hold: value => { stage = value; }, waiting: () => waiting, release: () => release(),
    close: async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

let root: string; let store: CanvasStore; let runtime: JevRuntime | undefined;
let old: NativeProvider; let next: NativeProvider; let workspaceId: string; let canvasId: string; let source: CanvasBlock;
beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', ''); [old, next] = await Promise.all([provider('p1'), provider('p2')]);
  root = await mkdtemp(path.join(tmpdir(), 'jev-question-transport-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Native transport lifetime' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  await store.createCanvas(workspaceId, { name: 'Independent destination' });
  source = await store.createBlock(canvasId, { title: 'Atlas', x: 123, y: 456,
    content: '# Atlas\nEvidence one establishes release guidance.\nEvidence two independently supports release guidance.' });
  const state = emptyJevWorkspace();
  state.vocabulary.push({ id: 'release-guidance', kind: 'group', name: 'Release guidance', groupKey: 'custom:release-guidance',
    definition: 'Release guidance and checked release requirements.', state: 'active', version: 1, aliases: [], members: [] });
  await new JevWorkspaceFiles(root).write(workspaceId, state);
});
afterEach(async () => {
  old.release(); next.release(); await runtime?.shutdown(); await Promise.all([old.close(), next.close()]);
  await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); runtime = undefined;
});
function start(documentExecution?: boolean) {
  runtime = getJevRuntime(store, { apiKey: key, fetcher: old.fetcher, decider: old.decider, startTimer: false, documentExecution });
  return runtime.idle();
}
async function completed() {
  const saved = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(saved.jobs).toHaveLength(6); expect(new Set(saved.jobs.map(job => job.request.action))).toEqual(new Set(jevActions));
  expect(saved.jobs.every(job => job.state === 'completed')).toBe(true);
  expect((await runtime!.read(workspaceId, owner)).profiles[`${canvasId}:${source.id}`]).toMatchObject({ analyzedAt: expect.any(String) });
  expect(await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).toMatchObject({ content: source.content, x: source.x, y: source.y });
  return saved;
}

it('keeps exact typed answers when repeated native API polls supply the same transport values during a dependent provider check', async () => {
  old.hold('evidence'); const pending = start();
  try {
    await expect.poll(old.waiting, { interval: 5, timeout: 1000 }).toBe(true);
    expect(getJevRuntime(store, {})).toBe(runtime);
    expect(getJevRuntime(store, { fetcher: old.fetcher })).toBe(runtime);
    for (let poll = 0; poll < 3; poll++) {
      expect(getJevRuntime(store, { apiKey: key, fetcher: old.fetcher, decider: old.decider })).toBe(runtime);
      expect((await runtime!.read(workspaceId, owner)).jobs.some(job => job.state === 'running')).toBe(true);
    }
    old.release(); await pending; await completed();
    expect(named(old, 'role')).toBe(1); expect(named(old, 'evidence')).toBe(1); expect(next.calls).toHaveLength(0);
    expect(named(old, 'place')).toBe(2); expect(named(old, 'gate')).toBe(2);
    purposeProof(old, 'Evidence one establishes release guidance.');
    const before = old.calls.length; await runtime!.tick(); await runtime!.idle(); expect(old.calls).toHaveLength(before);
  } finally { old.release(); await pending; }
});

it.each([false, true])('isolates late old-provider evidence from future actions after transport replacement with the same key (document=%s)', async documentExecution => {
  old.hold('scores'); const pending = start(documentExecution);
  try {
    await expect.poll(old.waiting, { interval: 5, timeout: 1000 }).toBe(true);
    expect(getJevRuntime(store, { apiKey: key, fetcher: next.fetcher, decider: next.decider })).toBe(runtime);
    old.release(); await pending;
    const saved = await completed();
    expect(named(old, 'role')).toBe(1); expect(named(old, 'evidence')).toBe(0);
    expect(named(old, 'place')).toBe(1);
    expect(named(next, 'place')).toBe(2); expect(named(next, 'gate')).toBe(2); expect(named(next, 'evidence')).toBe(1);
    purposeProof(next, 'Evidence two independently supports release guidance.');
    expect(named(old, 'purpose_1')).toBe(0);
    expect(named(next, 'label_0')).toBe(0);
    const quality = saved.proposals.find(proposal => proposal.action === 'file' && proposal.mutation.kind === 'document');
    expect(quality?.state).toBe('applied');
    expect(quality?.evidence.map(passage => passage.quote)).toEqual(expect.arrayContaining(['Evidence two independently supports release guidance.']));
    expect(quality?.evidence.every(passage => source.content.slice(passage.start, passage.end) === passage.quote)).toBe(true);
    expect(saved.receipts.some(receipt => receipt.proposalId === quality?.id && receipt.automatic)).toBe(true);
  } finally { old.release(); await pending; }
});
