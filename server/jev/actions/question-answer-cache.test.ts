import { expect, it } from 'vitest';
import { choice, noul, score, type JevAnswer, type JevDecider, type JevQuestion } from '../../jev.js';
import { QuestionAnswerCache } from './question-answer-cache.js';

const key = 'isolated-native-cache-key';
const state = { source: { id: 'atlas', title: 'Atlas', passages: ['Owner: Alice.'] },
  decisionProgram: { questionVersion: 'cache-program', sourceTrust: 'untrusted_evidence' } };
const questions = { supports: noul('Does the exact source declare responsibility?') };
function transport(answer: Record<string, JevAnswer> = { supports: { type: 'noul', noul: .99 } }) {
  const calls: unknown[] = [];
  const decider: JevDecider = async (_key, input) => { calls.push(input); return answer; };
  return { calls, decider };
}

it('reuses exact original JSON inputs across transport wrappers and returns independent answers', async () => {
  const cache = new QuestionAnswerCache(); const upstream = transport(); const another = transport();
  const first = cache.decider('workspace:checked-policy', upstream.decider);
  const result = await first(key, state, questions); (result.supports as { noul: number }).noul = .1;
  expect(await cache.decider('workspace:checked-policy', another.decider)(key, structuredClone(state), structuredClone(questions)))
    .toEqual({ supports: { type: 'noul', noul: .99 } });
  expect(upstream.calls).toHaveLength(1); expect(another.calls).toHaveLength(0);
});

it('preserves fetcher, retry and signal options while snapshotting the exact JSON request before caller edits', async () => {
  const cache = new QuestionAnswerCache(); const controller = new AbortController();
  const fetcher: typeof fetch = async () => new Response('{}'); const options = { signal: controller.signal, maxRetries: 3, baseDelayMs: 19 };
  const input = structuredClone(state); const asked = structuredClone(questions);
  let resolve!: (value: Record<string, JevAnswer>) => void;
  const held = new Promise<Record<string, JevAnswer>>(done => { resolve = done; });
  const decider: JevDecider = async (_key, captured, capturedQuestions, receivedFetcher, receivedOptions) => {
    expect(receivedFetcher).toBe(fetcher); expect(receivedOptions).toBe(options);
    expect(captured).toEqual(state); expect(capturedQuestions).toEqual(questions); return held;
  };
  const pending = cache.decider('scope', decider)(key, input, asked, fetcher, options);
  input.source.title = 'Caller changed title'; asked.supports.instructions = 'Caller changed instructions';
  resolve({ supports: { type: 'noul', noul: .99 } }); await pending;
  const fresh = transport(); await cache.decider('scope', fresh.decider)(key, state, questions);
  expect(fresh.calls).toHaveLength(0);
});

it.each(['partition', 'key', 'state', 'question', 'program'] as const)('never reuses an answer after an exact %s input changes', async change => {
  const cache = new QuestionAnswerCache(); const upstream = transport();
  await cache.decider('scope', upstream.decider)(key, state, questions);
  const input = structuredClone(state); const asked = structuredClone(questions);
  if (change === 'state') input.source.passages = ['Owner: Bob.'];
  if (change === 'program') input.decisionProgram.questionVersion = 'next-program';
  if (change === 'question') asked.supports.instructions = 'Does the source assign review responsibility?';
  await cache.decider(change === 'partition' ? 'other-scope' : 'scope', upstream.decider)(change === 'key' ? `${key} ` : key, input, asked);
  expect(upstream.calls).toHaveLength(2);
});

it('expires answers after sixty seconds without extending their lifetime on a cache hit', async () => {
  let now = 0; const cache = new QuestionAnswerCache({ now: () => now }); const upstream = transport(); const decide = cache.decider('scope', upstream.decider);
  await decide(key, state, questions); now = 59_999; await decide(key, state, questions); expect(upstream.calls).toHaveLength(1);
  now = 60_000; await decide(key, state, questions); expect(upstream.calls).toHaveLength(2);
});

it('bounds the default cache to 2048 entries and touches hits before least-recently-used eviction', async () => {
  const cache = new QuestionAnswerCache(); const upstream = transport(); const decide = cache.decider('scope', upstream.decider);
  for (let id = 0; id < 2048; id++) await decide(key, { id }, questions);
  await decide(key, { id: 0 }, questions); await decide(key, { id: 2048 }, questions);
  await decide(key, { id: 0 }, questions); expect(upstream.calls).toHaveLength(2049);
  await decide(key, { id: 1 }, questions); expect(upstream.calls).toHaveLength(2050);
});

it('declines an individual serialized answer beyond the default eight MiB budget', async () => {
  const cache = new QuestionAnswerCache();
  const upstream = transport({ quality: { type: 'score', score: 1, confidence: .99, probabilities: { '0': 0, '1': 1 },
    legend: { description: 'x'.repeat(4 * 1024 * 1024) } } });
  const decide = cache.decider('scope', upstream.decider); const asked = { quality: score('Assess supplied evidence.', ['Unknown', 'Supported']) };
  await decide(key, state, asked); await decide(key, state, asked); expect(upstream.calls).toHaveLength(2);
});

it('evicts accumulated answers by bytes even while their entry count remains below its limit', async () => {
  const cache = new QuestionAnswerCache({ maxBytes: 1024 }); const upstream = transport(); const decide = cache.decider('scope', upstream.decider);
  await decide(key, { id: 1 }, questions); await decide(key, { id: 2 }, questions); await decide(key, { id: 3 }, questions);
  await decide(key, { id: 2 }, questions); await decide(key, { id: 3 }, questions); expect(upstream.calls).toHaveLength(3);
  await decide(key, { id: 1 }, questions); expect(upstream.calls).toHaveLength(4);
});

it.each([{ maxEntries: 0 }, { maxBytes: 0 }, { ttlMs: 0 }])('supports a disabled bound without retaining answers: %j', options => {
  const cache = new QuestionAnswerCache(options); const upstream = transport(); const decide = cache.decider('scope', upstream.decider);
  return decide(key, state, questions).then(() => decide(key, state, questions)).then(() => expect(upstream.calls).toHaveLength(2));
});

it.each([{ maxEntries: -1 }, { maxBytes: NaN }, { ttlMs: Infinity }, { maxBytes: .5 }, { ttlMs: Number.MAX_SAFE_INTEGER + 1 }])
('rejects invalid cache limits: %j', options => { expect(() => new QuestionAnswerCache(options)).toThrow(RangeError); });

it('clears completed entries and prevents a valid response pending during clear from repopulating the cache', async () => {
  const cache = new QuestionAnswerCache(); const upstream = transport(); const decide = cache.decider('scope', upstream.decider);
  await decide(key, state, questions); cache.clear(); await decide(key, state, questions); expect(upstream.calls).toHaveLength(2);
  let resolve!: (value: Record<string, JevAnswer>) => void; const pending = new Promise<Record<string, JevAnswer>>(done => { resolve = done; });
  const held = cache.decider('other', async () => pending)(key, state, questions);
  cache.clear(); resolve({ supports: { type: 'noul', noul: .99 } }); await held;
  await cache.decider('other', upstream.decider)(key, state, questions); expect(upstream.calls).toHaveLength(3);
});

it('keeps local empty-question behavior and forwards the untouched original arguments without caching', async () => {
  const cache = new QuestionAnswerCache(); let calls = 0; const input = { field: undefined };
  const decide = cache.decider('scope', async (_key, captured, asked) => { calls++; expect(captured).toBe(input); expect(asked).toEqual({}); return {}; });
  await decide('', input, {}); await decide('', input, {}); expect(calls).toBe(2);
});

it('validates the complete serialized answer snapshot rather than caching a misleading custom toJSON result', async () => {
  const cache = new QuestionAnswerCache(); let calls = 0;
  const decide = cache.decider('scope', async () => { calls++; return { supports: { type: 'noul', noul: .99 }, toJSON: () => ({}) } as never; });
  await expect(decide(key, state, questions)).rejects.toMatchObject({ status: 502 });
  await expect(decide(key, state, questions)).rejects.toMatchObject({ status: 502 }); expect(calls).toBe(2);
});

it('snapshots provider extras along with valid typed answers and preserves independent choice probabilities and score legends', async () => {
  const cache = new QuestionAnswerCache(); const asked: Record<string, JevQuestion> = {
    owner: choice('Choose the explicitly declared owner.', { alice: 'Alice', unknown: 'Unknown' }), quality: score('Assess evidence.', ['Unknown', 'Supported']),
  };
  const upstream = transport({ owner: { type: 'choice', choice: 'alice', confidence: .99, probabilities: { alice: 1, unknown: 0 } },
    quality: { type: 'score', score: 1, confidence: .99, probabilities: { '0': 0, '1': 1 }, legend: { '1': 'Supported' } },
    extra: { type: 'noul', noul: .75 } });
  const decide = cache.decider('scope', upstream.decider); const first = await decide(key, state, asked);
  (first.owner as { probabilities: Record<string, number> }).probabilities.alice = 0;
  (first.quality as { legend: Record<string, string> }).legend['1'] = 'Caller edit';
  const fresh = await decide(key, state, asked);
  expect(fresh.owner).toMatchObject({ probabilities: { alice: 1 } }); expect(fresh.quality).toMatchObject({ legend: { '1': 'Supported' } });
  expect(fresh.extra).toEqual({ type: 'noul', noul: .75 }); expect(upstream.calls).toHaveLength(1);
});
