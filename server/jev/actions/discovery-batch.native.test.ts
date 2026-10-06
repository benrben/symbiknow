import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { decideWithJev, type JevAnswer, type JevCallOptions, type JevQuestion, noul } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import { batchedDiscoveryContext } from './discovery-batch.js';
import { judge, type JevEvaluationContext } from './context.js';
import { judgeQuestionSets } from './question-batch.js';

type State = { source?: { id: string; quote: string }; phase?: string; questionSets?: State[] };
type Body = { state: State; questions: Record<string, JevQuestion> };
let provider: Server; let origin: string; let failed = false;
const requests: Body[] = [];
const questions = { supported: noul('Does the exact supplied source passage support its own stated claim?') };
const alpha = { id: 'alpha', quote: 'Alpha source explicitly supports its claim.' };
const beta = { id: 'beta', quote: 'Beta source does not support its claim.' };

function sourceState(body: Body, id: string): State {
  const batch = /^(\d+)__/.exec(id);
  return batch ? body.state.questionSets![Number(batch[1])] : body.state;
}
beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body; requests.push(body);
    if (failed) { response.statusCode = 503; response.end('Native provider unavailable'); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'native-discovery-rounds', answers: Object.fromEntries(Object.keys(body.questions).map(id =>
      [id, { type: 'noul', noul: sourceState(body, id).source!.id === 'alpha' ? 0.93 : 0.07 }])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native round provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { requests.splice(0); failed = false; });
afterAll(async () => {
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
});
function context(signal?: AbortSignal): JevEvaluationContext {
  return { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [],
    settings: emptyJevWorkspace().settings, apiKey: 'native-round-provider', signal,
    decider: (key, state, submitted, _fetcher, options?: JevCallOptions) => decideWithJev(key, state, submitted,
      (_url, transport) => fetch(origin, transport), options) };
}
async function rounds(batched: JevEvaluationContext): Promise<Array<Record<string, JevAnswer>>> {
  const initial = await Promise.all([judge(batched, { source: alpha, phase: 'initial' }, questions),
    judge(batched, { source: beta, phase: 'initial' }, questions)]);
  expect(initial.map(value => value.supported)).toEqual([{ type: 'noul', noul: 0.93 }, { type: 'noul', noul: 0.07 }]);
  return Promise.all([
    (async () => { await Promise.resolve(); return judge(batched, { source: alpha, phase: 'dependent' }, questions); })(),
    (async () => {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      return (await judgeQuestionSets(batched, [{ state: { source: beta, phase: 'dependent' }, questions }]))[0];
    })(),
  ]);
}

it('shares independent dependent questions across different await depths in one native SDK round', async () => {
  const results = await rounds(batchedDiscoveryContext(context(), setImmediate));
  expect(requests).toHaveLength(2);
  expect(requests.map(body => body.state.questionSets!.map(state => state.phase))).toEqual([
    ['initial', 'initial'], ['dependent', 'dependent'],
  ]);
  expect(results.map(value => value.supported)).toEqual([{ type: 'noul', noul: 0.93 }, { type: 'noul', noul: 0.07 }]);
  expect(requests[1].state.questionSets!.map(state => state.source)).toEqual([alpha, beta]);
});

it('retains ordinary microtask scheduling when no prefetch scheduler is requested', async () => {
  const results = await rounds(batchedDiscoveryContext(context()));
  expect(requests).toHaveLength(3);
  expect(results.map(value => value.supported)).toEqual([{ type: 'noul', noul: 0.93 }, { type: 'noul', noul: 0.07 }]);
});

it('cancels before flush without sending a source to the native provider', async () => {
  const controller = new AbortController(); const batched = batchedDiscoveryContext(context(controller.signal), setImmediate);
  const pending = judge(batched, { source: alpha, phase: 'initial' }, questions);
  controller.abort(); await expect(pending).rejects.toMatchObject({ status: 499 });
  expect(requests).toEqual([]);
});

it('rejects every caller in one failed round and admits a fresh retry without mixing independent source answers', async () => {
  const batched = batchedDiscoveryContext(context(), setImmediate); failed = true;
  const unavailable = await Promise.allSettled([judge(batched, { source: alpha, phase: 'initial' }, questions),
    judge(batched, { source: beta, phase: 'initial' }, questions)]);
  expect(unavailable).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 502, message: expect.stringContaining('503') }) }),
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 502, message: expect.stringContaining('503') }) })]);
  expect(requests).toHaveLength(1); failed = false;
  const retried = await Promise.all([judge(batched, { source: alpha, phase: 'retry' }, questions),
    judge(batched, { source: beta, phase: 'retry' }, questions)]);
  expect(requests).toHaveLength(2);
  expect(retried.map(value => value.supported)).toEqual([{ type: 'noul', noul: 0.93 }, { type: 'noul', noul: 0.07 }]);
});
