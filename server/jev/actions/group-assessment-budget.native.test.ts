import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { decideWithJev, estimateJevTokens, JEV_STATE_TOKEN_LIMIT, type JevAnswer, type JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingPassages, filingState } from './group-passages.js';
import { bootstrapGrouping } from './grouping.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
function source(id: string, title: string, content: string): JevInputDocument {
  return { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id,
    incarnation: id, sourceGeneration: 1, metadataRevision: 0, contentHash: id },
  block: { id, title, kind: 'markdown', file: `${id}.md`, x: 3, y: 5, width: 400, height: 300, links: [], content } };
}
function answer(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .98 };
  if (question.type !== 'choice') throw new Error('Unexpected grouping question');
  const keys = Object.keys(question.criteria);
  const selected = keys.find(key => question.criteria[key].endsWith('(custom:engineering)')) ?? (keys.includes('p1') ? 'p1' : keys[0]);
  return { type: 'choice', choice: selected, confidence: .98,
    probabilities: Object.fromEntries(keys.map(key => [key, Number(key === selected)])) };
}

it('keeps 24 candidate evidence selections and the selected semantic assessment within two bounded native requests', async () => {
  const calls: Body[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const piece of request) raw += piece;
    const wire = JSON.parse(raw) as Body;
    expect(estimateJevTokens(wire.state) + Math.max(...Object.values(wire.questions).map(estimateJevTokens)) + 4200)
      .toBeLessThanOrEqual(JEV_STATE_TOKEN_LIMIT);
    const body = { state: resolveSharedQuestionSources(wire.state, wire.state.sourceStates),
      questions: resolveSharedQuestionTexts(wire.questions, wire.state.questionTexts) };
    calls.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(question)])) }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native provider did not listen');
  const content = '# Engineering\n' + Array.from({ length: 8 }, (_, index) =>
    `Engineering scope ${index}: ${'Checked service contracts and deployment evidence. '.repeat(11)}`).join('\n');
  const member = source('member', 'Engineering', content);
  const documents = [member, ...Array.from({ length: 24 }, (_, index) =>
    source(`topic-${index}`, `Topic ${index}`, `# Topic ${index}\nTopic ${index} describes its distinct substantive purpose.`))];
  // Explicit links keep the full candidate-pressure fixture relevant after unrelated title pruning.
  member.block.links = documents.slice(1).map(document => document.block.id);
  const vocabulary = Array.from({ length: 6 }, (_, index) => ({ id: `term-${index}`, kind: 'group' as const,
    name: `Existing ${index}`, groupKey: `custom:existing-${index}`, definition: 'Existing category scope. '.repeat(16),
    state: 'active' as const, aliases: [], members: [], version: 1 }));
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents, vocabulary, tasks: [],
    canvases: [{ id: 'canvas', name: 'Engineering' }], settings: emptyJevWorkspace().settings,
    apiKey: 'native-selected-evidence-budget', selectiveGroupAssessment: true, shareQuestionSources: true,
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions,
      (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init), options) };
  try {
    const result = await bootstrapGrouping(context, { action: 'file', canvasId: member.canvasId, blockIds: [member.block.id] }, member);
    expect(result.result.status).toBe('proposed_grouping');
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].questions)).toHaveLength(25);
    const sets = calls[0].state.questionSets as Array<Record<string, unknown>>;
    for (const set of sets.slice(1)) {
      expect(set.source).toEqual(filingState(member));
      expect(set.selectedGroup).toBeDefined();
      expect(set).not.toHaveProperty('localEvidence');
      expect(set).not.toHaveProperty('existingDefinitions');
    }
    expect(calls[1].state.localEvidence).toEqual(filingPassages(member).map(({ quote, start, end }) => ({ quote, start, end })));
    expect(calls[1].state.existingDefinitions).toHaveLength(6);
    expect(Object.keys(calls[1].questions)).toEqual(['coherent', 'purpose_1']);
    const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document')!;
    expect(membership.evidence).toEqual([filingPassages(member)[1]]);
    expect(membership.decisionConfidences).toEqual([.98, .98, .98]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
