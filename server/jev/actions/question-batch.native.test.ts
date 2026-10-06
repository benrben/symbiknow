import { createServer, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { decideWithJev, estimateJevTokens, noul, type JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import { cachedQuestionContext } from '../runtime-question-prefetch.js';
import type { JevEvaluationContext } from './context.js';
import { judgeQuestionSets, type JevQuestionSet } from './question-batch.js';
import { QuestionAnswerCache } from './question-answer-cache.js';
import { questionRequestFits } from './question-request-budget.js';

type SourceState = { id: number; quote: string };
type ProviderBody = { state: SourceState & { questionSets?: SourceState[] }; questions: Record<string, JevQuestion> };
type HeldRequest = { body: ProviderBody; response: ServerResponse };
async function provider(cached = false) {
  const requests: HeldRequest[] = []; const failures = new Map<number, unknown>(); let active = 0; let peak = 0;
  const server = createServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += String(chunk);
    requests.push({ body: JSON.parse(input) as ProviderBody, response });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing provider address');
  const origin = `http://127.0.0.1:${address.port}`;
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [],
    settings: emptyJevWorkspace().settings, apiKey: 'native-fixture',
    decider: async (key, state, questions, _fetcher, options) => {
      active += 1; peak = Math.max(peak, active);
      const body = state as ProviderBody['state']; const index = (body.questionSets ?? [body])[0].id;
      try { return await decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options); }
      catch (error) { failures.set(index, error); throw error; }
      finally { active -= 1; }
    } };
  return { context: cached ? cachedQuestionContext(context, new QuestionAnswerCache(), 'native-question-pool') : context,
    requests, failures, active: () => active, peak: () => peak,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function splitSets(count: number, shared = false): JevQuestionSet[] {
  return Array.from({ length: count }, (_, id) => ({ state: { id, quote: `Exact source passage ${id}. ${'Source prose. '.repeat(shared ? 2900 : 1650)}` },
    questions: { support: noul('Does this exact source support its stated purpose?') } }));
}
function respond(request: HeldRequest, status = 200) {
  const answers = Object.fromEntries(Object.keys(request.body.questions).map(id => {
    const match = /^(\d+)__/.exec(id);
    const source = match ? request.body.state.questionSets![Number(match[1])] : request.body.state;
    return [id, { type: 'noul', noul: 0.8 + source.id / 100 }];
  }));
  request.response.writeHead(status, { 'content-type': 'application/json' });
  request.response.end(JSON.stringify(status === 200 ? { answers } : { detail: 'Native chunk failure' }));
}
function chunkIds(requests: HeldRequest[]) {
  return requests.map(({ body }) => (body.state.questionSets ?? [body.state]).map(source => source.id));
}

it.each([false, true])('overlaps three independently budget-split SDK chunks and keeps isolated states and answers in source order (cached=%s)', async cached => {
  const native = await provider(cached); const sets = splitSets(6, cached); const original = structuredClone(sets);
  const pending = judgeQuestionSets(native.context, sets);
  try {
    await expect.poll(() => native.requests.length, { timeout: 450, interval: 5 }).toBe(3);
    expect(native.peak()).toBe(3); expect(chunkIds(native.requests)).toEqual([[0, 1], [2, 3], [4, 5]]);
    for (const { body } of native.requests) {
      expect(questionRequestFits(body.state, body.questions, cached)).toBe(true);
      if (cached) {
        const longest = Math.max(...Object.values(body.questions).map(estimateJevTokens));
        expect(estimateJevTokens(body.state) + longest).toBeLessThanOrEqual(27800);
      } else {
        expect(estimateJevTokens({ questionSets: body.state.questionSets }) + estimateJevTokens(body.questions)).toBeLessThanOrEqual(15800);
        expect(estimateJevTokens(body.state) + estimateJevTokens(body.questions)).toBeLessThanOrEqual(16000);
      }
      expect(body.state.questionSets!.map(({ id, quote }) => ({ id, quote })))
        .toEqual(sets.slice(body.state.questionSets![0].id, body.state.questionSets![0].id + 2).map(set => set.state));
      for (const [id, question] of Object.entries(body.questions)) expect(question.instructions).toContain(`Use only questionSets[${id.split('__')[0]}]`);
    }
    for (const index of [2, 0, 1]) respond(native.requests[index]);
    expect(await pending).toEqual(sets.map((_, id) => ({ support: { type: 'noul', noul: 0.8 + id / 100 } })));
    expect(sets).toEqual(original); expect(native.active()).toBe(0);
  } finally {
    for (const request of native.requests) if (!request.response.writableEnded) respond(request);
    await native.close(); await pending.catch(() => undefined);
  }
});

it.each([false, true])('admits at most four native SDK chunks and maps later out-of-order responses to their original positions (cached=%s)', async cached => {
  const native = await provider(cached); const sets = splitSets(12, cached);
  const pending = judgeQuestionSets(native.context, sets);
  try {
    await expect.poll(() => native.requests.length, { timeout: 450, interval: 5 }).toBe(4);
    expect(native.active()).toBe(4); expect(native.peak()).toBe(4);
    respond(native.requests[3]);
    await expect.poll(() => native.requests.length, { timeout: 450, interval: 5 }).toBe(5);
    expect(native.active()).toBe(4); respond(native.requests[4]);
    await expect.poll(() => native.requests.length, { timeout: 450, interval: 5 }).toBe(6);
    for (const index of [5, 2, 1, 0]) respond(native.requests[index]);
    expect(await pending).toEqual(sets.map((_, id) => ({ support: { type: 'noul', noul: 0.8 + id / 100 } })));
    expect(chunkIds(native.requests)).toEqual([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]]);
    expect(native.peak()).toBe(4); expect(native.active()).toBe(0);
  } finally { await native.close(); await pending.catch(() => undefined); }
});

it.each([false, true])('stops admission after a later SDK failure, drains started calls and throws the original lowest-index failure (cached=%s)', async cached => {
  const native = await provider(cached); let settled = false;
  const pending = judgeQuestionSets(native.context, splitSets(12, cached)).finally(() => { settled = true; });
  const observed = pending.then(value => ({ value }), error => ({ error }));
  try {
    await expect.poll(() => native.requests.length, { timeout: 450, interval: 5 }).toBe(4);
    respond(native.requests[2], 503);
    await expect.poll(() => native.failures.has(4), { timeout: 450, interval: 5 }).toBe(true);
    expect(settled).toBe(false); expect(native.requests).toHaveLength(4);
    respond(native.requests[1], 503);
    await expect.poll(() => native.failures.has(2), { timeout: 450, interval: 5 }).toBe(true);
    expect(settled).toBe(false); respond(native.requests[3]); respond(native.requests[0]);
    expect(await observed).toEqual({ error: native.failures.get(2) });
    expect((await observed as { error: unknown }).error).toBe(native.failures.get(2));
    expect(native.requests).toHaveLength(4); expect(native.active()).toBe(0);
  } finally { await native.close(); await observed; }
});

it.each([false, true])('cancels all started native SDK chunks without admitting the remaining chunks or returning partial answers (cached=%s)', async cached => {
  const native = await provider(cached); const controller = new AbortController();
  const pending = judgeQuestionSets({ ...native.context, signal: controller.signal }, splitSets(12, cached));
  const observed = pending.then(value => ({ value }), error => ({ error }));
  try {
    await expect.poll(() => native.requests.length, { timeout: 450, interval: 5 }).toBe(4);
    controller.abort();
    const outcome = await observed;
    expect(outcome).toMatchObject({ error: { status: 499, message: 'Jev request was cancelled' } });
    expect((outcome as { error: unknown }).error).toBe(native.failures.get(0));
    expect(native.failures.size).toBe(4); expect(native.active()).toBe(0); expect(native.requests).toHaveLength(4);
  } finally { controller.abort(); await native.close(); await observed; }
});

it.each([false, true])('preserves legacy guard order and local empty questions when a wave is already aborted (cached=%s)', async cached => {
  const native = await provider(cached); const controller = new AbortController(); controller.abort();
  const context = { ...native.context, signal: controller.signal };
  try {
    expect(await judgeQuestionSets(context, [])).toEqual([]);
    expect(await judgeQuestionSets(context, [{ state: {}, questions: {} }, { state: {}, questions: {} }])).toEqual([{}, {}]);
    await expect(judgeQuestionSets({ ...context, apiKey: '', settings: { ...context.settings, externalProcessing: false } }, splitSets(6, cached)))
      .rejects.toMatchObject({ status: 403 });
    await expect(judgeQuestionSets({ ...context, apiKey: '' }, splitSets(6, cached))).rejects.toMatchObject({ status: 503 });
    await expect(judgeQuestionSets(context, [{ state: { quote: 'Large source '.repeat(20000) }, questions: { support: noul('Supported?') } }, ...splitSets(2, cached)]))
      .rejects.toMatchObject({ status: 413 });
    await expect(judgeQuestionSets(context, splitSets(6, cached))).rejects.toMatchObject({ status: 499, message: 'Symbi Reflex evaluation was cancelled' });
    expect(native.requests).toHaveLength(0);
  } finally { await native.close(); }
});

it('keeps empty decisions local and rejects an oversized single source before sending native provider traffic', async () => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1; let input = ''; for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as { questions: Record<string, JevQuestion> };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.94 }])) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing provider address');
  const origin = `http://127.0.0.1:${address.port}`;
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [],
    settings: emptyJevWorkspace().settings, apiKey: 'native-fixture',
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
  try {
    expect(await judgeQuestionSets(context, [])).toEqual([]);
    expect(await judgeQuestionSets(context, [{ state: { source: 'No questions' }, questions: {} }])).toEqual([{}]);
    expect(requests).toBe(0);
    await expect(judgeQuestionSets(context, [{ state: { source: 'Large source '.repeat(20_000) }, questions: { support: noul('Supported?') } }]))
      .rejects.toMatchObject({ status: 413 });
    expect(requests).toBe(0);
    expect(await judgeQuestionSets(context, [{ state: { source: 'Small source' }, questions: { support: noul('Supported?') } }]))
      .toEqual([{ support: { type: 'noul', noul: 0.94 } }]);
    expect(requests).toBe(1);
    const controller = new AbortController(); controller.abort();
    await expect(judgeQuestionSets({ ...context, signal: controller.signal }, [
      { state: { source: 'One' }, questions: { support: noul('Supported?') } },
      { state: { source: 'Two' }, questions: { support: noul('Supported?') } },
    ])).rejects.toMatchObject({ status: 499 });
    expect(requests).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
