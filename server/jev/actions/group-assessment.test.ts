import { expect, it } from 'vitest';
import type { JevAnswer } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { groupAssessmentDecision, groupAssessmentSet, semanticGroupState } from './group-assessment.js';
import { filingPassages } from './group-passages.js';

function document(): JevInputDocument {
  return { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source',
    incarnation: 'original', sourceGeneration: 1, metadataRevision: 0, contentHash: 'exact-source' },
  block: { id: 'source', title: 'Platform', kind: 'markdown', file: 'source.md', x: 1, y: 2,
    width: 400, height: 300, links: [], content: '# Platform\nThe platform manages deployment.\nExact subgroup containment.' } };
}
function context(): JevEvaluationContext {
  return { workspaceId: 'workspace', documents: [document()], vocabulary: [], tasks: [], canvases: [],
    settings: emptyJevWorkspace().settings, confidenceThreshold: .7 };
}
function choice(id = 'p1'): JevAnswer {
  return { type: 'choice', choice: id, confidence: .98, probabilities: { [id]: 1 } };
}
function answers(): Record<string, JevAnswer> {
  return { evidence: choice(), coherent: { type: 'noul', noul: .91 },
    purpose_0: { type: 'noul', noul: .01 }, purpose_1: { type: 'noul', noul: .92 },
    containment_0: { type: 'noul', noul: .01 }, containment_1: { type: 'noul', noul: .93 } };
}
it('checks only the selected exact passage, including nested containment, while retaining ordered confidence certificates', () => {
  const input = context(); const source = input.documents[0]; const group = { key: 'custom:platform/deployment', name: 'Deployment' };
  const checked = groupAssessmentDecision(input, source, group, answers(), true)!;
  expect(checked.evidence).toEqual([filingPassages(source)[1]]);
  expect(checked.confidences).toEqual([.91, .92, .93]);
  expect(groupAssessmentDecision(input, source, { key: 'custom:platform', name: 'Platform' }, answers())?.confidences).toEqual([.92]);
});
it('rejects a selected unsupported passage even when a different passage passed every check', () => {
  const input = context(); const selected = answers(); selected.evidence = choice('p0');
  expect(groupAssessmentDecision(input, input.documents[0], { key: 'custom:platform', name: 'Platform' }, selected)).toBeUndefined();
});
it.each(['none', 'unknown', 'unavailable'])('rejects an absent exact support passage %s', selected => {
  const input = context(); const checked = answers(); checked.evidence = choice(selected);
  expect(groupAssessmentDecision(input, input.documents[0], { key: 'custom:platform', name: 'Platform' }, checked)).toBeUndefined();
});
it('requires bootstrap coherence and the selected nested containment at the configured threshold', () => {
  const input = context(); const source = input.documents[0]; const group = { key: 'custom:platform/deployment', name: 'Deployment' };
  const incoherent = answers(); incoherent.coherent = { type: 'noul', noul: .69 };
  expect(groupAssessmentDecision(input, source, group, incoherent, true)).toBeUndefined();
  const uncontained = answers(); uncontained.containment_1 = { type: 'noul', noul: .69 };
  expect(groupAssessmentDecision(input, source, group, uncontained)).toBeUndefined();
  delete uncontained.purpose_1;
  expect(groupAssessmentDecision(input, source, group, uncontained)).toBeUndefined();
});
it('supplies distinct exact local evidence checks for every candidate passage and preserves fresh input objects', () => {
  const input = context(); const source = input.documents[0]; const origins = filingPassages(source);
  input.vocabulary.push({ id: 'group', kind: 'group', name: 'Platform', groupKey: 'custom:platform', definition: 'Platform deployment',
    state: 'active', version: 1, aliases: [], members: [] }, { id: 'label', kind: 'label', name: 'Label', definition: 'Label meaning',
    state: 'active', version: 1, aliases: [], members: [] });
  const group = { key: 'custom:platform/deployment', name: 'Deployment', origins };
  const before = structuredClone({ input, group }); const set = groupAssessmentSet(input, source, group, true);
  expect(set.state.selectedGroup).toMatchObject({ definition: origins.map(passage => passage.quote).join('\n') });
  expect(set.state.existingDefinitions).toEqual([{ name: 'Platform', key: 'custom:platform', definition: 'Platform deployment', state: 'active' }]);
  expect(set.state.localEvidence).toEqual(origins.map(({ quote, start, end }) => ({ quote, start, end })));
  origins.forEach((_, index) => {
    expect(set.questions[`purpose_${index}`].instructions).toContain(`Use only localEvidence[${index}]`);
    expect(set.questions[`containment_${index}`].instructions).toContain(`Use only localEvidence[${index}]`);
  });
  expect({ input, group }).toEqual(before);
  const plain = groupAssessmentSet(input, source, { key: 'custom:platform', name: 'Platform' });
  expect(plain.questions).not.toHaveProperty('coherent'); expect(plain.questions).not.toHaveProperty('containment_0');
  expect(groupAssessmentSet(input, source, { key: 'custom:empty', name: 'Empty' }, true).state.selectedGroup).toMatchObject({ definition: '' });
});
it('reuses semantic group inputs after only metadata revisions change and keeps source identity changes visible', () => {
  const source = document(); const group = { key: 'custom:platform', name: 'Platform', origins: filingPassages(source) };
  const before = structuredClone(group); const semantic = semanticGroupState(group);
  group.origins[0].source.metadataRevision += 1;
  expect(semanticGroupState(group)).toEqual(semantic);
  group.origins[0].source.incarnation = 'recreated';
  expect(semanticGroupState(group)).not.toEqual(semantic);
  expect(semanticGroupState({ key: 'custom:platform', name: 'Platform' })).toEqual({ key: 'custom:platform', name: 'Platform' });
  expect(before.origins[0].source.metadataRevision).toBe(0);
});
