import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { decideWithJev, estimateJevTokens, noul, type JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext } from './context.js';
import { judgeQuestionSets, type JevQuestionSet } from './question-batch.js';

it('recovers a trusted token rejection by splitting automatic sets without losing source text or questions', async () => {
  const requests: Array<{ state: Record<string, unknown>; questions: Record<string, JevQuestion> }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push({ state: body.state, questions: body.questions });
    response.setHeader('content-type', 'application/json');
    if (estimateJevTokens(body.state) > 25000) {
      response.statusCode = 400; response.end(JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } })); return;
    }
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: .9 }])) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native provider did not listen');
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [],
    settings: emptyJevWorkspace().settings, apiKey: 'native-context-recovery', shareQuestionSources: true,
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions,
      (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init), options) };
  const sets: JevQuestionSet[] = [0, 1].map(id => ({ state: { id, quote: `Exact source ${id}. ${'Source prose. '.repeat(2800)}` },
    questions: { support: noul(`Does exact source ${id} support its own stated purpose?`), owner: noul(`Does exact source ${id} name an owner?`) } }));
  const original = structuredClone(sets);
  try {
    expect(await judgeQuestionSets(context, sets)).toEqual(sets.map(() => ({ support: { type: 'noul', noul: .9 }, owner: { type: 'noul', noul: .9 } })));
    expect(requests).toHaveLength(3);
    expect(estimateJevTokens(requests[0].state)).toBeGreaterThan(25000);
    expect(requests.slice(1).map(body => ({ state: { id: body.state.id, quote: body.state.quote }, questions: body.questions }))).toEqual(sets);
    expect(sets).toEqual(original);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
