import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { decideWithJev, noul, type JevQuestion } from '../../jev.js';
import { cachedQuestionContext } from '../runtime-question-prefetch.js';
import { emptyJevWorkspace } from '../workspace.js';
import { judge, type JevEvaluationContext } from './context.js';
import { batchedDiscoveryContext } from './discovery-batch.js';
import { judgeQuestionSets, type JevQuestionSet } from './question-batch.js';
import { QuestionAnswerCache } from './question-answer-cache.js';

type State = { sourceId: number; quote: string; questionSets?: State[] };
type Body = { state: State; questions: Record<string, JevQuestion> };
type Reply = { status: number; body: unknown };
const requests: Body[] = [];
let server: Server; let origin: string;
let reply: (body: Body) => Reply | Promise<Reply>;
const sets: JevQuestionSet[] = [0, 1, 2].map(sourceId => ({
  state: { sourceId, quote: `Exact source ${sourceId} declares its own release responsibility.` },
  questions: { supported: noul('Does this exact source declare responsibility?') },
}));
function source(body: Body, questionId: string): State {
  let state = body.state; let id = questionId; let match = /^(\d+)__(.+)$/.exec(id);
  while (match) { state = state.questionSets![Number(match[1])]; id = match[2]; match = /^(\d+)__(.+)$/.exec(id); }
  return state;
}
function expected(selected: JevQuestionSet[]) {
  return selected.map(set => ({ supported: { type: 'noul', noul: .8 + Number(set.state.sourceId) / 100 } }));
}
function success(body: Body): Reply {
  return { status: 200, body: { answers: Object.fromEntries(Object.keys(body.questions).map(id =>
    [id, { type: 'noul', noul: .8 + source(body, id).sourceId / 100 }])) } };
}
function context(): JevEvaluationContext {
  const base: JevEvaluationContext = { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [],
    settings: emptyJevWorkspace().settings, apiKey: 'native-original-set-cache',
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions,
      (_url, init) => fetch(origin, init), options) };
  return cachedQuestionContext(base, new QuestionAnswerCache(), 'native-source-policy-partition');
}
beforeEach(async () => {
  requests.splice(0); reply = success;
  server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Body; requests.push(body);
    const result = await reply(body);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native provider address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});

it('reuses original typed sets when a later SDK bundle changes order or contains only a subset', async () => {
  const cached = context(); const original = structuredClone(sets);
  expect(await judgeQuestionSets(cached, sets)).toEqual(expected(sets));
  const reordered = [sets[2], sets[0]];
  expect(await judgeQuestionSets(cached, reordered)).toEqual(expected(reordered));
  expect(await judgeQuestionSets(cached, [sets[1]])).toEqual(expected([sets[1]]));
  expect(requests).toHaveLength(1);
  expect(requests[0].state.questionSets!.map(state => ({ sourceId: state.sourceId, quote: state.quote })))
    .toEqual(sets.map(set => set.state));
  expect(sets).toEqual(original);
});

it('sends only exact source or question misses in a mixed bundle and retains independent caller-owned answers', async () => {
  const cached = context(); const first = await judgeQuestionSets(cached, sets);
  (first[0].supported as { noul: number }).noul = 0;
  const changedSource = { ...sets[1], state: { ...sets[1].state, quote: 'A newly edited exact source passage.' } };
  const changedQuestion = { ...sets[2], questions: { supported: noul('Does the exact source declare review responsibility?') } };
  const mixed = [sets[2], changedSource, sets[0], changedQuestion];
  expect(await judgeQuestionSets(cached, mixed)).toEqual(expected(mixed));
  expect(requests).toHaveLength(2);
  expect(requests[1].state.questionSets!.map(({ sourceId, quote }) => ({ sourceId, quote })))
    .toEqual([changedSource.state, changedQuestion.state]);
  expect(Object.values(requests[1].questions).map(question => question.instructions)).toEqual([
    `Use only questionSets[0] as the state for this question. ${changedSource.questions.supported.instructions}`,
    `Use only questionSets[1] as the state for this question. ${changedQuestion.questions.supported.instructions}`,
  ]);
  expect(await judgeQuestionSets(cached, [sets[0], sets[1], changedQuestion])).toEqual(expected([sets[0], sets[1], changedQuestion]));
  expect(requests).toHaveLength(2);
});

it('does not cache a failed SDK bundle and retries the same independent judgments after provider recovery', async () => {
  const cached = context(); reply = () => ({ status: 503, body: { detail: 'Native provider temporarily unavailable' } });
  await expect(judgeQuestionSets(cached, sets)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('503') });
  reply = success;
  expect(await judgeQuestionSets(cached, [...sets].reverse())).toEqual(expected([...sets].reverse()));
  expect(await judgeQuestionSets(cached, sets)).toEqual(expected(sets));
  expect(requests).toHaveLength(2);
});

it('drains admitted SDK work before reporting the earliest original set failure and releases no partial result', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  reply = async () => { await held; return { status: 503, body: { detail: 'Later native provider failure' } }; };
  const cached = context(); const oversized = { ...sets[0], state: { ...sets[0].state, quote: 'Large source '.repeat(20_000) } };
  let settled = false;
  const pending = judgeQuestionSets(cached, [oversized, sets[1], sets[2]]).finally(() => { settled = true; });
  const observed = pending.then(value => ({ value }), error => ({ error }));
  try {
    await expect.poll(() => requests.length, { timeout: 450, interval: 5 }).toBe(1);
    expect(settled).toBe(false); release();
    expect(await observed).toMatchObject({ error: { status: 413, message: 'Symbi Reflex decision exceeds the application token budget' } });
    reply = success;
    expect(await judgeQuestionSets(cached, sets)).toEqual(expected(sets));
    expect(requests).toHaveLength(2);
  } finally { release(); await observed; }
});

it('checks cancellation before exact cache hits and starts a fresh successful wave after cancellation', async () => {
  const cached = context(); expect(await judgeQuestionSets(cached, sets)).toEqual(expected(sets));
  const controller = new AbortController(); controller.abort();
  await expect(judgeQuestionSets({ ...cached, signal: controller.signal }, [...sets].reverse()))
    .rejects.toMatchObject({ status: 499, message: 'Symbi Reflex evaluation was cancelled' });
  expect(await judgeQuestionSets(cached, [sets[2]])).toEqual(expected([sets[2]]));
  expect(requests).toHaveLength(1);
});

it('uses an uncached transport context without a separate transport field and keeps empty cached waves local', async () => {
  const cached = context(); const fallback = { ...cached, decider: cached.uncachedDecider, uncachedDecider: undefined };
  expect(await judgeQuestionSets(fallback, [])).toEqual([]);
  expect(await judgeQuestionSets(fallback, [{ state: {}, questions: {} }, { state: {}, questions: {} }])).toEqual([{}, {}]);
  expect(requests).toHaveLength(0);
  expect(await judgeQuestionSets(fallback, sets)).toEqual(expected(sets));
  expect(await judgeQuestionSets(fallback, [sets[1]])).toEqual(expected([sets[1]]));
  expect(requests).toHaveLength(1);
});

it('flattens nested discovery and cached bundles into one SDK request with one unambiguous source scope per question', async () => {
  const cached = context(); const parent = batchedDiscoveryContext({ ...cached, decider: cached.uncachedDecider,
    wrapDecider: undefined, uncachedDecider: undefined }, setImmediate);
  const shared = cachedQuestionContext(parent, new QuestionAnswerCache(), 'native-flat-parent');
  const nested = batchedDiscoveryContext(shared);
  const results = await Promise.all([
    judge(shared, sets[0].state, sets[0].questions),
    judgeQuestionSets(shared, [sets[1]]),
    judgeQuestionSets(nested, [sets[2]]),
  ]);
  expect(results).toEqual([expected([sets[0]])[0], expected([sets[1]]), expected([sets[2]])]);
  expect(requests).toHaveLength(1);
  expect(requests[0].state.questionSets!.map(({ sourceId, quote }) => ({ sourceId, quote })))
    .toEqual(sets.map(set => set.state));
  for (const state of requests[0].state.questionSets!) expect(state.questionSets).toBeUndefined();
  for (const [id, question] of Object.entries(requests[0].questions)) {
    expect(id).toMatch(/^\d+__supported$/);
    expect(question.instructions.match(/Use only questionSets\[/g)).toHaveLength(1);
    expect(question.instructions).toBe(`Use only questionSets[${id.split('__')[0]}] as the state for this question. ${sets[0].questions.supported.instructions}`);
  }
  expect(await judgeQuestionSets(shared, [sets[2], sets[0]])).toEqual(expected([sets[2], sets[0]]));
  expect(requests).toHaveLength(1);
});
