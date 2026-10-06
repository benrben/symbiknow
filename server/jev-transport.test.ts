import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertValidJevRequest, choice, decideWithJev, estimateJevTokens, noul, onJevUsage, score } from './jev.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const question = { q: noul('Is this true?') };
const answers = { q: { type: 'noul', noul: 0.9 } };

describe('Jev provider diagnostics', () => {
  it.each([
    { body: null, suffix: '' }, { body: false, suffix: '' }, { body: [], suffix: '' },
    { body: { detail: 'Short diagnostic' }, suffix: ': Short diagnostic' },
    { body: { message: 'Message diagnostic' }, suffix: ': Message diagnostic' },
    { body: {}, suffix: '' }, { body: { detail: { error_type: 'Invalid Type' } }, suffix: '' },
    { body: { detail: { error_type: 1 }, message: 'Fallback message' }, suffix: ': Fallback message' },
    { body: { detail: [null, { msg: 'Plain diagnostic' }] }, suffix: ': Plain diagnostic' },
    { body: { detail: [{ msg: 2 }, { msg: 'Nested diagnostic', loc: ['questions', 2, null, {}] }] }, suffix: ': questions.2: Nested diagnostic' },
  ])('limits diagnostics to meaningful structured values: $suffix', async ({ body, suffix }) => {
    await expect(decideWithJev('fixture', {}, question, async () => Response.json(body, { status: 400 })))
      .rejects.toMatchObject({ status: 502, message: `Jev request failed (400)${suffix}` });
  });

  it.each(['not-json', 'x'.repeat(262_145)])('uses a status message if an error body cannot be read', async body => {
    await expect(decideWithJev('fixture', {}, question, async () => new Response(body, { status: 400 })))
      .rejects.toMatchObject({ status: 502, message: 'Jev request failed (400)' });
  });
});

describe('Jev retry timing and cancellation', () => {
  it.each(['not-a-date', 'Thu, 01 Oct 2026 00:00:02 GMT', 'Wed, 30 Sep 2026 23:00:00 GMT'])
    ('handles retry dates and invalid retry headers: %s', async header => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after': header } }))
        .mockResolvedValueOnce(Response.json({ answers }));
      const result = decideWithJev('fixture', {}, question, fetcher, { baseDelayMs: 0 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toEqual(answers);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('stops during a pending backoff without starting another network request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 503, headers: { 'retry-after': '2' } }));
    const result = decideWithJev('fixture', {}, question, fetcher, { signal: controller.signal });
    const stopped = expect(result).rejects.toMatchObject({ status: 499 });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await stopped;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('redacts a fetch failure caused by caller cancellation', async () => {
    const controller = new AbortController();
    const fetcher: typeof fetch = async () => { controller.abort(); throw new Error('Private detail'); };
    await expect(decideWithJev('fixture', {}, question, fetcher, { signal: controller.signal }))
      .rejects.toMatchObject({ status: 499, message: 'Jev request was cancelled' });
  });
});

describe('Jev typed answer and request validation', () => {
  it.each([{ 0: 'No', 1: 'Yes' }, null, { 0: 5 }])('validates optional score legends', async legend => {
    const fetcher: typeof fetch = async () => Response.json({ answers: { q: { type: 'score', score: 1,
      confidence: 1, probabilities: { 0: 0, 1: 1 }, legend } } });
    const result = decideWithJev('fixture', {}, { q: score('Rate this', ['No', 'Yes']) }, fetcher);
    if (legend?.[0] === 'No') expect((await result).q).toMatchObject({ legend });
    else await expect(result).rejects.toMatchObject({ status: 502 });
  });

  it('rejects invalid question IDs, empty instructions and empty choice keys', () => {
    expect(() => assertValidJevRequest({}, { 'bad-id': noul('Check') })).toThrow('Invalid Jev question id');
    expect(() => assertValidJevRequest({}, { q: noul(' ') })).toThrow('empty instructions');
    expect(() => assertValidJevRequest({}, { q: choice('Choose', { '': 'Empty', other: 'Other' }) })).toThrow('empty option key');
    expect(estimateJevTokens(undefined)).toBe(2);
    expect(noul('Check', { true: 'Supported', false: 'Unsupported' }).criteria).toEqual({ true: 'Supported', false: 'Unsupported' });
  });

  it('keeps successful decisions available when a usage listener fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unsubscribe = onJevUsage(() => { throw new Error('Listener unavailable'); });
    try {
      expect(await decideWithJev('fixture', {}, question, async () => Response.json({ answers,
        usage: { input_tokens: 1, output_tokens: 2 } }))).toEqual(answers);
      expect(warning).toHaveBeenCalledWith('A Jev usage listener failed; the decision result remains available.');
    } finally { unsubscribe(); }
  });
});
