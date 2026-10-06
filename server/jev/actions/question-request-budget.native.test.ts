import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { decideWithJev, estimateJevTokens, JEV_STATE_TOKEN_LIMIT, noul, type JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import { judge, type JevEvaluationContext } from './context.js';
import { judgeQuestionSets, type JevQuestionSet } from './question-batch.js';
import { resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

type Source = { id: number; fact: string };
type Body = { state: { questionSets?: Source[]; questionTexts?: string[] }; questions: Record<string, JevQuestion> };
let provider: Server; let origin: string; let calls: Body[];
beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body; calls.push(body); response.setHeader('content-type', 'application/json');
    if (estimateJevTokens(body.state) + estimateJevTokens(body.questions) > 64000) {
      response.statusCode = 400; response.end(JSON.stringify({ detail: 'max tokens exceeded' })); return;
    }
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, nativeAnswer(id, body)])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native budget provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { calls = []; });
afterAll(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
function context(shared = true): JevEvaluationContext {
  return { workspaceId: 'workspace', canvases: [], documents: [], tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings,
    shareQuestionSources: shared, apiKey: 'native-question-budget', decider: (key, state, questions, _fetcher, options) =>
      decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
}
function questions() {
  return Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`q${index}`, noul(
    `Independently check claim ${index} using only the supplied shared source facts. ${'Require exact evidence; never infer unsupported responsibility or scope. '.repeat(10)}`)]));
}
function nativeAnswer(id: string, body: Body) {
  const match = /^(\d+)__fact_(\d+)$/.exec(id);
  const noul = match ? .7 + body.state.questionSets![Number(match[1])].id / 100 + Number(match[2]) / 1000 : .98;
  return { type: 'noul', noul };
}

it('splits aggregate-heavy shared question sets before HTTP and preserves every original source, question and answer', async () => {
  const sets: JevQuestionSet[] = Array.from({ length: 16 }, (_, id) => ({ state: { id, fact: `Exact source fact ${id}.` },
    questions: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`fact_${index}`, noul(`Evaluate only exact source ${id} claim ${index}: ${'e'.repeat(1500)}`)])) }));
  const before = structuredClone(sets);
  const allQuestions = Object.fromEntries(sets.flatMap((set, index) => Object.entries(set.questions).map(([id, value]) => [`${index}__${id}`, value])));
  const allState = { questionSets: sets.map(set => set.state) };
  expect(estimateJevTokens(allState) + Math.max(...Object.values(allQuestions).map(estimateJevTokens))).toBeLessThan(JEV_STATE_TOKEN_LIMIT);
  expect(estimateJevTokens(allState) + estimateJevTokens(allQuestions)).toBeGreaterThan(64000);
  const results = await judgeQuestionSets(context(), sets);
  expect(calls).toHaveLength(2);
  const sources: Source[] = [];
  for (const body of calls) {
    expect(estimateJevTokens(body.state) + estimateJevTokens(body.questions)).toBeLessThanOrEqual(64000);
    expect(estimateJevTokens(body.state) + Math.max(...Object.values(body.questions).map(estimateJevTokens))).toBeLessThanOrEqual(JEV_STATE_TOKEN_LIMIT);
    sources.push(...body.state.questionSets!);
    const decoded = resolveSharedQuestionTexts(body.questions, body.state.questionTexts);
    for (const [questionId, question] of Object.entries(decoded)) {
      const match = /^(\d+)__(fact_\d+)$/.exec(questionId)!;
      const source = body.state.questionSets![Number(match[1])];
      expect(question).toEqual({ ...sets[source.id].questions[match[2]],
        instructions: `Use only questionSets[${match[1]}] as the state for this question. ${sets[source.id].questions[match[2]].instructions}` });
    }
  }
  expect(sources.sort((left, right) => left.id - right.id)).toEqual(sets.map(set => set.state));
  expect(calls.reduce((count, body) => count + Object.keys(body.questions).length, 0)).toBe(192);
  expect(results).toEqual(sets.map((_, id) => Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
    [`fact_${index}`, { type: 'noul', noul: .7 + id / 100 + index / 1000 }]))));
  expect(sets).toEqual(before);
});

it('sends eighty independent shared questions in one real SDK request within state-plus-longest limits', async () => {
  const state = { facts: 'One exact source fact supports the declared claim.' }; const submitted = questions();
  expect(estimateJevTokens(state) + estimateJevTokens(submitted)).toBeGreaterThan(16000);
  expect(estimateJevTokens(state) + Math.max(...Object.values(submitted).map(estimateJevTokens))).toBeLessThan(JEV_STATE_TOKEN_LIMIT);
  const result = await judge(context(), state, submitted);
  expect(calls).toHaveLength(1); expect(Object.keys(calls[0].questions)).toHaveLength(80);
  expect(Object.keys(result)).toEqual(Object.keys(submitted)); expect(Object.values(result).every(answer => answer.type === 'noul' && answer.noul === 0.98)).toBe(true);
});
it('rejects oversized shared state-plus-longest before any native network request', async () => {
  const state = { facts: 'x'.repeat(JEV_STATE_TOKEN_LIMIT * 3) }; const submitted = { supported: noul('Check exact evidence.') };
  await expect(judge(context(), state, submitted)).rejects.toMatchObject({ status: 413 }); expect(calls).toEqual([]);
});
it('preserves the ordinary application budget even when the same eighty questions fit the SDK contract', async () => {
  await expect(judge(context(false), { facts: 'One exact source fact.' }, questions())).rejects.toMatchObject({ status: 413 });
  const ordinary = context(); delete ordinary.shareQuestionSources;
  await expect(judge(ordinary, { facts: 'One exact source fact.' }, questions())).rejects.toMatchObject({ status: 413 }); expect(calls).toEqual([]);
});
it('preserves credential-before-budget and budget-before-cancellation error order for shared bundles', async () => {
  const controller = new AbortController(); controller.abort(); const input = context(); input.signal = controller.signal;
  const tooLarge = { facts: 'x'.repeat(JEV_STATE_TOKEN_LIMIT * 3) };
  input.settings.externalProcessing = false;
  await expect(judge(input, tooLarge, questions())).rejects.toMatchObject({ status: 403 });
  input.settings.externalProcessing = true; input.apiKey = '';
  await expect(judge(input, tooLarge, questions())).rejects.toMatchObject({ status: 503 });
  input.apiKey = 'native-question-budget';
  await expect(judge(input, tooLarge, questions())).rejects.toMatchObject({ status: 413 });
  await expect(judge(input, { facts: 'Exact evidence.' }, { q: noul('Check evidence.') })).rejects.toMatchObject({ status: 499 });
  expect(calls).toEqual([]);
});
it('preserves empty-question local results before credentials, budget, or cancellation checks', async () => {
  const input = context(); input.apiKey = ''; input.settings.externalProcessing = false;
  const controller = new AbortController(); controller.abort(); input.signal = controller.signal;
  expect(await judge(input, { facts: 'x'.repeat(JEV_STATE_TOKEN_LIMIT * 3) }, {})).toEqual({}); expect(calls).toEqual([]);
});
it('retains native SDK question validation before any shared-bundle network request', async () => {
  await expect(judge(context(), { facts: 'Exact evidence.' }, { 'invalid-id': noul('Check evidence.') })).rejects.toMatchObject({ status: 500 });
  await expect(judge(context(), { facts: 'Exact evidence.' }, { q: noul('') })).rejects.toMatchObject({ status: 500 });
  expect(calls).toEqual([]);
});
