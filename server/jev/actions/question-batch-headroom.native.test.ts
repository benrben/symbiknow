import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { decideWithJev, estimateJevTokens, JEV_STATE_TOKEN_LIMIT, noul, type JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext } from './context.js';
import { judgeQuestionSets, type JevQuestionSet } from './question-batch.js';

type Source = { id: number; quote: string };
type Body = { state: Source & { questionSets?: Source[] }; questions: Record<string, JevQuestion> };
function longest(questions: Record<string, JevQuestion>): number {
  return Math.max(...Object.values(questions).map(estimateJevTokens));
}
function sourceFor(body: Body, id: string): Source {
  const match = /^(\d+)__/.exec(id);
  return match ? body.state.questionSets![Number(match[1])] : body.state;
}

it('splits a near-limit automatic bundle before provider overhead rejects it, retaining every full source, exact question and answer', async () => {
  const requests: Body[] = []; let rejected = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body; requests.push(body);
    response.setHeader('content-type', 'application/json');
    // The native provider models prompt/tokenization overhead absent from the local JSON estimate.
    if (estimateJevTokens(body.state) + longest(body.questions) + 4000 > JEV_STATE_TOKEN_LIMIT) {
      rejected += 1; response.statusCode = 400; response.end(JSON.stringify({ detail: 'max tokens exceeded' })); return;
    }
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
      { type: 'noul', noul: .8 + sourceFor(body, id).id / 100 }])) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native headroom provider did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [],
    settings: emptyJevWorkspace().settings, apiKey: 'native-provider-headroom', shareQuestionSources: true,
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
  const sets: JevQuestionSet[] = Array.from({ length: 2 }, (_, id) => ({ state: { id, quote: `Exact source ${id}. ${'Source prose. '.repeat(3370)}` },
    questions: { support: noul(`Does only exact source ${id} support its own stated purpose?`),
      responsibility: noul(`Does only exact source ${id} explicitly name its owner?`) } }));
  const original = structuredClone(sets);
  const combined = estimateJevTokens({ questionSets: sets.map(set => set.state) })
    + longest(Object.fromEntries(sets.flatMap((set, index) => Object.entries(set.questions).map(([id, question]) => [`${index}__${id}`, question]))));
  expect(combined).toBeGreaterThan(31000); expect(combined).toBeLessThan(31800);
  try {
    const answers = await judgeQuestionSets(context, sets);
    expect(rejected).toBe(0); expect(requests).toHaveLength(2);
    expect(answers).toEqual(sets.map((_, id) => ({ support: { type: 'noul', noul: .8 + id / 100 },
      responsibility: { type: 'noul', noul: .8 + id / 100 } })));
    const sources: Source[] = [];
    for (const body of requests) {
      expect(estimateJevTokens(body.state) + longest(body.questions) + 4000).toBeLessThanOrEqual(JEV_STATE_TOKEN_LIMIT);
      expect(body.state.questionSets).toBeUndefined();
      const source = { id: body.state.id, quote: body.state.quote }; sources.push(source);
      expect(body.questions).toEqual(sets[source.id].questions);
    }
    expect(sources.sort((left, right) => left.id - right.id)).toEqual(sets.map(set => set.state));
    expect(sets).toEqual(original);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
