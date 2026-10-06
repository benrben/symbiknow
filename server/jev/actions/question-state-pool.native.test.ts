import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { decideWithJev, estimateJevTokens, noul, type JevQuestion } from '../../jev.js';
import { compileSharedQuestionStates, type SharedQuestionSourceState, type SharedQuestionStates } from './question-state-pool.js';

type Body = { state: SharedQuestionStates; questions: Record<string, JevQuestion> };
let provider: Server; let origin: string;
const requests: Array<{ body: Body; raw: string }> = [];
function source(id: string, declared: string): SharedQuestionSourceState {
  return { id, title: `Exact source ${id}`, coverage: .87,
    passages: Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`,
      text: `${declared} Evidence passage ${index}. ${'Retain exact source facts, quotes and component boundaries. '.repeat(25)}` })) };
}
const alpha = source('alpha', 'Alpha owns deployment.');
const beta = source('beta', 'Beta explicitly has no deployment responsibility.');
function restore(value: unknown, sources: SharedQuestionSourceState[]): unknown {
  if (Array.isArray(value)) return value.map(item => restore(item, sources));
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '$jevSourceRef')) {
    expect(Object.keys(record)).toEqual(['$jevSourceRef']);
    const index = record.$jevSourceRef;
    expect(Number.isSafeInteger(index)).toBe(true); expect(Number(index)).toBeGreaterThanOrEqual(0);
    expect(Number(index)).toBeLessThan(sources.length);
    return structuredClone(sources[Number(index)]);
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, restore(item, sources)]));
}
function questions(counts: number[]): Record<string, JevQuestion> {
  return Object.fromEntries(counts.flatMap((count, index) => Array.from({ length: count }, (_, question) => [
    `${index}__supported_${question}`,
    noul(`Use only questionSets[${index}] as the state for this question. Resolve any {"$jevSourceRef": n} only through sourceStates[n]. Other questionSets and unreferenced sourceStates are outside this question's scope. Does this source's exact passage declare deployment responsibility?`),
  ])));
}
const fetcher: typeof fetch = (_url, options) => fetch(origin, options);
beforeAll(async () => {
  provider = createServer(async (incoming, response) => {
    let raw = ''; for await (const chunk of incoming) raw += String(chunk);
    const body = JSON.parse(raw) as Body; requests.push({ body, raw });
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => {
      const index = Number(id.split('__')[0]);
      const selected = restore(body.state.questionSets[index], body.state.sourceStates) as { source: SharedQuestionSourceState };
      return [id, { type: 'noul', noul: selected.source.passages[0].text.startsWith('Alpha owns deployment.') ? .93 : .07 }];
    }));
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native pooled provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { requests.splice(0); });
afterAll(async () => {
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
});

it('fits86questions and16exact concept states in one actual SDK request by sharing the full original source once', async () => {
  const states = Array.from({ length: 16 }, (_, index) => ({ source: alpha,
    selectedConcept: { name: `Exact concept ${index}`, definition: 'Check this candidate against the supplied source.' },
    prior: { documents: [alpha] } }));
  const asked = questions(Array.from({ length: 16 }, (_, index) => index < 6 ? 6 : 5));
  expect(Object.keys(asked)).toHaveLength(86);
  expect(estimateJevTokens({ questionSets: states })).toBeGreaterThan(32_000);
  await expect(decideWithJev('native-pooled-key', { questionSets: states }, asked, fetcher, { maxRetries: 0 }))
    .rejects.toMatchObject({ status: 413 });
  expect(requests).toEqual([]);
  const compiled = compileSharedQuestionStates(states);
  expect(estimateJevTokens(compiled) + estimateJevTokens(asked)).toBeLessThanOrEqual(15_800);
  expect(await decideWithJev('native-pooled-key', compiled, asked, fetcher, { maxRetries: 0 }))
    .toEqual(Object.fromEntries(Object.keys(asked).map(id => [id, { type: 'noul', noul: .93 }])));
  expect(requests).toHaveLength(1); expect(requests[0].body.state.sourceStates).toEqual([alpha]);
  expect(requests[0].raw.split(JSON.stringify(alpha))).toHaveLength(2);
  expect(restore(requests[0].body.state.questionSets, requests[0].body.state.sourceStates)).toEqual(states);
  expect(requests[0].body.questions).toEqual(asked);
});

it('keeps distinct exact source quotes and native answers isolated despite one compact multi-source SDK request', async () => {
  const states = [{ source: alpha, sourceLabel: 'first' }, { source: beta, sourceLabel: 'second' }, { source: alpha, sourceLabel: 'third' }];
  const asked = questions([2, 2, 2]); const compiled = compileSharedQuestionStates(states);
  const answers = await decideWithJev('native-pooled-key', compiled, asked, fetcher, { maxRetries: 0 });
  expect(answers).toEqual({ '0__supported_0': { type: 'noul', noul: .93 }, '0__supported_1': { type: 'noul', noul: .93 },
    '1__supported_0': { type: 'noul', noul: .07 }, '1__supported_1': { type: 'noul', noul: .07 },
    '2__supported_0': { type: 'noul', noul: .93 }, '2__supported_1': { type: 'noul', noul: .93 } });
  expect(requests).toHaveLength(1); expect(requests[0].body.state.sourceStates).toEqual([alpha, beta]);
  expect(requests[0].body.state.questionSets.map(state => state.source)).toEqual([
    { $jevSourceRef: 0 }, { $jevSourceRef: 1 }, { $jevSourceRef: 0 },
  ]);
  expect(requests[0].raw.split(JSON.stringify(alpha))).toHaveLength(2);
  expect(requests[0].raw.split(JSON.stringify(beta))).toHaveLength(2);
  expect(restore(requests[0].body.state.questionSets, requests[0].body.state.sourceStates)).toEqual(states);
});
