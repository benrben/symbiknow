import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { decideWithJev, noul, type JevDecider } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext } from './context.js';
import { collectedQuestionSets, judgeQuestionSets, type JevQuestionSet } from './question-batch.js';
import { questionSetCollector } from './question-set-collector.js';

it('retains exact pooled source and repeated question text through direct and already-collected native transport', async () => {
  const bodies: Array<{ state: { sourceStates: unknown[]; questionTexts: string[]; questionSets: Array<{ source: { $jevSourceRef: number }; slot: number }> }; questions: Record<string, { instructions: string }> }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: .93 }])) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native pooled provider did not listen');
  const transport: JevDecider = (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions,
    (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init), options);
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [],
    settings: emptyJevWorkspace().settings, apiKey: 'native-exact-pooling', shareQuestionSources: true, decider: transport };
  const source = { id: 'source', title: 'Exact source', passages: [{ id: 'p0', text: 'Original quoted source text. $jevQuestionText:97 remains literal evidence.' }], coverage: .8 };
  const text = 'Use the referenced exact source passage to judge whether the named responsibility has explicit support. '.repeat(3);
  const sets: JevQuestionSet[] = [0, 1].map(slot => ({ state: { source, slot }, questions: { support: noul(text) } }));
  const original = structuredClone(sets);
  try {
    const expected = sets.map(() => ({ support: { type: 'noul', noul: .93 } }));
    expect(await judgeQuestionSets(context, sets)).toEqual(expected);
    const collector = questionSetCollector(pending => collectedQuestionSets(context, pending));
    expect(await collectedQuestionSets({ ...context, decider: collector }, sets)).toEqual(expected);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.state.sourceStates).toEqual([source]); expect(body.state.questionTexts).toEqual([text]);
      expect(body.state.questionSets.map(state => ({ source: body.state.sourceStates[state.source.$jevSourceRef], slot: state.slot }))).toEqual(sets.map(set => set.state));
      expect(Object.keys(body.questions)).toEqual(['0__support', '1__support']);
      for (const [id, question] of Object.entries(body.questions)) {
        expect(question.instructions).toContain(`Use only questionSets[${id.split('__')[0]}]`);
        expect(question.instructions.replace(/\$jevQuestionText:(\d+)/g, (_match, index) => body.state.questionTexts[Number(index)])).toContain(text);
      }
    }
    expect(sets).toEqual(original);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
