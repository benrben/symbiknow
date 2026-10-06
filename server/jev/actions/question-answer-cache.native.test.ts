import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { choice, decideWithJev, noul, score, type JevAnswer, type JevQuestion } from '../../jev.js';
import { QuestionAnswerCache } from './question-answer-cache.js';

type Body = { state: unknown; questions: Record<string, JevQuestion> };
type Reply = { status: number; body: unknown };
const key = 'isolated-native-answer-key';
const state = { source: { id: 'atlas', passages: ['Owner: Alice. The release procedure is documented.'] },
  decisionProgram: { questionVersion: 'native-cache-program', sourceTrust: 'untrusted_evidence' } };
const questions = {
  supports: noul('Does the exact source declare responsibility?'),
  owner: choice('Choose the explicitly declared owner.', { alice: 'Alice', unknown: 'Unknown' }),
  quality: score('Assess the supplied release evidence.', ['Unknown', 'Supported']),
};
function validAnswers(asked: Record<string, JevQuestion>): Record<string, JevAnswer> {
  return Object.fromEntries(Object.entries(asked).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: .99 }];
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const probabilities = Object.fromEntries(keys.map((name, index) => [name, index === 0 ? 1 : 0]));
    if (question.type === 'choice') return [id, { type: 'choice', choice: keys[0], confidence: .99, probabilities }];
    return [id, { type: 'score', score: 0, confidence: .99, probabilities, legend: { '0': 'Unknown', '1': 'Supported' } }];
  }));
}
function success(body: Body): Reply { return { status: 200, body: { answers: validAnswers(body.questions) } }; }
function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

let server: Server; let requests: Body[]; let origin: string;
let reply: (body: Body) => Reply | Promise<Reply>;
const fetcher: typeof fetch = (_url, init) => fetch(origin, init);
beforeEach(async () => {
  requests = []; reply = success;
  server = createServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as Body; requests.push(body);
    const result = await reply(body);
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native provider address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});

it('reuses actual SDK typed answers across wrappers while preserving exact annotated inputs and independent values', async () => {
  const cache = new QuestionAnswerCache(); const decide = cache.decider('workspace:source:policy', decideWithJev);
  const first = await decide(key, state, questions, fetcher, { maxRetries: 0 });
  (first.owner as { probabilities: Record<string, number> }).probabilities.alice = 0;
  (first.quality as { legend: Record<string, string> }).legend['0'] = 'Caller edit';
  const later = cache.decider('workspace:source:policy', (...args) => decideWithJev(...args));
  expect(await later(key, structuredClone(state), structuredClone(questions), fetcher)).toEqual(validAnswers(questions));
  expect(requests).toHaveLength(1); expect(requests[0].state).toEqual(state); expect(requests[0].questions).toEqual(questions);
  expect(JSON.stringify(requests[0])).not.toContain(key);
});

it.each(['partition', 'credential', 'source', 'program', 'question'] as const)
('requires a new SDK decision when the exact %s changes', async change => {
  const cache = new QuestionAnswerCache(); const input = structuredClone(state); const asked = structuredClone(questions);
  await cache.decider('workspace:policy', decideWithJev)(key, state, questions, fetcher, { maxRetries: 0 });
  if (change === 'source') input.source.passages = ['Owner: Bob.'];
  if (change === 'program') input.decisionProgram.questionVersion = 'next-program';
  if (change === 'question') asked.supports.instructions = 'Is review responsibility explicitly declared?';
  await cache.decider(change === 'partition' ? 'other-workspace:policy' : 'workspace:policy', decideWithJev)
    (change === 'credential' ? `${key} ` : key, input, asked, fetcher, { maxRetries: 0 });
  expect(requests).toHaveLength(2); expect(requests[1].state).toEqual(input); expect(requests[1].questions).toEqual(asked);
});

const invalid: Array<[string, (answers: Record<string, unknown>) => void]> = [
  ['missing later answer', answers => { delete answers.quality; }],
  ['mismatched type', answers => { answers.owner = { type: 'noul', noul: .99 }; }],
  ['choice distribution sum', answers => { answers.owner = { type: 'choice', choice: 'alice', confidence: .99, probabilities: { alice: .9, unknown: .4 } }; }],
  ['nonleading choice', answers => { answers.owner = { type: 'choice', choice: 'alice', confidence: .99, probabilities: { alice: .2, unknown: .8 } }; }],
  ['extra score probability', answers => { answers.quality = { type: 'score', score: 0, confidence: .99, probabilities: { '0': 1, '1': 0, extra: 0 } }; }],
  ['out-of-range score', answers => { answers.quality = { type: 'score', score: 2, confidence: .99, probabilities: { '0': 1, '1': 0 } }; }],
  ['invalid yes/no probability', answers => { answers.supports = { type: 'noul', noul: null }; }],
];
it.each(invalid)('never retains a provider response with %s, including otherwise valid earlier answers', async (_name, corrupt) => {
  const cache = new QuestionAnswerCache(); const decide = cache.decider('workspace:policy', decideWithJev);
  reply = body => { const answers: Record<string, unknown> = validAnswers(body.questions); corrupt(answers); return { status: 200, body: { answers } }; };
  await expect(decide(key, state, questions, fetcher, { maxRetries: 0 })).rejects.toMatchObject({ status: 502 });
  reply = success;
  expect(await decide(key, state, questions, fetcher, { maxRetries: 0 })).toEqual(validAnswers(questions));
  expect(await decide(key, state, questions, fetcher, { maxRetries: 0 })).toEqual(validAnswers(questions));
  expect(requests).toHaveLength(2);
});

it('does not cache native HTTP failures and forwards retry options to the SDK', async () => {
  const cache = new QuestionAnswerCache(); const decide = cache.decider('workspace:policy', decideWithJev);
  reply = () => ({ status: 503, body: { detail: 'Native provider unavailable' } });
  await expect(decide(key, state, questions, fetcher, { maxRetries: 0 }))
    .rejects.toMatchObject({ status: 502, message: 'Jev request failed (503): Native provider unavailable' });
  reply = body => requests.length === 2 ? { status: 503, body: { detail: 'Transient native failure' } } : success(body);
  expect(await decide(key, state, questions, fetcher, { maxRetries: 1, baseDelayMs: 0 })).toEqual(validAnswers(questions));
  expect(await decide(key, state, questions, fetcher, { maxRetries: 0 })).toEqual(validAnswers(questions));
  expect(requests).toHaveLength(3);
});

it('checks an already-aborted signal before returning an exact cached answer or starting another native request', async () => {
  const cache = new QuestionAnswerCache(); const decide = cache.decider('workspace:policy', decideWithJev);
  await decide(key, state, questions, fetcher, { maxRetries: 0 });
  const controller = new AbortController(); controller.abort();
  await expect(decide(key, state, questions, fetcher, { signal: controller.signal, maxRetries: 0 }))
    .rejects.toMatchObject({ status: 499, message: 'Symbi Reflex evaluation was cancelled' });
  expect(requests).toHaveLength(1);
  expect(await decide(key, state, questions, fetcher)).toEqual(validAnswers(questions));
});

it('rejects and declines a response after cancellation even when the native fetcher ignores the signal', async () => {
  const gate = held(); reply = async body => { await gate.promise; return success(body); };
  const cache = new QuestionAnswerCache(); const decide = cache.decider('workspace:policy', decideWithJev);
  const controller = new AbortController();
  const uncancellable: typeof fetch = (_url, init) => fetch(origin, { ...init, signal: undefined });
  const pending = decide(key, state, questions, uncancellable, { signal: controller.signal, maxRetries: 0 });
  const observed = pending.then(value => ({ value }), error => ({ error }));
  try {
    await expect.poll(() => requests.length, { interval: 5, timeout: 450 }).toBe(1);
    controller.abort(); gate.release();
    expect(await observed).toMatchObject({ error: { status: 499, message: 'Symbi Reflex evaluation was cancelled' } });
    reply = success; expect(await decide(key, state, questions, fetcher, { maxRetries: 0 })).toEqual(validAnswers(questions));
    expect(requests).toHaveLength(2);
  } finally { gate.release(); await observed; }
});

it('keeps a native response admitted before reset from restoring an entry after clear', async () => {
  const gate = held(); reply = async body => { await gate.promise; return success(body); };
  const cache = new QuestionAnswerCache(); const decide = cache.decider('workspace:policy', decideWithJev);
  const pending = decide(key, state, questions, fetcher, { maxRetries: 0 });
  try {
    await expect.poll(() => requests.length, { interval: 5, timeout: 450 }).toBe(1);
    cache.clear(); gate.release(); expect(await pending).toEqual(validAnswers(questions));
    reply = success; await decide(key, state, questions, fetcher, { maxRetries: 0 }); await decide(key, state, questions, fetcher);
    expect(requests).toHaveLength(2);
  } finally { gate.release(); await pending.catch(() => undefined); }
});

it('expires native answers at the fixed TTL and maintains least-recently-used entry eviction', async () => {
  let now = 0; const cache = new QuestionAnswerCache({ now: () => now, maxEntries: 2 }); const decide = cache.decider('workspace:policy', decideWithJev);
  await decide(key, { id: 1 }, questions, fetcher); await decide(key, { id: 2 }, questions, fetcher);
  now = 59_999; await decide(key, { id: 1 }, questions, fetcher); await decide(key, { id: 3 }, questions, fetcher);
  await decide(key, { id: 1 }, questions, fetcher); expect(requests).toHaveLength(3);
  await decide(key, { id: 2 }, questions, fetcher); expect(requests).toHaveLength(4);
  now = 60_000; await decide(key, { id: 1 }, questions, fetcher); expect(requests).toHaveLength(5);
});

it('enforces an accumulated byte budget independently of entry count using real provider responses', async () => {
  const cache = new QuestionAnswerCache({ maxBytes: 1024 }); const decide = cache.decider('workspace:policy', decideWithJev);
  const asked = { supports: questions.supports };
  for (const id of [1, 2, 3, 2, 3]) await decide(key, { id }, asked, fetcher);
  expect(requests).toHaveLength(3); await decide(key, { id: 1 }, asked, fetcher); expect(requests).toHaveLength(4);
});

it('preserves SDK empty-question and missing-key behavior without native traffic', async () => {
  const decide = new QuestionAnswerCache().decider('workspace:policy', decideWithJev);
  expect(await decide(key, state, {}, fetcher)).toEqual({});
  await expect(decide('', state, {}, fetcher)).rejects.toMatchObject({ status: 400 });
  await expect(decide('', state, questions, fetcher)).rejects.toMatchObject({ status: 400 });
  expect(requests).toHaveLength(0);
});
