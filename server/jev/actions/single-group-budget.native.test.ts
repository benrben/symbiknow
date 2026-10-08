import { expect, it } from 'vitest';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { evaluateJevAction } from '../actions.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingPassages } from './group-passages.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
function document(id: string, title = 'Engineering', content = '# Engineering\nEngineering service contracts establish deployment requirements.\nKeep checked engineering release evidence.'): JevInputDocument {
  return { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id,
    incarnation: id, sourceGeneration: 1, metadataRevision: 0, contentHash: id },
    block: { id, title, content, kind: 'markdown', file: `${id}.md`, x: 3, y: 5, width: 400, height: 300, links: [] } };
}
function scoped(body: Body, key: string) {
  let state = body.state; let name = key; let match: RegExpExecArray | null;
  while ((match = /^(\d+)__(.+)$/.exec(name))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(match[1])]; name = match[2];
  }
  return { state: resolveSharedQuestionSources(state, body.state.sourceStates), name };
}
function fixture(groupCount: number, support: number | ((group?: string) => number) = .7) {
  const source = document('source'); const calls: Body[] = [];
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [source], tasks: [],
    canvases: [{ id: 'canvas', name: 'Knowledge' }], settings: emptyJevWorkspace().settings,
    vocabulary: ['Engineering', 'Gardening'].slice(0, groupCount).map((name, index) => ({ id: `group-${index}`,
      name, groupKey: `custom:${name.toLowerCase()}`, definition: `${name} substantive scope`, kind: 'group',
      state: 'active', version: 1, aliases: [], members: [] })),
    apiKey: 'offline-single-group', shareQuestionSources: true, selectiveGroupAssessment: true,
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Body; calls.push(body);
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, submitted]) => {
        const question = resolveSharedQuestionTexts(submitted, body.state.questionTexts);
        const { name, state: selectedState } = scoped(body, id);
        const group = selectedState.selectedGroup as { key: string } | undefined;
        const purpose = name.startsWith('purpose_');
        const selected = (selectedState.groups as Array<{ key: string }> | undefined)?.[0];
        const supportValue = typeof support === 'number' ? support : support(group?.key ?? selected?.key);
        const answer: JevAnswer = name === 'gate' ? gateAnswer(question, supportValue)
          : question.type === 'noul' ? { type: 'noul', noul: purpose ? supportValue : .98 }
          : choiceAnswer(question, group?.key === 'custom:delivery' ? 'p3' : 'p1');
        return [id, answer];
      }));
      return Response.json({ answers });
    }, options) };
  return { source, context, calls, run: () => evaluateJevAction(context, { action: 'file', canvasId: 'canvas', blockIds: [source.block.id] }) };
}
function gateAnswer(question: JevQuestion, confidence: number): JevAnswer {
  if (question.type !== 'choice') throw new Error('Expected the canonical filing gate');
  const probability = confidence >= .7 ? .4 + (confidence - .7) * .6 / .3 : confidence * .4 / .7;
  const selected = Object.keys(question.criteria).find(key => key !== 'none')!;
  return { type: 'choice', choice: probability >= .5 ? selected : 'none', confidence: .98,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? probability : key === 'none' ? 1 - probability : 0])) };
}
function choiceAnswer(question: JevQuestion, evidence: string): JevAnswer {
  if (question.type !== 'choice') throw new Error('Unexpected grouping score question');
  const keys = Object.keys(question.criteria);
  const selected = keys.find(key => question.criteria[key].includes('(custom:delivery)'))
    ?? keys.find(key => /^(g|new)\d+$/.test(key)) ?? (keys.includes(evidence) ? evidence : keys[0]);
  return { type: 'choice', choice: selected, confidence: .98,
    probabilities: Object.fromEntries(keys.map(key => [key, Number(key === selected)])) };
}
function names(body: Body) { return Object.keys(body.questions).map(key => scoped(body, key).name); }

it.each([0, 1])('keeps bootstrap in one wave and existing placement in separate selection and proof calls (existing groups: %s)', async groupCount => {
  const native = fixture(groupCount, groupCount ? .705 : .7);
  const result = await native.run();
  expect(native.calls).toHaveLength(groupCount ? 3 : 1);
  const submitted = names(native.calls[0]);
  if (groupCount) {
    expect(submitted).toEqual(['place', 'gate']);
    expect(names(native.calls[1])).toEqual(['evidence']);
    expect(names(native.calls[2])).toEqual(['purpose_1']);
  } else {
    expect(submitted).toContain('group'); expect(submitted).toContain('evidence');
    expect(submitted.filter(name => name.startsWith('purpose_'))).toEqual(filingPassages(native.source).map((_, index) => `purpose_${index}`));
    expect(submitted).toContain('coherent');
  }
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document')!;
  expect(membership).toBeDefined(); expect(membership.evidence).toEqual([filingPassages(native.source)[1]]);
  if (groupCount) {
    expect(membership.decisionConfidences).toHaveLength(2);
    expect(membership.decisionConfidences![0]).toBeCloseTo(.705);
    expect(membership.decisionConfidences![1]).toBe(.705);
  } else expect(membership.decisionConfidences).toEqual([.98, .98, .7]);
  expect(native.context.selectiveGroupAssessment).toBe(true);
  expect(native.context.settings.confidenceThresholds?.file).toBe(.7);
});

it.each([0, 1])('rejects .69 semantic support for a single shared candidate at the unchanged .7 threshold (existing groups: %s)', async groupCount => {
  const native = fixture(groupCount, .69);
  const result = await native.run();
  expect(native.calls).toHaveLength(groupCount ? 2 : 1);
  expect(names(native.calls.at(-1)!)).toContain('purpose_1');
  expect(result.proposals).toEqual([]);
  expect(native.context.settings.confidenceThresholds?.file).toBe(.7);
});

it('retains selective semantic assessment for multiple existing groups instead of certifying every candidate eagerly', async () => {
  const native = fixture(2, .98);
  const result = await native.run();
  expect(native.calls).toHaveLength(3);
  expect(names(native.calls[0])).toEqual(['place', 'gate']);
  expect(names(native.calls[0]).some(name => name.startsWith('purpose_'))).toBe(false);
  expect(names(native.calls[1])).toEqual(['evidence']);
  expect(names(native.calls[2])).toEqual(['purpose_1']);
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')?.evidence).toEqual([filingPassages(native.source)[1]]);
});

it('restores selective assessment when a rejected single existing group falls back to multiple new candidates', async () => {
  const native = fixture(1, key => key === 'custom:engineering' ? .69 : .98);
  native.source.block.content = '# Engineering\nEngineering release notes.\n# Delivery\nDelivery rollout requirements.';
  const peer = document('peer', 'Storage', '# Storage\nDurable archive retention and recovery.');
  native.context.documents.push(peer); native.source.block.links = [peer.block.id];
  const result = await native.run();
  expect(native.calls).toHaveLength(3);
  expect(names(native.calls[0])).toEqual(['place', 'gate']);
  expect(names(native.calls[1]).filter(name => name === 'evidence').length).toBeGreaterThan(1);
  expect(names(native.calls[1]).some(name => name.startsWith('purpose_'))).toBe(false);
  expect(names(native.calls[2])).toEqual(['coherent', 'purpose_3']);
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation)
    .toMatchObject({ patch: { group: 'custom:delivery' } });
});

it('retains the full checked shared-category scope when defining a group for its first member', async () => {
  const native = fixture(0, .98);
  const deploymentCaption = 'Release Engineering · Production deployment';
  const rollbackCaption = 'Release Engineering · Rollback recovery';
  native.source.block.title = 'Deployment';
  native.source.block.content = `# Deployment\n${deploymentCaption}\nProduction deployment follows checked release acceptance.`;
  const rollback = document('rollback', 'Rollback', `# Rollback\n${rollbackCaption}\nRollback restores the previous working release.`);
  native.context.documents.push(rollback);
  const result = await native.run();
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary');
  expect(definition?.mutation.kind).toBe('vocabulary');
  if (definition?.mutation.kind !== 'vocabulary') throw new Error('Expected the checked shared-category definition');
  const term = definition.mutation.term;
  expect(term.groupKey).toBe('custom:release_engineering');
  expect(term.definition).toBe(`${deploymentCaption}\n${rollbackCaption}`);
  expect(term.definition).not.toBe(filingPassages(native.source)[1].quote);
  const checkedGroup = native.calls.flatMap(body => Object.keys(body.questions).map(key => scoped(body, key).state.selectedGroup))
    .find(value => (value as { key?: string } | undefined)?.key === term.groupKey) as { definition: string };
  expect(term.definition).toBe(checkedGroup.definition);
  expect(new Set(definition.evidence.map(passage => passage.source.blockId))).toEqual(new Set(['source', 'rollback']));
  for (const passage of definition.evidence) {
    const source = native.context.documents.find(document => document.block.id === passage.source.blockId)!;
    expect(passage.source).toEqual(source.snapshot);
    expect(source.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  }
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')?.evidence)
    .toEqual([filingPassages(native.source)[1]]);
  // A later member must be reviewed against the same broad definition that authorized creation.
  native.context.vocabulary.push(term);
  const later = await evaluateJevAction(native.context, { action: 'file', canvasId: 'canvas', blockIds: [rollback.block.id] });
  expect(later.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation)
    .toMatchObject({ blockId: rollback.block.id, patch: { group: term.groupKey } });
  const reused = Object.keys(native.calls.at(-1)!.questions).map(key => scoped(native.calls.at(-1)!, key).state.selectedGroup)
    .find(value => (value as { key?: string } | undefined)?.key === term.groupKey) as { definition: string };
  expect(reused.definition).toBe(term.definition);
});
