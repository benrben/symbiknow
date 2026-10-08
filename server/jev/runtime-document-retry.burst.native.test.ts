import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './actions/question-state-pool.test.helpers.js';

type Source = { id: string; title: string; passages: Array<{ id: string; text: string }> };
type State = { document?: Source; logicalTopicCandidates?: Array<{ name: string }>; labelCandidates?: Array<{ name: string }> };
const opened: Array<{ runtime: JevRuntime; root: string; release: () => void }> = [];
const owner: JevPrincipal = { id: 'burst-owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };

afterEach(async () => {
  for (const fixture of opened.splice(0)) {
    fixture.release();
    await fixture.runtime.shutdown();
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function scoped(wireId: string, wire: Record<string, unknown>) {
  const pool = wire.sourceStates;
  let id = wireId;
  let state = wire;
  let prefix: RegExpExecArray | null;
  while ((prefix = /^(\d+)__(.+)$/.exec(id))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(prefix[1])];
    id = prefix[2];
  }
  return { id, state: resolveSharedQuestionSources(state, pool) as State };
}

function answer(wireId: string, submitted: JevQuestion, wire: Record<string, unknown>): JevAnswer {
  const question = resolveSharedQuestionTexts(submitted, wire.questionTexts);
  const { id, state } = scoped(wireId, wire);
  const match = /^(logicalTopic|logicalTopicEvidence|label|evidence)_(\d+)$/.exec(id);
  const candidates = id.startsWith('logicalTopic') ? state.logicalTopicCandidates : state.labelCandidates;
  const name = match ? candidates?.[Number(match[2])]?.name : undefined;
  const passage = state.document?.passages.find(item => name && item.text.replace(/^#{1,6}\s+/, '').trim() === name);
  if (question.type === 'noul') return { type: 'noul', noul: passage ? .98 : .01 };
  if (question.type === 'score') return { type: 'score', score: 0, confidence: .98,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === 0)])) };
  const keys = Object.keys(question.criteria);
  const fallback = keys.includes('none') ? 'none' : keys.includes('distinct') ? 'distinct' : keys[0];
  const choice = id === 'role' ? keys[0]
    : id === 'keyPassage' ? state.document?.passages[1]?.id ?? 'none' : passage?.id ?? fallback;
  return { type: 'choice', choice, confidence: .98,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) };
}

async function fixture() {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '');
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-document-burst-'));
  const store = new CanvasStore(root);
  await store.init();
  await store.deleteWorkspace('acme-team');
  const workspace = await store.createWorkspace({ name: 'Launch burst' });
  const seedCanvas = await store.createCanvas(workspace.id, { name: 'Settled references' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Incoming launch documents' });
  let release!: () => void;
  let received!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { received = resolve; });
  let firstAccess = true;
  const contexts: Array<{ id: string; titles: string[] }> = [];
  const runtime = new JevRuntime(store, { startTimer: false, apiKey: 'native-burst-provider',
    decider: async (_key, value, questions) => {
      const wire = value as Record<string, unknown>;
      const profileKey = Object.keys(questions).find(key => scoped(key, wire).id === 'role');
      if (profileKey) {
        const source = scoped(profileKey, wire).state.document!;
        contexts.push({ id: source.id, titles: [source.title] });
        if (source.title === 'Access control policy' && firstAccess) {
          firstAccess = false;
          received();
          await hold;
        }
      }
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(id, question, wire)]));
    } });
  opened.push({ root, runtime, release });
  await runtime.idle();
  const add = async (file: string, canvasId = canvas.id) => {
    const content = await readFile(path.resolve('features/fixtures/launch-dry-run', file + '.md'), 'utf8');
    const block = await store.createBlock(canvasId, { title: content.split('\n')[0].replace(/^#\s+/, ''), content });
    return block;
  };
  return { root, store, runtime, workspace, canvas, seedCanvas, release, held, add, contexts };
}

it('freshly retries both ordinary burst arrivals after the workspace context changes while their provider work is held', async () => {
  const f = await fixture();
  const seeds = [];
  for (const name of ['sso-security-review', 'pen-test-findings', 'pricing-tiers-decision', 'pricing-page-copy', 'rollback-runbook']) {
    seeds.push(await f.add(name, f.seedCanvas.id));
    await f.runtime.idle();
  }
  const before = await f.runtime.read(f.workspace.id, owner);
  expect(before.jobs.filter(job => job.state === 'failed')).toEqual([]);
  const access = await f.add('access-control-policy');
  await f.held;
  const blockers = await f.add('launch-blockers');
  const copy = await f.add('rollback-steps-copy');
  f.release();
  await f.runtime.idle();
  const state = await f.runtime.read(f.workspace.id, owner);
  for (const block of [...seeds, access, blockers, copy]) {
    expect(state.profiles[`${block.id === access.id || block.id === blockers.id || block.id === copy.id ? f.canvas.id : f.seedCanvas.id}:${block.id}`]?.source)
      .toMatchObject({ contentHash: block.contentHash, sourceGeneration: block.sourceGeneration });
    expect(state.jobs.some(job => job.request.action === 'profile' && job.request.blockIds?.includes(block.id) && job.state === 'completed'), block.title).toBe(true);
  }
  const durable = await new JevWorkspaceFiles(f.root).read(f.workspace.id);
  const replaced = durable.jobs.filter(job => job.documentContextRetry?.replacementJobId);
  expect(replaced.length).toBeGreaterThan(0);
  expect(replaced.every(job => durable.jobs.some(next => next.id === job.documentContextRetry!.replacementJobId))).toBe(true);
  expect(f.contexts.filter(context => context.id === access.id).length).toBeGreaterThan(1);
  expect(new Set(state.receipts.map(receipt => receipt.id)).size).toBe(state.receipts.length);
  expect(new Set(state.receipts.map(receipt => receipt.proposalId)).size).toBe(state.receipts.length);
  const fresh = new CanvasStore(f.root);
  for (const block of [...seeds, access, blockers, copy]) {
    const canvasId = seeds.some(seed => seed.id === block.id) ? f.seedCanvas.id : f.canvas.id;
    expect((await fresh.getCanvasBlock(canvasId, block.id)).content).toBe(block.content);
  }
});
