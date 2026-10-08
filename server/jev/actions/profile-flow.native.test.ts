import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { decideWithJev, type JevQuestion } from '../../jev.js';
import { evaluateJevAction, type JevEvaluationContext } from '../actions.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { emptyJevWorkspace } from '../workspace.js';

let server: Server;
let origin: string;
let requests: Array<{ state: Record<string, unknown>; questions: Record<string, JevQuestion> }>;
let unsupportedKey: string | undefined;
let homeAnswers: { place: Record<string, number>; gate: Record<string, number> } | undefined;
beforeEach(async () => {
  requests = []; unsupportedKey = undefined; homeAnswers = undefined;
  server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw); requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, JevQuestion>).map(([id, question]) => {
      const indexed = /^(\d+)__(.+)$/.exec(id);
      const state = indexed ? body.state.questionSets[Number(indexed[1])] : body.state;
      const name = indexed ? indexed[2] : id;
      if (question.type === 'noul') return [id, { type: 'noul', noul: name.startsWith('purpose_')
        && state.selectedGroup.key === unsupportedKey ? .01 : .98 }];
      if (question.type !== 'choice') throw new Error('Unexpected filing score');
      if (homeAnswers && ['place', 'gate'].includes(name) && state.canvases) {
        const probabilities = homeAnswers[name as 'place' | 'gate'];
        const selected = Object.keys(probabilities).sort((left, right) => probabilities[right] - probabilities[left])[0];
        return [id, { type: 'choice', choice: selected, confidence: .1, probabilities }];
      }
      const keys = Object.keys(question.criteria);
      const groups = state.groups as Array<{ option: string; key: string }> | undefined;
      const choice = ['place', 'gate'].includes(name) ? groups?.find(group => group.key !== unsupportedKey)?.option ?? 'none'
        : keys.find(key => question.criteria[key].includes('Platform infrastructure and deployment requirements.')) ?? keys[0];
      return [id, { type: 'choice', choice, confidence: .98,
        probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
    }));
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native filing provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function context(): JevEvaluationContext {
  const source = { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source',
    incarnation: 'original', sourceGeneration: 1, metadataRevision: 0, contentHash: 'exact-source' },
    block: { id: 'source', title: 'Architecture', file: 'source.md', kind: 'markdown' as const, x: 123, y: 456,
      width: 400, height: 300, links: [], content: '# Architecture\nPlatform infrastructure and deployment requirements.' } };
  return { workspaceId: 'workspace', documents: [source], vocabulary: [], tasks: [],
    canvases: [{ id: 'canvas', name: 'Platform', groups: [{ id: 'custom:platform', name: 'Platform', definition: 'Platform infrastructure' }] }],
    settings: emptyJevWorkspace().settings, apiKey: 'native-filing-flow',
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
}
it('selects an existing group in one decision wave and then checks only its exact local evidence', async () => {
  const input = context(); const source = input.documents[0]; const before = structuredClone(source);
  const result = await evaluateJevAction(input, { action: 'file', canvasId: 'canvas', blockIds: ['source'] });
  expect(requests).toHaveLength(3);
  expect(Object.keys(requests[0].questions)).toEqual(['place', 'gate']);
  expect(Object.keys(requests[1].questions)).toEqual(['evidence']);
  expect(Object.keys(requests[2].questions)).toEqual(['purpose_1']);
  expect(requests[2].state.localEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ quote: 'Platform infrastructure and deployment requirements.' })]));
  expect(requests[0].state).toMatchObject({ document: { sections: [] }, groups: [expect.objectContaining({ key: 'custom:platform' })] });
  expect(requests[1].state).toMatchObject({ selectedGroup: { key: 'custom:platform' } });
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', blockId: 'source', patch: { group: 'custom:platform' } });
  expect(result.proposals[0].decisionConfidences).toEqual([1, .98]);
  expect(result.proposals[0].sources).toEqual([source.snapshot]);
  for (const passage of result.proposals[0].evidence) expect(source.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  expect(source).toEqual(before);
});
it('checks only the chosen group after rejecting an unrelated supplied group in the selection wave', async () => {
  const input = context(); unsupportedKey = 'custom:platform';
  input.canvases[0].groups!.push({ id: 'custom:deployment', name: 'Deployment', definition: 'Deployment requirements' });
  const result = await evaluateJevAction(input, { action: 'file', canvasId: 'canvas', blockIds: ['source'] });
  expect(requests).toHaveLength(3);
  expect(Object.keys(requests[0].questions)).toEqual(['place', 'gate']);
  expect(requests[0].state.groups).toEqual(expect.arrayContaining([expect.objectContaining({ key: unsupportedKey }), expect.objectContaining({ key: 'custom:deployment' })]));
  expect(Object.keys(requests[1].questions)).toEqual(['evidence']);
  expect(Object.keys(requests[2].questions)).toEqual(['purpose_1']);
  expect(requests[2].state.selectedGroup).toMatchObject({ key: 'custom:deployment' });
  expect(requests[1].state).toMatchObject({ selectedGroup: { key: 'custom:deployment' } });
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { group: 'custom:deployment' } });
  expect(result.proposals[0].decisionConfidences).toEqual([1, .98]);
  expect(result.proposals[0].sources).toEqual([input.documents[0].snapshot]);
});

function homeContext() {
  const input = context();
  input.canvases.push({ id: 'destination', name: 'Infrastructure reference' });
  return input;
}
it.each([
  ['current home', { A: .8, B: .1, none: .1 }, { A: .9, B: 0, none: .1 }],
  ['none gate', { A: .1, B: .8, none: .1 }, { A: 0, B: .25, none: .75 }],
  ['insufficient improvement', { A: .4, B: .5, none: .1 }, { A: 0, B: .9, none: .1 }],
  ['leading none', { A: .15, B: .38, none: .47 }, { A: .1, B: .21, none: .69 }],
  ['none tied with best canvas', { A: .1, B: .45, none: .45 }, { A: .1, B: .21, none: .69 }],
] as const)('keeps a home unchanged for %s without asking a destination evidence question', async (_reason, place, gate) => {
  homeAnswers = { place, gate }; const input = homeContext(); const before = structuredClone(input.documents);
  const result = await evaluateJevAction(input, { action: 'suggest_home_canvas', canvasId: 'canvas', blockIds: ['source'] });
  expect(result.proposals).toEqual([]); expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0].questions)).toEqual(['place', 'gate']);
  expect(input.documents).toEqual(before);
});
it('checks only a selected home’s exact evidence and carries calibrated gate and margin confidences', async () => {
  homeAnswers = { place: { A: .2, B: .7, none: .1 }, gate: { A: 0, B: .5, none: .5 } };
  const input = homeContext(); const source = input.documents[0];
  const result = await evaluateJevAction(input, { action: 'suggest_home_canvas', canvasId: 'canvas', blockIds: ['source'] });
  expect(requests).toHaveLength(2);
  expect(Object.keys(requests[0].questions)).toEqual(['place', 'gate']);
  expect(Object.keys(requests[1].questions)).toEqual(['evidence']);
  expect(requests[1].state).toMatchObject({ selectedCanvas: { id: 'destination', name: 'Infrastructure reference' } });
  const proposal = result.proposals[0];
  expect(proposal.mutation).toMatchObject({ kind: 'move', canvasId: 'canvas', blockId: 'source', targetCanvasId: 'destination' });
  expect(proposal.decisionConfidences).toHaveLength(2);
  expect(proposal.decisionConfidences![0]).toBeCloseTo(calibrated(.5, decisionBoundaries.homeGate));
  expect(proposal.decisionConfidences![1]).toBeCloseTo(calibrated(.5, decisionBoundaries.homeMargin));
  expect(proposal.sources).toEqual([source.snapshot]);
  for (const evidence of proposal.evidence) expect(source.block.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
});
