import { expect, it, vi } from 'vitest';
import type { JevAnswer } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { homeCanvas } from './placement.js';
import { filingDecision, filingQuestionSet } from './filing-selection.js';
import { homeDecision, homeQuestionSet, homeEvidenceQuestionSet } from './home-selection.js';

function document(id: string, canvasId = 'current'): JevInputDocument {
  return { canvasId, snapshot: { workspaceId: 'w', canvasId, blockId: id, incarnation: id, sourceGeneration: 1, metadataRevision: 1, contentHash: id },
    block: { id, title: id, file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 100, height: 100, links: [],
      content: '# Robotics\nRobotics controllers use sensor feedback.\n## Sensors\nA camera measures position.\n<h3>Actuators</h3>\nMotors turn the wheels.' } };
}
function context(): JevEvaluationContext {
  return { workspaceId: 'w', documents: [document('source'), document('peer', 'other')],
    canvases: [{ id: 'current', name: 'Gardening' }, { id: 'other', name: 'Robotics' }], tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings };
}
function answer(probabilities: Record<string, number>): JevAnswer {
  return { type: 'choice', choice: Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0], probabilities, confidence: 0.01 };
}
const group = { key: 'custom:robotics', name: 'Robotics', definition: 'Robot controllers and sensors' };
function answers(gateNone = .1): Record<string, JevAnswer> {
  return { place: answer({ A: .1, B: .8, none: .1 }), gate: answer({ A: .1, B: 1 - gateNone - .1, none: gateNone }), evidence: answer({ p1: 1, none: 0 }) };
}
it('uses HTML and Markdown sections, six member outlines, and omits the source from home examples', () => {
  const input = context();
  input.documents.push(...Array.from({ length: 8 }, (_, index) => document(`peer${index}`, 'other')));
  const source = input.documents[0];
  const set = homeQuestionSet(input, source);
  expect(set.state.source.sections).toEqual(['Sensors', 'Actuators']);
  expect(set.canvases[0].documents).toEqual([]);
  expect(set.canvases[1].documents).toHaveLength(6);
  expect(set.canvases[1].documents[0].sections).toEqual(['Sensors', 'Actuators']);
  expect(Object.keys(set.questions)).toEqual(['place', 'gate', 'evidence']);
});
it('bounds canvas examples to four sections without transferring member bodies', () => {
  const input = context();
  input.documents[1].block.content = `<html><body><script>secret()</script><h1>Robotics</h1><p>${'Robot feedback '.repeat(40)}</p>`
    + Array.from({ length: 9 }, (_, index) => `<h2>Stage ${index}</h2><p>Later detail.</p>`).join('') + '</body></html>';
  const set = homeQuestionSet(input, input.documents[0], false);
  const example = set.canvases[1].documents[0];
  expect(example.sections).toHaveLength(4);
  expect(JSON.stringify(example)).not.toContain('Robot feedback');
  expect(JSON.stringify(example)).not.toContain('secret');
});
it('uses empty filing groups, letter options and bounded exact evidence in the same call', () => {
  const input = context();
  const set = filingQuestionSet(input, input.documents[0], [group]);
  expect(set.state.groups).toEqual([{ ...group, option: 'A', members: [] }]);
  expect(set.questions.place.criteria).toHaveProperty('A');
  expect(set.state.document.sections).toEqual(['Sensors', 'Actuators']);
  expect(set.questions.evidence?.criteria).toHaveProperty('p1');
  expect(filingQuestionSet(input, input.documents[0], [group], false).questions).not.toHaveProperty('evidence');
});
it('calibrates home gate and margin, while low choice confidence does not veto a supported destination', () => {
  const input = context(); const source = input.documents[0];
  const decision = homeDecision(input, source, answers());
  expect(decision?.target.id).toBe('other');
  expect(decision?.confidences.every(value => value >= .7)).toBe(true);
  expect(decision?.evidence[0].quote).toBe('Robotics controllers use sensor feedback.');
  expect(source.block.content.slice(decision!.evidence[0].start, decision!.evidence[0].end)).toBe(decision!.evidence[0].quote);
});
it('stays for rejected gate, current winner, weak margin, missing choices, or raised slider', () => {
  const input = context(); const source = input.documents[0];
  expect(homeDecision(input, source, answers(.7))).toBeUndefined();
  expect(homeDecision(input, source, { ...answers(), place: answer({ A: .8, B: .1, none: .1 }) })).toBeUndefined();
  expect(homeDecision(input, source, { ...answers(), place: answer({ A: .42, B: .58, none: 0 }) })).toBeUndefined();
  expect(homeDecision(input, source, {})).toBeUndefined();
  input.confidenceThreshold = .99;
  expect(homeDecision(input, source, answers())).toBeUndefined();
  expect(homeQuestionSet(input, source, false).questions).not.toHaveProperty('evidence');
});
it('keeps the current home when none leads placement despite an accepted gate and destination margin', () => {
  const input = context(); const source = input.documents[0];
  const values = { ...answers(.69), place: answer({ A: .15, B: .38, none: .47 }) };
  expect(homeDecision(input, source, values)).toBeUndefined();
});
it('keeps the current canvas within sixteen options and refuses a move without the required improvement', () => {
  const input = context(); const source = input.documents[0];
  input.canvases = [...Array.from({ length: 16 }, (_, index) => ({ id: `canvas${index}`, name: `Canvas ${index}` })), input.canvases[0]];
  const options = homeQuestionSet(input, source, false).canvases;
  expect(options).toHaveLength(16);
  expect(options.find(canvas => canvas.current)).toMatchObject({ id: 'current', option: 'P' });
  expect(homeDecision(input, source, { ...answers(), place: answer({ A: .45, P: .4, none: .15 }) })).toBeUndefined();
});
it('refuses a home move when the source current canvas is absent from the authorized context', () => {
  const input = context(); const source = input.documents[0];
  input.canvases = [input.canvases[1], { id: 'third', name: 'Unrelated' }];
  expect(homeDecision(input, source, { ...answers(), place: answer({ A: .8, B: .1, none: .1 }) })).toBeUndefined();
});
it('treats omitted canvas scores as zero without promoting an unscored home', () => {
  const input = context(); const source = input.documents[0];
  input.canvases.push({ id: 'unscored', name: 'Unscored' });
  const decision = homeDecision(input, source, { ...answers(), place: answer({ B: .8, none: .2 }) });
  expect(decision?.target).toMatchObject({ id: 'other', probability: .8 });
  expect(homeDecision(input, source, { ...answers(), place: answer({ none: 1 }) })).toBeUndefined();
});
it.each([
  ['leading none', { A: .15, B: .38, none: .47 }],
  ['none tied with the best canvas', { A: .1, B: .45, none: .45 }],
] as const)('retains the source for %s without requesting exact destination evidence', async (_reason, place) => {
  const input = context(); input.apiKey = 'test-key'; const before = structuredClone(input.documents);
  const decider = vi.fn().mockResolvedValue({ ...answers(.69), place: answer(place) }); input.decider = decider;
  const result = await homeCanvas(input, { action: 'suggest_home_canvas', canvasId: 'current', blockIds: ['source'] });
  expect(decider).toHaveBeenCalledTimes(1);
  expect(Object.keys(decider.mock.calls[0][2])).toEqual(['place', 'gate']);
  expect(result.proposals).toEqual([]);
  expect(result.result.documents).toMatchObject({ source: { status: 'no_change', calibration: 1 } });
  expect(input.documents).toEqual(before);
});
it('filing confidence depends only on calibrated gate, even with diffuse place probabilities', () => {
  const input = context(); const source = input.documents[0];
  const values = { ...answers(.2), place: answer({ A: .35, B: .34, none: .31 }) };
  const decision = filingDecision(input, source, [group, { ...group, key: 'custom:gardening' }], values);
  expect(decision?.group.key).toBe(group.key);
  expect(decision?.confidence).toBeCloseTo(.9);
  expect(decision?.evidence).toHaveLength(1);
  expect(filingDecision(input, source, [group], answers(.6))).toBeUndefined();
  expect(filingDecision(input, source, [], values)).toBeUndefined();
  expect(filingDecision(input, source, [group], {})).toBeUndefined();
  input.confidenceThreshold = .95;
  expect(filingDecision(input, source, [group], values)).toBeUndefined();
});
it('bounds both catalogs to sixteen choices and rejects evidence outside supplied passages', () => {
  const input = context(); const source = input.documents[0];
  input.canvases = Array.from({ length: 18 }, (_, index) => ({ id: String(index), name: String(index) }));
  expect(homeQuestionSet(input, source).canvases).toHaveLength(16);
  expect(filingQuestionSet(input, source, Array.from({ length: 18 }, (_, index) => ({ ...group, key: String(index) }))).state.groups).toHaveLength(16);
  expect(filingDecision(input, source, [group], { ...answers(), place: answer({ A: .8, none: .2 }), evidence: answer({ p99: 1 }) })?.evidence).toEqual([]);
});

it('keeps sixteen bounded source windows aligned between the selected-home evidence schema and exact proof', () => {
  const input = context(); const source = input.documents[0];
  source.block.content = '# Robotics\nOpening sensor overview.\n' + Array.from({ length: 30 }, (_, index) => `## Stage ${index}\nRobot motor feedback at stage ${index}.`).join('\n');
  const selected = homeQuestionSet(input, source, false);
  const checked = homeEvidenceQuestionSet(source, selected.canvases[1]);
  expect(selected.state.source.passages).toHaveLength(8);
  expect(checked.state.source.passages).toHaveLength(16);
  expect(checked.state.selectedCanvas).toMatchObject({ name: 'Robotics', documents: [{ title: 'peer', sections: ['Sensors', 'Actuators'] }] });
  expect(checked.questions.evidence.type).toBe('choice');
  if (checked.questions.evidence.type !== 'choice') throw new Error('Exact home evidence must be a choice');
  const quote = checked.questions.evidence.criteria.p13;
  const decision = homeDecision(input, source, { ...answers(), evidence: answer({ p13: 1, none: 0 }) });
  expect(decision?.evidence[0].quote).toBe(quote);
  expect(source.block.content.slice(decision!.evidence[0].start, decision!.evidence[0].end)).toBe(quote);
  expect(homeDecision(input, source, { ...answers(), evidence: answer({ p99: 1, none: 0 }) })?.evidence).toEqual([]);
});

it('makes no provider call when the source has only one eligible canvas', async () => {
  const input = context(); input.canvases = [input.canvases[0]];
  const decider = vi.fn(); input.decider = decider;
  const result = await homeCanvas(input, { action: 'suggest_home_canvas', canvasId: 'current', blockIds: ['source'] });
  expect(decider).not.toHaveBeenCalled(); expect(result.proposals).toEqual([]);
});

it('checks only the proposed home and preserves the source when no exact passage supports moving', async () => {
  const input = context(); input.apiKey = 'test-key'; input.documents.push(document('current-peer', 'current'));
  const checked = homeEvidenceQuestionSet(input.documents[0], homeQuestionSet(input, input.documents[0], false).canvases[1]);
  const probabilities = Object.fromEntries(Object.keys(checked.questions.evidence.criteria).map(key => [key, key === 'none' ? 1 : 0]));
  const decider = vi.fn().mockResolvedValueOnce(answers()).mockResolvedValueOnce({ evidence: answer(probabilities) });
  input.decider = decider;
  const result = await homeCanvas(input, { action: 'suggest_home_canvas', canvasId: 'current', blockIds: ['source'] });
  expect(decider).toHaveBeenCalledTimes(2);
  expect(decider.mock.calls[1][1]).toMatchObject({
    selectedCanvas: { id: 'other', name: 'Robotics', documents: [{ title: 'peer' }] },
  });
  const checkedState = decider.mock.calls[1][1];
  expect(checkedState).not.toHaveProperty('currentCanvas');
  expect(checkedState.selectedCanvas.documents.map((document: { title: string }) => document.title)).not.toContain('source');
  expect(result.proposals).toEqual([]);
  expect(result.result.documents).toMatchObject({ source: { status: 'no_change', reason: 'No exact source passage supports destination' } });
});
