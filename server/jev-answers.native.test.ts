import { EventEmitter, once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { choiceAnswer, expectedScore, noulAnswer, scoreAnswer, topScore } from './jev-answers.js';
import { askJev, choice, decideWithJev, JEV_MODEL, noul, score,
  type JevAnswer, type JevDecider, type JevQuestion, type ScoreAnswer } from './jev.js';

type DecisionRequest = { model: string; state: unknown; questions: Record<string, JevQuestion> };
type RecordedRequest = {
  method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders;
  body: DecisionRequest; closed: Promise<void>;
};
type ProviderReply = { body: unknown; status?: number } | { hold: true };
type Fixture = {
  server: Server; failures: unknown[]; requests: RecordedRequest[]; targets: string[];
  decider: JevDecider; respond: (reply: ProviderReply) => void;
  nextRequest: (index: number) => Promise<RecordedRequest>;
};
const fixtures: Fixture[] = [];

const questions = {
  assessment: score('Assess the supplied evidence.', ['Missing', 'Partial', 'Complete']),
  purpose: choice('Choose the purpose of the supplied text.', { guide: 'Instructions', research: 'Evidence' }),
  blocked: noul('Does the supplied evidence say the release is blocked?', {
    true: 'The evidence explicitly says it is blocked.', false: 'The evidence does not say it is blocked.',
  }),
};
const assessment: ScoreAnswer = { type: 'score', score: 1, confidence: 0.8,
  probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, legend: { 0: 'Missing', 1: 'Partial', 2: 'Complete' } };
const validAnswers: Record<string, JevAnswer> = {
  assessment,
  purpose: { type: 'choice', choice: 'guide', confidence: 0.9, probabilities: { guide: 0.6, research: 0.4 } },
  blocked: { type: 'noul', noul: 0.25 },
};
const state = { evidence: 'A release checklist exists, but the rollback procedure is incomplete.',
  revision: 'fixture-revision', requestedBy: 'SDK test' };

async function recordRequest(request: IncomingMessage, response: ServerResponse): Promise<RecordedRequest> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  const closed = new Promise<void>(resolve => response.once('close', resolve));
  return { method: request.method, url: request.url, headers: request.headers,
    body: JSON.parse(body) as DecisionRequest, closed };
}

async function fixture(): Promise<Fixture> {
  const requests: RecordedRequest[] = [];
  const failures: unknown[] = [];
  const targets: string[] = [];
  const observed = new EventEmitter();
  let reply: ProviderReply = { body: { answers: validAnswers } };
  const server = createServer((request, response) => {
    void recordRequest(request, response).then(recorded => {
      const index = requests.length;
      requests.push(recorded);
      observed.emit(`request_${index}`, recorded);
      if ('hold' in reply) return;
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    }).catch(error => {
      failures.push(error);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: 'The native test provider could not read the SDK request.' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native SDK provider did not bind a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  const fetcher: typeof fetch = (input, init) => {
    targets.push(String(input));
    return globalThis.fetch(base + '/v1/systemone', init);
  };
  const decider: JevDecider = (key, inputState, inputQuestions, _fetcher, options) =>
    decideWithJev(key, inputState, inputQuestions, fetcher, options);
  const native = { server, failures, requests, targets, decider,
    respond: (next: ProviderReply) => { reply = next; },
    nextRequest: async (index: number): Promise<RecordedRequest> => {
      if (requests[index]) return requests[index];
      const [recorded] = await once(observed, `request_${index}`);
      return recorded as RecordedRequest;
    } };
  fixtures.push(native);
  return native;
}

afterEach(async () => {
  for (const native of fixtures.splice(0)) {
    native.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => native.server.close(error => error ? reject(error) : resolve()));
    expect(native.failures).toEqual([]);
  }
});

it('round-trips typed choice, score and noul questions through native HTTP and preserves all decoded fields', async () => {
  const f = await fixture();
  const decoded = await askJev(f.decider, 'local-sdk-key', state, questions, { maxRetries: 0 });
  expect(f.requests).toHaveLength(1);
  expect(f.targets).toEqual(['https://api.typesafe.ai/v1/systemone']);
  expect(f.requests[0]).toMatchObject({ method: 'POST', url: '/v1/systemone',
    headers: { authorization: 'Bearer local-sdk-key', 'content-type': 'application/json' },
    body: { model: JEV_MODEL, state, questions } });
  expect(decoded).toEqual(validAnswers);
  expect(scoreAnswer(decoded, 'assessment')).toBe(decoded.assessment);
  expect(scoreAnswer(decoded, 'assessment')).toEqual(assessment);
  expect(topScore(decoded.assessment)).toBe(1);
  expect(expectedScore(decoded.assessment, 3)).toBeCloseTo(0.6);
  expect(choiceAnswer(decoded, 'purpose', ['guide', 'research'] as const)).toEqual({ value: 'guide', confidence: 0.9 });
  expect(decoded.purpose.probabilities).toEqual({ guide: 0.6, research: 0.4 });
  expect(noulAnswer(decoded, 'blocked')).toBe(0.25);
});

it.each([2, 5, 10])('normalizes a decoded %s-level distribution independently of its selected level', async levels => {
  const f = await fixture();
  const criteria = Array.from({ length: levels }, (_, index) => `Evidence level ${index}`);
  const probability = 1 / levels;
  const selected: ScoreAnswer = { type: 'score', score: 0, confidence: 0.3,
    probabilities: Object.fromEntries(criteria.map((_, index) => [String(index), probability])) };
  f.respond({ body: { answers: { quality: selected } } });
  const asked = { quality: score('Assess the supplied evidence.', criteria) };
  const decoded = await f.decider('local-sdk-key', state, asked, undefined, { maxRetries: 0 });
  expect(f.requests[0].body).toEqual({ model: JEV_MODEL, state, questions: asked });
  expect(scoreAnswer(decoded, 'quality')).toEqual(selected);
  expect(topScore(decoded.quality)).toBe(0);
  expect(expectedScore(decoded.quality, levels)).toBeCloseTo(0.5);
});

it.each([0, 1])('retains the decoded noul probability boundary %s without converting it to confidence', async probability => {
  const f = await fixture();
  f.respond({ body: { answers: { blocked: { type: 'noul', noul: probability } } } });
  const asked = { blocked: questions.blocked };
  const decoded = await f.decider('local-sdk-key', state, asked, undefined, { maxRetries: 0 });
  expect(f.requests[0].body.questions).toEqual(asked);
  expect(noulAnswer(decoded, 'blocked')).toBe(probability);
  expect(decoded.blocked).toEqual({ type: 'noul', noul: probability });
});

it('rejects incorrect accessor use on real decoded answers without modifying those answers', async () => {
  const f = await fixture();
  const decoded = await f.decider('local-sdk-key', state, questions, undefined, { maxRetries: 0 });
  expect(() => choiceAnswer(decoded, 'assessment', ['guide', 'research'])).toThrow(/no valid choice for assessment/);
  expect(() => choiceAnswer(decoded, 'purpose', ['research'])).toThrow(/no valid choice for purpose/);
  expect(() => choiceAnswer(decoded, 'missing', ['guide', 'research'])).toThrow(/no valid choice for missing/);
  expect(() => scoreAnswer(decoded, 'purpose')).toThrow(/no valid score for purpose/);
  expect(() => scoreAnswer(decoded, 'missing')).toThrow(/no valid score for missing/);
  expect(() => noulAnswer(decoded, 'assessment')).toThrow(/no valid noul for assessment/);
  expect(() => noulAnswer(decoded, 'missing')).toThrow(/no valid noul for missing/);
  expect(() => expectedScore(decoded.blocked, 3)).toThrow(/invalid score/);
  expect(() => expectedScore(decoded.assessment, 1)).toThrow(/invalid score/);
  expect(() => topScore(decoded.purpose)).toThrow(/invalid score/);
  expect(decoded).toEqual(validAnswers);
  expect(f.requests).toHaveLength(1);
});

const invalidProviderAnswers: Array<{ label: string; id: string; answer: unknown }> = [
  { label: 'incomplete score distribution', id: 'assessment',
    answer: { ...assessment, probabilities: { 0: 0.1, 1: 0.9 } } },
  { label: 'wrong score type', id: 'assessment', answer: { type: 'noul', noul: 0.9 } },
  { label: 'invalid score legend', id: 'assessment', answer: { ...assessment, legend: { 0: 1 } } },
  { label: 'incomplete choice distribution', id: 'purpose',
    answer: { type: 'choice', choice: 'guide', confidence: 0.9, probabilities: { guide: 1 } } },
  { label: 'unoffered choice', id: 'purpose',
    answer: { type: 'choice', choice: 'plan', confidence: 0.9, probabilities: { guide: 0.6, research: 0.4 } } },
  { label: 'wrong choice type', id: 'purpose', answer: assessment },
  { label: 'invalid noul probability', id: 'blocked', answer: { type: 'noul', noul: 1.1 } },
  { label: 'wrong noul type', id: 'blocked', answer: validAnswers.purpose },
  { label: 'missing answer', id: 'blocked', answer: undefined },
];

it.each(invalidProviderAnswers)('rejects a native $label response before accessors and recovers on the next request', async ({ id, answer }) => {
  const f = await fixture();
  f.respond({ body: { answers: { ...validAnswers, [id]: answer } } });
  await expect(f.decider('local-sdk-key', state, questions, undefined, { maxRetries: 0 }))
    .rejects.toMatchObject({ status: 502, message: `Jev returned an invalid answer for ${id}` });
  expect(f.requests[0].body).toEqual({ model: JEV_MODEL, state, questions });
  f.respond({ body: { answers: validAnswers } });
  const decoded = await f.decider('local-sdk-key', state, questions, undefined, { maxRetries: 0 });
  expect(decoded).toEqual(validAnswers);
  expect(scoreAnswer(decoded, 'assessment')).toEqual(assessment);
  expect(choiceAnswer(decoded, 'purpose', ['guide', 'research'])).toEqual({ value: 'guide', confidence: 0.9 });
  expect(noulAnswer(decoded, 'blocked')).toBe(0.25);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1].body).toEqual(f.requests[0].body);
});

it('cancels a real in-flight native request, closes its connection and recovers with a fresh decision', async () => {
  const f = await fixture();
  f.respond({ hold: true });
  const controller = new AbortController();
  const pending = f.decider('local-sdk-key', state, questions, undefined, { signal: controller.signal, maxRetries: 0 });
  const rejected = expect(pending).rejects.toMatchObject({ status: 499, message: 'Jev request was cancelled' });
  const recorded = await f.nextRequest(0);
  expect(recorded.body).toEqual({ model: JEV_MODEL, state, questions });
  controller.abort(new Error('Stop native SDK request'));
  await rejected;
  await recorded.closed;
  f.respond({ body: { answers: validAnswers } });
  const decoded = await f.decider('local-sdk-key', state, questions, undefined, { maxRetries: 0 });
  expect(decoded).toEqual(validAnswers);
  expect(expectedScore(scoreAnswer(decoded, 'assessment'), 3)).toBeCloseTo(0.6);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1].body).toEqual(recorded.body);
});
