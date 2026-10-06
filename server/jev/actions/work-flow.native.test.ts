import { assignOwner, scoreQuality } from './work.js';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { decideWithJev, estimateJevTokens, type JevAnswer, type JevQuestion } from '../../jev.js';
import { type JevEvaluationContext } from '../actions.js';
import { emptyJevWorkspace } from '../workspace.js';

type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
const dimensions = ['specificity', 'traceability', 'declaredPurposeCompleteness', 'internalConsistency'];
let provider: Server; let origin: string; let calls: Body[];
let numericScore: number; let certainty: number; let selectedPerson: string; let missingEvidence: boolean;
let numericByDimension: Record<string, number>;

function answer(id: string, question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: 0.98 };
  if (question.type === 'score') {
    const score = numericByDimension[id] ?? numericScore;
    return { type: 'score', score, confidence: certainty,
      probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === Math.floor(score) ? 1 : 0])) };
  }
  const level = /Evidence_(\d+)$/.exec(id);
  const evidence = level ? `p${level[1]}` : id === 'evidence_0' ? 'p0' : 'p1';
  const choice = id === 'person' ? selectedPerson : missingEvidence ? 'none' : evidence;
  return { type: 'choice', choice, confidence: id === 'person' ? certainty : 0.1,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) };
}
beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body; calls.push(body); response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(id, question)])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native work-flow provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { calls = []; numericScore = 3; numericByDimension = {}; certainty = 0.98; selectedPerson = 'person1'; missingEvidence = false; });
afterAll(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
function context(): JevEvaluationContext {
  const settings = emptyJevWorkspace().settings;
  settings.people = [{ id: 'maya', name: 'Maya', role: 'Writer' }, { id: 'ben', name: 'Ben', role: 'Release owner' }];
  return { workspaceId: 'workspace', canvases: [{ id: 'canvas', name: 'Atlas' }], vocabulary: [], settings,
    apiKey: 'native-one-wave-work', decider: (key, state, questions, _fetcher, options) =>
      decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options),
    documents: [{ canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source',
      incarnation: 'source-original', sourceGeneration: 1, metadataRevision: 2, contentHash: 'source-exact' },
    block: { id: 'source', title: 'Atlas release', content: 'Maya wrote this guide.\nBen owns and reviews the Atlas release.\nThe release purpose is partly documented.\nThe exact release requirements are completely documented.',
      file: 'source.md', kind: 'markdown', x: 15, y: 25, width: 400, height: 300, links: [] } }],
    tasks: [{ canvasId: 'canvas', task: { id: 'task', title: 'Atlas release', detail: 'Carry out the Atlas release.',
      status: 'todo', revision: 4, blockIds: [], comments: [], createdBy: 'Browser', updatedBy: 'Browser',
      createdAt: '2026-10-01', updatedAt: '2026-10-02' } }] };
}
const request = (action: 'assign_owner' | 'score_quality') => ({ action, canvasId: 'canvas', blockIds: ['source'] });

it('uses one real SDK request to choose a responsible person and their own exact evidence', async () => {
  const input = context(); const before = structuredClone({ documents: input.documents, tasks: input.tasks });
  const result = await assignOwner(input, request('assign_owner'));
  expect(calls).toHaveLength(1); expect(Object.keys(calls[0].questions)).toEqual(['person', 'evidence_0', 'evidence_1']);
  expect(calls[0].state).toMatchObject({ people: input.settings.people, assignment: { field: 'assignee', responsibility: 'ownership' } });
  expect(calls[0].questions.evidence_1.instructions).toContain('people[1]');
  expect(result.proposals[0].mutation).toMatchObject({ taskId: 'task', expectedRevision: 4, expectedUpdatedAt: '2026-10-02', patch: { assignee: 'ben' } });
  expect(result.proposals[0].evidence[0].quote).toBe('Ben owns and reviews the Atlas release.');
  expect({ documents: input.documents, tasks: input.tasks }).toEqual(before);
});

it.each([0, 1, 2, 3])('covers numeric quality level %s and all four dimensions in one real SDK request', async level => {
  numericScore = level; const input = context(); const result = await scoreQuality(input, request('score_quality'));
  expect(calls).toHaveLength(1); expect(Object.keys(calls[0].questions)).toHaveLength(20);
  for (const dimension of dimensions) {
    expect(calls[0].questions[`${dimension}Evidence_${level}`].instructions).toContain(`numeric level ${level}`);
    expect(result.result.documents).toMatchObject({ source: { rubric: { [dimension]: { score: level, confidence: 0.98 } }, advisory: true } });
  }
  expect(result.proposals[0].evidence.map(passage => passage.quote)).toEqual(Array(4).fill(input.documents[0].block.content.split('\n')[level]));
  for (const passage of result.proposals[0].evidence) expect(input.documents[0].block.content.slice(passage.start, passage.end)).toBe(passage.quote);
});

it('asks dependent evidence only for fractional dimensions while keeping integer evidence bound to its original level', async () => {
  numericByDimension = { specificity: 1.5, traceability: 2, declaredPurposeCompleteness: 0.5, internalConsistency: 3 };
  const input = context(); const result = await scoreQuality(input, request('score_quality'));
  expect(calls).toHaveLength(2); expect(Object.keys(calls[1].questions)).toEqual(['specificityEvidence', 'declaredPurposeCompletenessEvidence']);
  expect(Object.keys(calls[1].state.assessments as Record<string, unknown>)).toEqual(['specificity', 'declaredPurposeCompleteness']);
  expect(result.result.documents).toMatchObject({ source: { rubric: { specificity: { score: 1.5 }, traceability: { score: 2 },
    declaredPurposeCompleteness: { score: 0.5 }, internalConsistency: { score: 3 } } } });
  expect(result.proposals[0].evidence.map(passage => passage.quote)).toEqual([1, 2, 1, 3].map(index => input.documents[0].block.content.split('\n')[index]));
});

it('preserves fractional quality scores through a dependent exact-evidence request rather than rounding to another numeric level', async () => {
  numericScore = 2.5; const result = await scoreQuality(context(), request('score_quality'));
  expect(calls).toHaveLength(2); expect(Object.keys(calls[1].questions)).toEqual(dimensions.map(dimension => `${dimension}Evidence`));
  expect(calls[1].state.assessments).toMatchObject({ specificity: { score: 2.5 } });
  expect(result.result.documents).toMatchObject({ source: { rubric: { specificity: { score: 2.5 } } } });
});

it('retains uncertain quality and missing evidence instead of authorizing a composite score', async () => {
  certainty = 0.4; const result = await scoreQuality(context(), request('score_quality'));
  expect(result.result.documents).toMatchObject({ source: { advisory: true, rubric: { specificity: { score: 3, confidence: 0.4, status: 'uncertain' } } } });
  missingEvidence = true; const absent = await scoreQuality(context(), request('score_quality'));
  expect(absent.result.documents).toMatchObject({ source: { rubric: { specificity: { status: 'insufficient_evidence' } } } });
  expect(absent.proposals[0].evidence).toEqual([]); expect(absent.proposals[0].mutation.kind).toBe('derived');
});

it('requires both a strict responsible-person decision and that exact person’s quote', async () => {
  certainty = 0.4; expect((await assignOwner(context(), request('assign_owner'))).proposals).toEqual([]);
  certainty = 0.98; missingEvidence = true; expect((await assignOwner(context(), request('assign_owner'))).proposals).toEqual([]);
  missingEvidence = false; selectedPerson = 'none'; expect((await assignOwner(context(), request('assign_owner'))).proposals).toEqual([]);
});

it('bounds twenty-four known people and eight full source passages without repeating their bodies in every evidence criterion', async () => {
  const input = context(); input.settings.people = Array.from({ length: 25 }, (_, index) => ({ id: `person-${index}`, name: `Person ${index}`, role: 'Release owner' }));
  input.documents[0].block.content = Array.from({ length: 8 }, (_, index) => `Passage ${index}: ${'Exact release responsibility evidence. '.repeat(14)}`).join('\n');
  selectedPerson = 'person23'; const result = await assignOwner(input, request('assign_owner'));
  expect(calls).toHaveLength(1); expect(Object.keys(calls[0].questions)).toHaveLength(25);
  expect(JSON.stringify(calls)).not.toContain('Person 24'); expect(calls[0].questions.evidence_23.instructions).toContain('people[23]');
  expect(estimateJevTokens(calls[0].state) + estimateJevTokens(calls[0].questions)).toBeLessThanOrEqual(16000);
  expect(JSON.stringify(calls[0].questions.evidence_23)).not.toContain('Exact release responsibility evidence.');
  expect(result.proposals[0].mutation).toMatchObject({ patch: { assignee: 'person-23' } });
});
