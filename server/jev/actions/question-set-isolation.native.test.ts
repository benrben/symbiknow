import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { choice, decideWithJev, noul, type JevAnswer, type JevQuestion } from '../../jev.js';
import { cachedQuestionContext } from '../runtime-question-prefetch.js';
import { emptyJevWorkspace } from '../workspace.js';
import { judge, type JevEvaluationContext } from './context.js';
import { batchedDiscoveryContext } from './discovery-batch.js';
import { QuestionAnswerCache } from './question-answer-cache.js';
import { judgeQuestionSets } from './question-batch.js';

type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
type Native = { server: Server; context: JevEvaluationContext; calls: Body[]; failure: string };
const fixtures: Native[] = [];
const primary = { state: { source: 'Profile source', exact: 'The document defines Atlas release requirements.' },
  questions: { support: noul('Does this exact source state Atlas release requirements?') } };
const optional = { state: { source: 'Optional source', exact: 'The document names no matching group.' },
  questions: { group: choice('Choose only a group supported by this exact source.', { match: 'Matching group', no_match: 'No supported group' }) } };
const primaryAnswers = { support: { type: 'noul', noul: .92 } };

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.server.closeAllConnections(); await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});

function semanticFailure(kind: string): JevAnswer {
  const probabilities: Record<string, number> = kind === 'sum' ? { match: .3, no_match: .3 }
    : kind === 'extra' ? { match: .4, no_match: .3, extra: .3 } : { match: .1, no_match: .9 };
  return { type: 'choice', choice: 'match', confidence: .99, probabilities };
}
function validAnswer(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .92 };
  if (question.type !== 'choice') throw new Error('Unexpected native isolation score');
  return { type: 'choice', choice: 'no_match', confidence: .99, probabilities: { match: .01, no_match: .99 } };
}
async function native(failure = 'leading'): Promise<Native> {
  const fixture = { calls: [], failure } as unknown as Native;
  fixture.server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body; fixture.calls.push(body);
    if (fixture.failure === 'network') { response.statusCode = 503; response.end('Native provider unavailable'); return; }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      if (id.endsWith('group') && fixture.failure !== 'none') {
        return [id, fixture.failure === 'malformed' ? { type: 'noul', noul: .92 } : semanticFailure(fixture.failure)];
      }
      return [id, validAnswer(question)];
    }));
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const address = fixture.server.address(); if (!address || typeof address === 'string') throw new Error('Native isolation provider did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  fixture.context = { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings,
    shareQuestionSources: true, apiKey: 'native-isolated-question-sets', decider: (key, state, questions, _fetcher, options) =>
      decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
  fixtures.push(fixture); return fixture;
}
function collected(context: JevEvaluationContext) {
  return cachedQuestionContext(batchedDiscoveryContext(context, setImmediate), new QuestionAnswerCache(), 'native-isolation-partition');
}
function independent(context: JevEvaluationContext) {
  return Promise.allSettled([judge(context, primary.state, primary.questions),
    judgeQuestionSets(context, [optional]).then(answers => answers[0])]);
}

it.each([
  ['leading', 'Jev selected a non-leading choice'],
  ['sum', 'Jev probabilities do not sum to one'],
  ['extra', 'Jev returned an invalid probability distribution'],
])('isolates a complete optional %s set, caches only the valid original set and genuinely retries the rejected set', async (kind, message) => {
  const fixture = await native(kind); const context = collected(fixture.context);
  const before = structuredClone([primary, optional]);
  const results = await independent(context);
  expect(fixture.calls).toHaveLength(1);
  expect(Object.keys(fixture.calls[0].questions)).toEqual(['0__support', '1__group']);
  expect(results).toEqual([{ status: 'fulfilled', value: primaryAnswers },
    { status: 'rejected', reason: expect.objectContaining({ status: 502, message }) }]);
  expect(await judge(context, primary.state, primary.questions)).toEqual(primaryAnswers);
  expect(fixture.calls).toHaveLength(1);
  await expect(judge(context, optional.state, optional.questions)).rejects.toMatchObject({ status: 502, message });
  expect(fixture.calls).toHaveLength(2);
  fixture.failure = 'none';
  expect(await judge(context, optional.state, optional.questions)).toEqual({ group: validAnswer(optional.questions.group) });
  expect(fixture.calls).toHaveLength(3);
  expect(await judge(context, optional.state, optional.questions)).toEqual({ group: validAnswer(optional.questions.group) });
  expect(fixture.calls).toHaveLength(3); expect([primary, optional]).toEqual(before);
});

it('keeps the public independent batch all-or-nothing for the same non-leading optional choice', async () => {
  const fixture = await native();
  await expect(judgeQuestionSets(fixture.context, [primary, optional])).rejects.toMatchObject({ status: 502, message: 'Jev selected a non-leading choice' });
  expect(fixture.calls).toHaveLength(1);
});

it('passes original sets through nested collectors without pooling already compiled source references or poisoning the primary', async () => {
  const fixture = await native();
  const context = batchedDiscoveryContext(collected(fixture.context), setImmediate);
  const result = await independent(context);
  expect(result).toEqual([{ status: 'fulfilled', value: primaryAnswers },
    { status: 'rejected', reason: expect.objectContaining({ status: 502, message: 'Jev selected a non-leading choice' }) }]);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0].state.questionSets).toEqual([
    expect.objectContaining(primary.state), expect.objectContaining(optional.state),
  ]);
  expect(await judge(context, primary.state, primary.questions)).toEqual(primaryAnswers);
  expect(fixture.calls).toHaveLength(1);
});

it('preserves public whole-call rejection and exact valid reuse when a cache wrapper retains only its original transport', async () => {
  const fixture = await native(); const cache = new QuestionAnswerCache();
  const context = { ...fixture.context, wrapDecider: (transport: NonNullable<JevEvaluationContext['decider']>) => cache.decider('original-transport', transport) };
  await expect(judgeQuestionSets(context, [primary, optional])).rejects.toMatchObject({ status: 502, message: 'Jev selected a non-leading choice' });
  expect(fixture.calls).toHaveLength(1);
  expect(await judgeQuestionSets(context, [primary])).toEqual([primaryAnswers]);
  expect(fixture.calls).toHaveLength(1);
  await expect(judgeQuestionSets(context, [optional])).rejects.toMatchObject({ status: 502, message: 'Jev selected a non-leading choice' });
  expect(fixture.calls).toHaveLength(2);
});

it.each(['network', 'malformed'])('rejects every collected set for a native %s failure and never caches its valid-looking sibling', async kind => {
  const fixture = await native(kind); const context = collected(fixture.context);
  const original = structuredClone([primary, optional]);
  const results = await independent(context);
  expect(results).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 502 }) }),
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 502 }) })]);
  const reasons = results.map(result => result.status === 'rejected' ? result.reason : undefined);
  expect(reasons[0]).toBe(reasons[1]);
  expect(Object.keys(fixture.calls[0].questions)).toEqual(['0__support', '1__group']);
  expect(fixture.calls[0].state.questionSets).toEqual([
    expect.objectContaining(primary.state), expect.objectContaining(optional.state),
  ]);
  expect(fixture.calls).toHaveLength(1); fixture.failure = 'none';
  const recovered = [{ status: 'fulfilled', value: primaryAnswers },
    { status: 'fulfilled', value: { group: validAnswer(optional.questions.group) } }];
  expect(await independent(context)).toEqual(recovered);
  expect(fixture.calls).toHaveLength(2);
  expect(await independent(context)).toEqual(recovered);
  expect(fixture.calls).toHaveLength(2); expect([primary, optional]).toEqual(original);
});

it('rejects every set cancelled before the collected wave without sending or caching provider answers', async () => {
  const fixture = await native('none'); const controller = new AbortController();
  const context = collected({ ...fixture.context, signal: controller.signal });
  const pending = independent(context); controller.abort();
  expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 499 }) }),
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 499 }) })]);
  expect(fixture.calls).toEqual([]);
});
