import { expect, it, vi } from 'vitest';
import { jevActions } from '../../../shared/jev-types.js';
import type { JevAnswer, JevDecider, JevQuestion } from '../../jev.js';
import { evaluateJevAction, type JevEvaluationContext, type JevInputDocument } from '../actions.js';
import { automaticLinkSet, automaticLinkAssessment, type Pair } from './graph.js';

function document(id: string, title: string, content: string): JevInputDocument {
  return { canvasId: 'canvas', block: { id, title, content, file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] },
    snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id, incarnation: `inc-${id}`, sourceGeneration: 1, metadataRevision: 1, contentHash: id } };
}
const source = document('client', 'Request client', '# Request client\n\nApplication sends authenticated requests to service.\n\n## Retries\n\nRetry failed requests.');
const target = document('service', 'Request service', '# Request service\n\nService verifies authentication before accepting requests.\n\n## Limits\n\nRequests have a bounded size.');
const pair: Pair = { source, target, hypothesis: 'useful directional context' };
function answers(support = .7, relation = 'related', sourcePick = 'p1', targetPick = 'p1'): Record<string, JevAnswer> {
  const q = automaticLinkSet(pair).questions;
  const evidence = (question: Extract<JevQuestion, { type: 'choice' }>, pick: string): JevAnswer => ({
    type: 'choice', choice: pick, confidence: .1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === pick)])),
  });
  return { supported: { type: 'noul', noul: support }, sourceEvidence: evidence(q.sourceEvidence, sourcePick), targetEvidence: evidence(q.targetEvidence, targetPick),
    relation: { type: 'choice', choice: relation, confidence: .1, probabilities: Object.fromEntries(Object.keys(q.relation.criteria).map(key => [key, .2])) } };
}
function context(decider: JevDecider): JevEvaluationContext {
  return { workspaceId: 'workspace', documents: [source, target], canvases: [{ id: 'canvas', name: 'Requests' }], tasks: [], vocabulary: [],
    retrievedNeighbors: { 'canvas:client': ['canvas:service'] }, apiKey: 'unit-boundary', decider,
    settings: { paused: false, externalProcessing: true, people: [], schedules: [],
      modes: Object.fromEntries(jevActions.map(action => [action, 'auto'])) as JevEvaluationContext['settings']['modes'] } };
}
const input = { confidenceThreshold: .7 } as JevEvaluationContext;

it('asks four atomic automatic-link questions with outlines and no usefulness score', () => {
  const set = automaticLinkSet(pair);
  expect(Object.keys(set.questions)).toEqual(['supported', 'sourceEvidence', 'targetEvidence', 'relation']);
  expect(Object.keys(set.questions.relation.criteria)).toEqual(['prerequisite', 'implements', 'example_of', 'related', 'none']);
  expect(set.state.source).toMatchObject({ title: 'Request client', sections: ['Retries'] });
  expect(set.state.target).toMatchObject({ title: 'Request service', sections: ['Limits'] });
  expect(set.questions.supported.instructions).toContain('useful context');
});

it.each([[.69, false], [.7, true]])('keeps the support slider boundary at %s', (raw, eligible) => {
  const assessment = automaticLinkAssessment(input, pair, answers(raw));
  expect(assessment.eligible).toBe(eligible);
  expect(assessment.confidence).toBe(raw);
  expect(assessment.usefulness).toBe(2);
});

it('uses relationship as a label while retaining exact body evidence and rejecting none or unknown relations', () => {
  expect(automaticLinkAssessment(input, pair, answers(.9, 'implements')).relation).toBe('implements');
  expect(automaticLinkAssessment(input, pair, answers(.9, 'implements')).eligible).toBe(true);
  for (const relation of ['none', 'unknown', 'same_topic', 'contradicts']) expect(automaticLinkAssessment(input, pair, answers(.9, relation)).eligible).toBe(false);
  expect(automaticLinkAssessment(input, pair, answers(.9, 'related', 'none')).eligible).toBe(false);
  expect(automaticLinkAssessment(input, pair, answers(.9, 'related', 'p1', 'unknown')).eligible).toBe(false);
  expect(automaticLinkAssessment(input, pair, {}).eligible).toBe(false);
  for (const item of automaticLinkAssessment(input, pair, answers()).evidence) {
    const document = [source, target].find(document => document.block.id === item.source.blockId)!;
    expect(document.block.content.slice(item.start, item.end)).toBe(item.quote);
  }
});

it('creates one automatic source patch with low-confidence relation labels from one evaluator call', async () => {
  const decider = vi.fn<JevDecider>(async () => answers(.9, 'implements'));
  const state = context(decider); const before = structuredClone(state.documents);
  const result = await evaluateJevAction(state, { action: 'link', canvasId: 'canvas', blockIds: ['client'] });
  expect(decider).toHaveBeenCalledTimes(1);
  expect(result.result.edges).toMatchObject([{ targetId: 'service', relation: 'implements', confidence: .9, usefulness: 2 }]);
  expect(result.proposals[0]).toMatchObject({ decisionConfidences: [.9], mutation: { kind: 'document', patch: { links: ['service'], linkTypes: { service: 'implements' } } } });
  expect(state.documents).toEqual(before);
});

it('retains the explicit-relation verification question program and usefulness guard', async () => {
  const programs: Array<Record<string, JevQuestion>> = [];
  const decider: JevDecider = async (_key, _state, questions) => {
    programs.push(questions);
    return { supported: { type: 'noul', noul: .9 }, sourceEvidence: answers().sourceEvidence, targetEvidence: answers().targetEvidence,
      usefulness: { type: 'score', score: 2, confidence: 1, probabilities: { '0': 0, '1': 0, '2': 1 } } };
  };
  const result = await evaluateJevAction(context(decider), { action: 'link', canvasId: 'canvas', blockIds: ['client'], options: { relation: 'prerequisite' } });
  expect(Object.keys(programs[0])).toEqual(['supported', 'sourceEvidence', 'targetEvidence', 'usefulness']);
  expect(programs[0].supported.instructions).toBe('Do source and target provide explicit evidence for hypothesis, including its direction, time, and scope?');
  expect(result.result.edges).toMatchObject([{ relation: 'prerequisite', usefulness: 2 }]);
});
