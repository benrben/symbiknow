import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { filingHeldout } from '../../../scripts/jev-bench/data/filing-heldout.mjs';
import { filingHeldoutContext } from '../../../scripts/jev-bench/filing-heldout-context.mjs';
import { decideWithJev, type ChoiceAnswer, type JevAnswer, type JevQuestion } from '../../jev.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { file } from './profile.js';

type State = { groups?: Array<{ key: string; option: string }>; questionSets?: State[] };
type ProviderBody = { state: State; questions: Record<string, JevQuestion> };
let server: Server;
let origin: string;
let requests: ProviderBody[];
let rawGate: number;
let evidenceAvailable: boolean;
let purposeSupport: number;
const selectedGroup = filingHeldout[0].expectedGroup!;

function picked(question: Extract<JevQuestion, { type: 'choice' }>, key: string, probability = 1): ChoiceAnswer {
  const keys = Object.keys(question.criteria);
  const probabilities = Object.fromEntries(keys.map(candidate => [candidate, candidate === key ? probability : 0]));
  return { type: 'choice', choice: key, confidence: .05, probabilities };
}
function providerAnswer(id: string, question: JevQuestion, body: ProviderBody): JevAnswer {
  const indexed = /^(\d+)__(.+)$/.exec(id);
  const state = indexed ? body.state.questionSets![Number(indexed[1])] : body.state;
  const name = indexed?.[2] ?? id;
  if (question.type === 'noul') return { type: 'noul', noul: name.startsWith('purpose') ? purposeSupport : .01 };
  if (question.type !== 'choice') throw new Error('Unexpected filing fixture score');
  const selected = state.groups?.find(group => group.key === selectedGroup)?.option;
  if (name === 'place' && selected) {
    const answer = picked(question, selected);
    const others = state.groups!.filter(group => group.option !== selected);
    answer.probabilities = { ...answer.probabilities, [selected]: .34,
      ...Object.fromEntries(others.map(group => [group.option, .66 / others.length])) };
    return answer;
  }
  if (name === 'gate' && selected) {
    const answer = picked(question, rawGate > .5 ? selected : 'none');
    answer.probabilities = { ...answer.probabilities, [selected]: rawGate, none: 1 - rawGate };
    return answer;
  }
  const evidence = Object.keys(question.criteria).find(key => /^p\d+$/.test(key));
  if (name === 'evidence' && evidenceAvailable && evidence) return { ...picked(question, evidence), confidence: .99 };
  return { ...picked(question, 'none'), confidence: .99 };
}

beforeEach(async () => {
  requests = []; rawGate = .41; evidenceAvailable = true; purposeSupport = .99;
  server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as ProviderBody; requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, providerAnswer(id, question, body)]));
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Filing fixture did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function context() {
  return filingHeldoutContext(filingHeldout[0], (key, state, questions, _fetcher, options) =>
    decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options));
}
function request() { return { action: 'file' as const, canvasId: filingHeldout[0].id, blockIds: [filingHeldout[0].id] }; }

it('defines independent non-Atlas source cases with explicit group definitions and six other peer outlines', () => {
  expect(filingHeldout.filter(item => item.expectedGroup !== null).length).toBeGreaterThanOrEqual(10);
  expect(new Set(filingHeldout.filter(item => item.expectedGroup !== null).map(item => item.domain)).size).toBeGreaterThanOrEqual(10);
  expect(filingHeldout.filter(item => item.expectedGroup === null).length).toBeGreaterThanOrEqual(4);
  for (const item of filingHeldout) {
    const input = filingHeldoutContext(item, async () => ({}));
    const [source, ...peers] = input.documents;
    expect(source.block.group).toBeUndefined();
    expect(peers).toHaveLength(6);
    expect(peers.every(peer => peer.block.id !== source.block.id && peer.block.group !== undefined)).toBe(true);
    expect(input.canvases[0].groups!.every(group => group.definition!.length > 20)).toBe(true);
  }
});
it('uses the calibrated coverage gate rather than the winning place probability or choice confidence', async () => {
  const input = context(); const before = structuredClone(input.documents);
  const result = await file(input, request());
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', blockId: filingHeldout[0].id, patch: { group: selectedGroup } });
  expect(result.proposals[0].decisionConfidences![0]).toBeCloseTo(calibrated(.41, decisionBoundaries.fileGate));
  expect(requests).toHaveLength(3);
  expect(Object.keys(requests[2].questions)).toEqual(['purpose_0']);
  expect(result.proposals[0].decisionConfidences).toHaveLength(2);
  expect(result.proposals[0].decisionConfidences![1]).toBe(.99);
  expect(requests[0].state.groups).toEqual(expect.arrayContaining([expect.objectContaining({ key: selectedGroup })]));
  expect(input.documents).toEqual(before);
  for (const evidence of result.proposals[0].evidence) expect(input.documents[0].block.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
});
it('rejects a winning existing root when exact evidence does not support its main purpose', async () => {
  purposeSupport = .69; const input = context(); const before = structuredClone(input.documents);
  expect((await file(input, request())).proposals).toEqual([]);
  expect(requests.some(body => Object.keys(body.questions).includes('purpose_0'))).toBe(true);
  expect(input.documents).toEqual(before);
});
it('preserves a current group when the new selected group has no verified source evidence', async () => {
  evidenceAvailable = false; const input = context(); input.documents[0].block.group = filingHeldout[0].groups[1].id;
  const before = structuredClone(input.documents);
  const result = await file(input, request());
  expect(result.proposals).toEqual([]);
  expect(requests.some(body => Object.keys(body.questions).includes('evidence'))).toBe(true);
  expect(input.documents).toEqual(before);
});
it('keeps an already correct current group without unnecessary evidence provider work', async () => {
  const input = context(); input.documents[0].block.group = selectedGroup;
  const before = structuredClone(input.documents);
  expect((await file(input, request())).proposals).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0].questions)).toEqual(['place', 'gate']);
  expect(input.documents).toEqual(before);
});
it('respects a stricter saved slider even when the same group wins the ranking', async () => {
  const input = context(); input.confidenceThreshold = .8;
  const before = structuredClone(input.documents);
  expect((await file(input, request())).proposals).toEqual([]);
  expect(input.documents).toEqual(before);
});
