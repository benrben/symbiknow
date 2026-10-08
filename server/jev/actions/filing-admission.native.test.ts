import { expect, it } from 'vitest';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingPassages } from './group-passages.js';
import { membershipGroupKey } from './groups.js';
import { file } from './profile.js';

type Wire = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
function document(id: string, subject: string): JevInputDocument {
  const block = { id, title: `${subject} ${id}`, file: `${id}.md`, kind: 'markdown' as const,
    content: `# ${subject}\n\n${subject} governs the substantive procedures explained in this ${id} guide.`,
    group: 'custom:engineering', incarnation: id, sourceGeneration: 1, metadataRevision: 1,
    x: 0, y: 0, width: 400, height: 300, links: [],
    jevOwnership: { managed: ['group'], pins: [], removedLabels: [], removedLinks: [] } };
  return { canvasId: 'canvas', block, snapshot: sourceSnapshot('workspace', 'canvas', block) };
}
function localQuestion(wire: Wire, id: string) {
  let state = wire.state; let name = id; let match = /^(\d+)__(.+)$/.exec(name);
  while (match) { state = (state.questionSets as Wire['state'][])[Number(match[1])]; name = match[2]; match = /^(\d+)__(.+)$/.exec(name); }
  return { state, name };
}
function fixture(subject: string, trigger: 'none' | 'rejected root', support = .99, evidence = 'p1') {
  const documents = ['implementation', 'reference'].map(id => document(id, subject));
  const [member] = documents; const calls: Wire[] = []; const key = membershipGroupKey(subject);
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents, tasks: [],
    canvases: [{ id: 'canvas', name: 'Technical library', groups: [
      { id: 'custom:engineering', name: 'Engineering', definition: 'Technical systems and their engineering.' },
      { id: 'custom:transport', name: 'Transport', definition: 'Network transport and wire protocols only.' }] }],
    vocabulary: [], settings: emptyJevWorkspace().settings, apiKey: 'offline-filing-admission', selectiveGroupAssessment: true,
    indexes: Object.fromEntries(documents.map(source => [`canvas:${source.block.id}`, { version: 1, calibration: 1,
      source: { ...source.snapshot }, topics: [{ name: subject, confidence: .99,
        evidence: filingPassages(source).slice(1).map(passage => ({ ...passage, source: { ...passage.source } })) }] }])),
    decider: (apiKey, state, questions, _fetcher, options) => decideWithJev(apiKey, state, questions, async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Wire; calls.push(wire);
      return Response.json({ answers: Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
        const local = localQuestion(wire, id); const group = local.state.selectedGroup as { key: string } | undefined;
        const groups = local.state.groups as Array<{ key: string; option: string }> | undefined;
        const preferred = Object.hasOwn(local.state, 'baselineGroup') ? key : trigger === 'rejected root' ? 'custom:transport' : 'none';
        const selected = ['place', 'gate'].includes(local.name) ? groups?.find(group => group.key === preferred)?.option ?? 'none'
          : local.name === 'evidence' ? evidence : 'none';
        const answer: JevAnswer = question.type === 'choice' ? { type: 'choice', choice: selected, confidence: .99,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) }
          : { type: 'noul', noul: local.name === 'independent' || group?.key === 'custom:transport' ? .1 : support };
        return [id, answer];
      })) });
    }, options) };
  return { context, member, key, calls };
}

it.each([
  ['Typography', 'none'], ['Identity controls', 'none'], ['Plugin SDK', 'rejected root'],
] as const)('admits fresh %s taxonomy after initial %s instead of using only the legacy source catalog', async (subject, trigger) => {
  const f = fixture(subject, trigger); const before = structuredClone(f.context.documents);
  const result = await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['implementation'] });
  const member = result.proposals.find(proposal => proposal.mutation.kind === 'document');
  expect(member).toMatchObject({ mutation: { patch: { group: f.key } }, sources: [f.member.snapshot],
    evidence: [filingPassages(f.member)[1]] });
  const comparison = f.calls.find(call => call.state.baselineGroup)!;
  expect(comparison.state).toMatchObject({ baselineGroup: trigger === 'rejected root' ? 'custom:transport' : 'custom:engineering',
    currentGroup: 'custom:engineering' });
  expect((comparison.state.groups as Array<{ key: string }>).some(group => group.key === f.key)).toBe(true);
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!;
  expect(new Set(definition.evidence.map(passage => passage.source.blockId))).toEqual(new Set(['implementation', 'reference']));
  expect(result.proposals.indexOf(definition)).toBeLessThan(result.proposals.indexOf(member!));
  expect(f.context.documents).toEqual(before);
});

it.each(['manual', 'pinned'] as const)('does not admit a fresh source family after abstention for %s existing ownership', async ownership => {
  const f = fixture('Typography', 'none');
  if (ownership === 'manual') f.member.block.jevOwnership!.managed = [];
  else f.member.block.jevOwnership!.pins = ['group'];
  expect((await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['implementation'] })).proposals).toEqual([]);
  expect(f.calls.some(call => call.state.baselineGroup)).toBe(false);
  expect(f.member.block.group).toBe('custom:engineering');
});

it('retains current membership when admitted taxonomy fails the unchanged semantic cutoff', async () => {
  const f = fixture('Typography', 'none', .69);
  expect((await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['implementation'] })).proposals).toEqual([]);
  expect(f.calls.some(call => call.state.baselineGroup)).toBe(true);
  expect(f.member.block.group).toBe('custom:engineering');
});

it.each([false, true])('discovers a fresh checked family on ordinary first filing with no current group (existing candidates=%s)', async existing => {
  const f = fixture('Typography', 'none');
  delete f.member.block.group; delete f.member.block.jevOwnership;
  if (!existing) {
    f.context.canvases[0].groups = [];
    for (const source of f.context.documents) delete source.block.group;
  }
  const result = await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['implementation'] });
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')).toMatchObject({
    mutation: { patch: { group: f.key } }, sources: [f.member.snapshot], evidence: [filingPassages(f.member)[1]] });
  const comparison = f.calls.find(call => Object.hasOwn(call.state, 'baselineGroup'))!;
  expect(comparison.state).toMatchObject({ baselineGroup: null, currentGroup: null });
  expect((comparison.state.groups as Array<{ key: string }>).map(group => group.key)).not.toContain('custom:engineering');
  expect(new Set(result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!.evidence.map(proof => proof.source.blockId)))
    .toEqual(new Set(['implementation', 'reference']));
  expect(f.member.block).not.toHaveProperty('group');
});

it('keeps an explicitly pinned empty group empty during first filing', async () => {
  const f = fixture('Typography', 'none'); f.context.canvases[0].groups = [];
  for (const source of f.context.documents) delete source.block.group;
  f.member.block.jevOwnership!.pins = ['group'];
  expect((await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['implementation'] })).proposals).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(f.member.block).not.toHaveProperty('group');
});

it.each(['none', 'rejected root'] as const)('never mutates membership when admitted taxonomy has no selected exact proof after %s', async trigger => {
  const f = fixture('Typography', trigger, .99, 'none');
  const before = structuredClone(f.context.documents);
  expect((await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['implementation'] })).proposals).toEqual([]);
  expect(f.calls.some(call => call.state.baselineGroup)).toBe(true);
  expect(f.context.documents).toEqual(before);
});

it('keeps an empty first-filing source local when there is no group or substantive nomination evidence', async () => {
  const f = fixture('Typography', 'none'); f.context.canvases[0].groups = [];
  for (const source of f.context.documents) { delete source.block.group; source.block.title = ''; source.block.content = ''; }
  const result = await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['implementation'] });
  expect(result.proposals).toEqual([]);
  expect(result.result.status).toBe('no_source_derived_group_names');
  expect(f.calls).toEqual([]);
});
