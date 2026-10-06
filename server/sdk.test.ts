import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import * as sdk from './sdk.js';
import type {
  AnswerFor, AnswersFor, ChoiceAnswer, ChoiceQuestion, JevAnswer, JevCallOptions,
  JevDecider, JevQuestion, JevUsage, NoulAnswer, NoulQuestion, ScoreAnswer, ScoreQuestion,
} from './sdk.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

type RequestBody = { model: string; state: unknown; questions: Record<string, JevQuestion> };
type RecordedRequest = { body: RequestBody; method?: string; headers: IncomingHttpHeaders };
async function provider(response: unknown, statuses: number[] = [200]) {
  const requests: RecordedRequest[] = [];
  const targets: string[] = [];
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody,
        method: request.method, headers: request.headers });
      reply.writeHead(statuses[Math.min(requests.length - 1, statuses.length - 1)], { 'Content-Type': 'application/json' });
      reply.end(JSON.stringify(response));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider did not bind a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  // Route the public fetch-injection seam to a real local HTTP provider.
  const fetcher: typeof fetch = (target, options) => {
    targets.push(String(target));
    return fetch(base, options);
  };
  const decider: JevDecider = (apiKey, state, questions, _fetcher, options) =>
    sdk.decideWithJev(apiKey, state, questions, fetcher, options);
  return { requests, targets, fetcher, decider };
}

function questions() {
  return {
    kind: sdk.choice('Choose a document kind.', { guide: 'Step-by-step instructions', plan: 'Future work' }),
    value: sdk.score('Rate the supplied evidence.', ['None', 'Some', 'Strong']),
    supported: sdk.noul('Does the supplied evidence support this claim?', { true: 'Supported', false: 'Unsupported' }),
  };
}
function answers(): AnswersFor<ReturnType<typeof questions>> {
  return {
    kind: { type: 'choice', choice: 'guide', probabilities: { guide: 0.9, plan: 0.1 }, confidence: 0.9 },
    value: { type: 'score', score: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.85 },
    supported: { type: 'noul', noul: 0.95 },
  };
}

describe('public Jev engine SDK', () => {
  it('exports the complete engine surface without transport internals or application actions', () => {
    expect(Object.keys(sdk).sort()).toEqual([
      'ApiError', 'JEV_MODEL', 'JEV_STATE_TOKEN_LIMIT', 'askJev', 'assertValidJevRequest', 'choice',
      'choiceAnswer', 'decideWithJev', 'estimateJevTokens', 'expectedScore', 'noul', 'noulAnswer',
      'onJevUsage', 'score', 'scoreAnswer', 'topScore',
    ].sort());
    expect(sdk.JEV_MODEL.trim()).not.toBe('');
    expect(sdk.JEV_STATE_TOKEN_LIMIT).toBe(32_000);
  });

  it('preserves literal question and answer inference through a real HTTP decision', async () => {
    const asked = questions();
    const expected = answers();
    const service = await provider({ answers: expected });
    const state = { document: 'שלום 🌍', purpose: 'SDK rebuild' };
    const options: JevCallOptions = { maxRetries: 0, baseDelayMs: 0 };
    const result = await sdk.askJev(service.decider, 'sdk-local-test-key', state, asked, options);
    expectTypeOf(asked.kind).toEqualTypeOf<ChoiceQuestion<{ readonly guide: 'Step-by-step instructions'; readonly plan: 'Future work' }>>();
    expectTypeOf(asked.value).toEqualTypeOf<ScoreQuestion<readonly ['None', 'Some', 'Strong']>>();
    expectTypeOf(asked.supported).toEqualTypeOf<NoulQuestion>();
    expectTypeOf(result).toEqualTypeOf<AnswersFor<typeof asked>>();
    expectTypeOf(result.kind.choice).toEqualTypeOf<'guide' | 'plan'>();
    expectTypeOf(result.kind).toEqualTypeOf<ChoiceAnswer<typeof asked.kind.criteria>>();
    expectTypeOf<AnswerFor<typeof asked.kind>>().toEqualTypeOf<typeof result.kind>();
    expectTypeOf(result.value).toEqualTypeOf<ScoreAnswer>();
    expectTypeOf(result.supported).toEqualTypeOf<NoulAnswer>();
    expect(result).toEqual(expected);
    expect(service.targets).toEqual(['https://api.typesafe.ai/v1/systemone']);
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({ body: { model: sdk.JEV_MODEL, state, questions: asked },
      method: 'POST', headers: { authorization: 'Bearer sdk-local-test-key', 'content-type': 'application/json' } });
  });

  it('reads choice confidence, ordinal scores, and Noul probability through public helpers', () => {
    const result: Record<string, JevAnswer> = answers();
    const kind = sdk.choiceAnswer(result, 'kind', ['guide', 'plan'] as const);
    expectTypeOf(kind.value).toEqualTypeOf<'guide' | 'plan'>();
    expect(kind).toEqual({ value: 'guide', confidence: 0.9 });
    expect(sdk.scoreAnswer(result, 'value')).toBe(result.value);
    expect(sdk.topScore(result.value)).toBe(2);
    expect(sdk.expectedScore(result.value, 3)).toBeCloseTo(0.8);
    expect(sdk.noulAnswer(result, 'supported')).toBe(0.95);
    expect(() => sdk.scoreAnswer(result, 'kind')).toThrow(sdk.ApiError);
    expect(() => sdk.noulAnswer(result, 'missing')).toThrow(expect.objectContaining({ status: 502 }));
    const error = new sdk.ApiError(409, 'Reviewed input changed');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status: 409, message: 'Reviewed input changed' });
  });

  it('estimates Unicode token budgets and rejects oversized requests before contacting the provider', async () => {
    const state = { text: 'שלום 🌍' };
    expect(sdk.estimateJevTokens(state)).toBe(Math.ceil(new TextEncoder().encode(JSON.stringify(state)).length / 3));
    expect(() => sdk.assertValidJevRequest(state, questions())).not.toThrow();
    const service = await provider({ answers: answers() });
    await expect(sdk.decideWithJev('sdk-local-test-key', 'x'.repeat(96_001), questions(), service.fetcher))
      .rejects.toMatchObject({ status: 413 });
    await expect(sdk.decideWithJev('', state, questions(), service.fetcher)).rejects.toMatchObject({ status: 400 });
    expect(await sdk.decideWithJev('sdk-local-test-key', state, {}, service.fetcher)).toEqual({});
    expect(service.requests).toEqual([]);
    expect(service.targets).toEqual([]);
  });

  it('reports successful provider usage and respects unsubscribe', async () => {
    const service = await provider({ answers: answers(), usage: { input_tokens: 30, output_tokens: 8 } });
    const usage: JevUsage[] = [];
    const unsubscribe = sdk.onJevUsage(event => usage.push(event));
    try {
      await sdk.decideWithJev('sdk-local-test-key', {}, questions(), service.fetcher);
      unsubscribe();
      await sdk.decideWithJev('sdk-local-test-key', {}, questions(), service.fetcher);
    } finally { unsubscribe(); }
    expect(service.requests).toHaveLength(2);
    expect(usage).toEqual([{ model: sdk.JEV_MODEL, inputTokens: 30, outputTokens: 8, questions: 3, at: expect.any(String) }]);
    expect(Number.isNaN(Date.parse(usage[0].at))).toBe(false);
  });

  it('retains retry and cancellation options at the public HTTP boundary', async () => {
    const service = await provider({ answers: answers() }, [503, 200]);
    expect(await sdk.decideWithJev('sdk-local-test-key', {}, questions(), service.fetcher, { maxRetries: 1, baseDelayMs: 0 }))
      .toEqual(answers());
    expect(service.requests).toHaveLength(2);
    const controller = new AbortController();
    controller.abort();
    await expect(sdk.decideWithJev('sdk-local-test-key', {}, questions(), service.fetcher, { signal: controller.signal }))
      .rejects.toMatchObject({ status: 499, message: 'Jev request was cancelled' });
    expect(service.requests).toHaveLength(2);
  });

  it('rejects invalid provider answers as the exported API error type', async () => {
    const service = await provider({ answers: { ...answers(), supported: { type: 'noul', noul: 2 } } });
    await expect(sdk.askJev(service.decider, 'sdk-local-test-key', {}, questions())).rejects.toBeInstanceOf(sdk.ApiError);
    await expect(sdk.decideWithJev('sdk-local-test-key', {}, questions(), service.fetcher))
      .rejects.toMatchObject({ status: 502, message: 'Jev returned an invalid answer for supported' });
    expect(service.requests).toHaveLength(2);
  });
});
