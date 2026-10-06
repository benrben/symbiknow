import { describe, expect, it, vi } from 'vitest';
import {
  askJev, assertValidJevRequest, choice, decideWithJev, estimateJevTokens, JEV_MODEL, JEV_STATE_TOKEN_LIMIT,
  noul, onJevUsage, score, type JevDecider, type JevQuestion, type JevUsage,
} from './jev.js';

const questions: Record<string, JevQuestion> = {
  kind: { type: 'choice', instructions: 'Pick a kind', criteria: { guide: 'Instructions', plan: 'Future work' } },
  value: { type: 'score', instructions: 'Rate relevance', criteria: ['None', 'Some', 'Much'] },
  yes: { type: 'noul', instructions: 'Is it true?' },
};

const answers = {
  kind: { type: 'choice', choice: 'guide', probabilities: { guide: 0.9, plan: 0.1 }, confidence: 0.9 },
  value: { type: 'score', score: 1.5, probabilities: { 0: 0, 1: 0.5, 2: 0.5 }, confidence: 0.8 },
  yes: { type: 'noul', noul: 0.95 },
};

describe('TypeSafe Jev adapter', () => {
  it('sends one typed Decisions request and returns validated answers', async () => {
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args).toHaveLength(2);
      return Response.json({ answers });
    });
    expect(await decideWithJev('private-key', { text: 'sample' }, questions, fetcher)).toEqual(answers);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options?.method).toBe('POST');
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer private-key');
    expect(JSON.parse(String(options?.body))).toEqual({ model: JEV_MODEL, state: { text: 'sample' }, questions });
  });

  it('requires a key and skips requests without questions', async () => {
    const fetcher = vi.fn(async () => Response.json({ answers }));
    await expect(decideWithJev('', {}, questions, fetcher)).rejects.toMatchObject({
      status: 400, message: 'A TypeSafe Jev API key is required',
    });
    expect(await decideWithJev('key', {}, {}, fetcher)).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not expose credentials from provider and network errors', async () => {
    const key = 'secret-key';
    await expect(decideWithJev(key, {}, questions, async () => { throw Error(key); }, { baseDelayMs: 0 }))
      .rejects.toMatchObject({ status: 502, message: 'Could not reach TypeSafe Jev' });
    await expect(decideWithJev(key, {}, questions, async () => new Response(key, { status: 401 })))
      .rejects.toMatchObject({ status: 502, message: 'TypeSafe Jev rejected the API key (401). Check the supplied API key.' });
  });

  it('surfaces safe provider validation messages without echoing request input', async () => {
    const response = Response.json({ detail: [{ loc: ['body', 'questions', 'choice'], msg: 'Too many options',
      input: 'secret document content' }] }, { status: 400 });
    await expect(decideWithJev('private-key', {}, questions, async () => response)).rejects.toMatchObject({
      status: 502, message: 'Jev request failed (400): body.questions.choice: Too many options',
    });
    await expect(decideWithJev('private-key', {}, questions, async () => Response.json({
      detail: { error_type: 'max_tokens_exceeded' },
    }, { status: 400 }))).rejects.toMatchObject({ status: 502,
      message: 'Jev request failed (400): max tokens exceeded' });
  });

  it('rejects missing, oversized, malformed, and incomplete response bodies', async () => {
    const cases = [
      [new Response(null), 'Jev returned an empty response'],
      [new Response('x'.repeat(262_145)), 'Jev response is too large'],
      [new Response('{'), 'Jev returned invalid JSON'],
      [Response.json({}), 'Jev returned no answers'],
      [Response.json({ answers: null }), 'Jev returned no answers'],
      [Response.json({ answers: { ...answers, yes: { type: 'noul', noul: 2 } } }), 'Jev returned an invalid answer for yes'],
    ] as const;
    for (const [response, message] of cases) {
      await expect(decideWithJev('key', {}, questions, async () => response))
        .rejects.toMatchObject({ status: 502, message });
    }
  });

  it('redacts a response stream read failure', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(Error('secret-key')); },
    });
    await expect(decideWithJev('secret-key', {}, questions, async () => new Response(body)))
      .rejects.toMatchObject({ status: 502, message: 'Jev response could not be read' });
  });

  it('checks selected options, score bounds, confidence, and probability maps', async () => {
    const invalid = [
      { kind: { ...answers.kind, choice: 'unknown' } },
      { kind: { ...answers.kind, probabilities: { guide: 1 } } },
      { kind: { ...answers.kind, confidence: -1 } },
      { value: { ...answers.value, score: 3 } },
      { value: { ...answers.value, probabilities: { 0: 1, 1: 0 } } },
      { value: { ...answers.value, type: 'choice' } },
    ];
    for (const change of invalid) {
      await expect(decideWithJev('key', {}, questions, async () => Response.json({ answers: { ...answers, ...change } })))
        .rejects.toMatchObject({ status: 502 });
    }
  });

  it('sends the pinned model, and keeps noul criteria keys limited to true/false', async () => {
    const withCriteria: Record<string, JevQuestion> = {
      ...questions,
      flag: { type: 'noul', instructions: 'Is this stale?', criteria: { true: 'Stale', false: 'Current' } },
    };
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return Response.json({ answers: { ...answers, flag: { type: 'noul', noul: 0.5 } } });
    });
    await decideWithJev('key', { text: 'sample' }, withCriteria, fetcher);
    const [, options] = fetcher.mock.calls[0];
    const body = JSON.parse(String(options?.body)) as { model: string; questions: Record<string, JevQuestion> };
    expect(body.model).toBe(JEV_MODEL);
    for (const question of Object.values(body.questions)) {
      if (question.type === 'noul' && question.criteria) {
        expect(Object.keys(question.criteria).every(key => key === 'true' || key === 'false')).toBe(true);
      }
    }
  });

  describe('retries', () => {
    it('retries a 429 once with baseDelayMs 0, then succeeds', async () => {
      let calls = 0;
      const fetcher = vi.fn(async () => {
        calls++;
        return calls === 1 ? new Response(null, { status: 429 }) : Response.json({ answers });
      });
      await expect(decideWithJev('key', {}, questions, fetcher, { baseDelayMs: 0 })).resolves.toEqual(answers);
      expect(calls).toBe(2);
    });

    it('honors a short Retry-After header before retrying', async () => {
      vi.useFakeTimers();
      try {
        let calls = 0;
        const fetcher = vi.fn(async () => {
          calls++;
          return calls === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } }) : Response.json({ answers });
        });
        const promise = decideWithJev('key', {}, questions, fetcher, { baseDelayMs: 0 });
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(promise).resolves.toEqual(answers);
        expect(calls).toBe(2);
      } finally { vi.useRealTimers(); }
    });

    it('stops without waiting when Retry-After exceeds 10s, and reports the 429 message', async () => {
      const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '20' } }));
      await expect(decideWithJev('key', {}, questions, fetcher, { baseDelayMs: 0 })).rejects.toMatchObject({
        status: 502, message: 'TypeSafe Jev rate limit reached (429). Try again shortly.',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('gives up after exhausting retries on repeated 529s, with a clear message', async () => {
      const fetcher = vi.fn(async () => new Response(null, { status: 529 }));
      await expect(decideWithJev('key', {}, questions, fetcher, { baseDelayMs: 0 })).rejects.toMatchObject({
        status: 502, message: 'TypeSafe Jev is overloaded (529). Try again shortly.',
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('stops retrying immediately when the caller aborts', async () => {
      const controller = new AbortController();
      let calls = 0;
      const fetcher = vi.fn(async () => {
        calls++;
        controller.abort();
        return new Response(null, { status: 429 });
      });
      await expect(decideWithJev('key', {}, questions, fetcher, { baseDelayMs: 50, signal: controller.signal }))
        .rejects.toMatchObject({ status: 499, message: 'Jev request was cancelled' });
      expect(calls).toBe(1);
    });

    it('rejects immediately when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const fetcher = vi.fn(async () => Response.json({ answers }));
      await expect(decideWithJev('key', {}, questions, fetcher, { signal: controller.signal }))
        .rejects.toMatchObject({ status: 499, message: 'Jev request was cancelled' });
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('usage metering', () => {
    it('reports usage to subscribed listeners after a successful call', async () => {
      const received: JevUsage[] = [];
      const unsubscribe = onJevUsage(usage => received.push(usage));
      try {
        const fetcher = vi.fn(async () => Response.json({ answers, usage: { input_tokens: 120, output_tokens: 40 } }));
        await decideWithJev('key', {}, questions, fetcher);
      } finally { unsubscribe(); }
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ model: JEV_MODEL, inputTokens: 120, outputTokens: 40, questions: Object.keys(questions).length });
      expect(typeof received[0].at).toBe('string');
    });

    it('ignores missing or invalid usage fields, and never lets a bad listener break the call', async () => {
      const unsubscribe = onJevUsage(() => { throw new Error('listener boom'); });
      try {
        const fetcher = vi.fn(async () => Response.json({ answers, usage: { input_tokens: 'nope' } }));
        await expect(decideWithJev('key', {}, questions, fetcher)).resolves.toEqual(answers);
      } finally { unsubscribe(); }
    });
  });

  describe('askJev', () => {
    it('types answers by the literal shape of the questions asked', async () => {
      const decider: JevDecider = async () => ({
        x: { type: 'choice', choice: 'a', probabilities: { a: 1, b: 0 }, confidence: 0.9 },
      });
      const a = await askJev(decider, 'key', {}, { x: choice('Pick', { a: 'A', b: 'B' }) });
      a.x.choice satisfies 'a' | 'b';
      expect(a.x.choice).toBe('a');
    });

    it('rejects a decider that omits a requested id or returns the wrong type', async () => {
      const missing: JevDecider = async () => ({});
      await expect(askJev(missing, 'key', {}, { x: noul('Is it true?') })).rejects.toMatchObject({ status: 502 });
      const wrongType: JevDecider = async () => ({ x: { type: 'score', score: 1, probabilities: { 0: 1 }, confidence: 1 } });
      await expect(askJev(wrongType, 'key', {}, { x: noul('Is it true?') })).rejects.toMatchObject({ status: 502 });
    });
  });
});

describe('assertValidJevRequest', () => {
  function status(fn: () => void): number | undefined {
    try { fn(); return undefined; }
    catch (error) { return (error as { status?: number }).status; }
  }

  it('rejects a noul question with yes/no criteria keys instead of true/false', () => {
    const bad = { type: 'noul', instructions: 'ok', criteria: { yes: 'y', no: 'n' } } as unknown as JevQuestion;
    expect(() => assertValidJevRequest({}, { q: bad })).toThrow(/true and\/or false/);
    expect(status(() => assertValidJevRequest({}, { q: bad }))).toBe(500);
  });

  it('rejects score questions with fewer than 2 or more than 10 levels', () => {
    expect(() => assertValidJevRequest({}, { q: score('ok', ['one']) })).toThrow(/2 to 10 levels/);
    expect(() => assertValidJevRequest({}, { q: score('ok', Array.from({ length: 11 }, (_, i) => `L${i}`)) })).toThrow(/2 to 10 levels/);
  });

  it('rejects choice questions with 256 options', () => {
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, `Option ${i}`]));
    expect(() => assertValidJevRequest({}, { q: choice('ok', criteria) })).toThrow(/2 to 255 options/);
  });

  it('accepts a choice question with exactly 255 options', () => {
    const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, `Option ${i}`]));
    expect(() => assertValidJevRequest({}, { q: choice('ok', criteria) })).not.toThrow();
  });

  it('rejects a state and question that together exceed the token limit', () => {
    const state = { text: 'x'.repeat(200_000) };
    expect(estimateJevTokens(state)).toBeGreaterThan(JEV_STATE_TOKEN_LIMIT);
    expect(status(() => assertValidJevRequest(state, { q: noul('ok') }))).toBe(413);
    expect(() => assertValidJevRequest(state, { q: noul('ok') })).toThrow(/too large/);
  });

  it('accepts a small state well under the token limit', () => {
    expect(() => assertValidJevRequest({ text: 'sample' }, { q: noul('ok') })).not.toThrow();
  });
});
