import { expect, it } from 'vitest';
import type { JevVocabularyTerm } from '../../../shared/jev-types.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingPassages } from './group-passages.js';
import { assessGroupRefinement, sharedGroupRefinements } from './grouping.js';
import type { ProposedGroup } from './group-topics.js';
import { file } from './profile.js';

const restriction = 'Only device FIDO2 keys; exclude password-only authentication.';
type Wire = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
function fixture(authority: 'vocabulary' | 'native') {
  const block = { id: 'passwords', title: 'Authentication', file: 'passwords.md', kind: 'markdown' as const,
    content: '# Authentication\n\nPassword-only authentication validates an account password before granting access.',
    group: 'custom:engineering', incarnation: 'password-incarnation', sourceGeneration: 1, metadataRevision: 1,
    x: 0, y: 0, width: 400, height: 300, links: [],
    jevOwnership: { managed: ['group'], pins: [], removedLabels: [], removedLinks: [] } };
  const member: JevInputDocument = { canvasId: 'canvas', block, snapshot: sourceSnapshot('workspace', 'canvas', block) };
  const term: JevVocabularyTerm = { id: 'authentication', kind: 'group', name: 'Device identity', groupKey: 'custom:authentication',
    definition: restriction, aliases: [], state: 'active', version: 4, members: [] };
  const calls: Wire[] = [];
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [member], tasks: [],
    canvases: [{ id: 'canvas', name: 'Knowledge', groups: authority === 'native'
      ? [{ id: term.groupKey!, name: term.name, definition: restriction }] : [] }],
    vocabulary: authority === 'vocabulary' ? [term] : [], settings: emptyJevWorkspace().settings,
    apiKey: 'offline-canonical-scope', selectiveGroupAssessment: true,
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Wire; calls.push(wire);
      const scoped = wire.state.selectedGroup as { definition?: string };
      return Response.json({ answers: Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
        const groups = wire.state.groups as Array<{ key: string; option: string }> | undefined;
        const selected = groups?.find(group => group.key === (wire.state.baselineGroup ? 'custom:authentication' : 'custom:engineering'))?.option ?? 'p1';
        const answer: JevAnswer = question.type === 'choice'
          ? { type: 'choice', choice: selected, confidence: .99,
            probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) }
          : { type: 'noul', noul: id.startsWith('purpose_') && scoped.definition === restriction ? .1 : .99 };
        return [id, answer];
      })) });
    }, options) };
  const group: ProposedGroup = { name: 'Authentication', key: 'custom:authentication',
    definition: 'All software authentication mechanisms.', nomination: 'source_subject', origins: filingPassages(member).slice(1),
    parent: { name: 'Unrelated nominee parent', key: 'custom:unrelated' } };
  return { context, member, term, group, calls };
}
function reviewedSubject(f: ReturnType<typeof fixture>) {
  f.context.indexes = { 'canvas:passwords': { version: 1, calibration: 1, source: { ...f.member.snapshot }, topics: [{ name: 'Authentication', confidence: .99,
    evidence: f.group.origins.map(passage => ({ ...passage, source: { ...passage.source } })) }] } };
}

it.each(['vocabulary', 'native'] as const)('assesses a broad nomination against the authoritative %s restrictions through the actual SDK', async authority => {
  const f = fixture(authority); const before = structuredClone(f.context.vocabulary);
  const result = await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['passwords'] }, f.member, f.group, .99);
  expect(result.proposals).toEqual([]);
  expect(f.calls).toHaveLength(2);
  for (const call of f.calls) expect(call.state.selectedGroup).toMatchObject({ name: 'Device identity', definition: restriction });
  expect(f.calls.every(call => !(call.state.selectedGroup as ProposedGroup).parent)).toBe(true);
  expect(f.context.vocabulary).toEqual(before);
  expect(f.member.block.group).toBe('custom:engineering');
});

it.each(['vocabulary', 'native'] as const)('projects the saved %s meaning before refinement comparison instead of the same-key source nomination', authority => {
  const f = fixture(authority);
  reviewedSubject(f);
  const candidate = sharedGroupRefinements(f.context, f.member, 'custom:engineering').find(group => group.key === f.group.key);
  expect(candidate).toMatchObject({ name: 'Device identity', definition: restriction });
  expect(candidate?.origins).toEqual(f.group.origins);
});

it('uses vocabulary restrictions in initial and refined comparisons even when the native same-key definition is broad', async () => {
  const f = fixture('vocabulary'); reviewedSubject(f);
  f.context.canvases[0].groups = [{ id: f.group.key, name: 'Broad native Authentication', definition: 'All account authentication.' }];
  const result = await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['passwords'] });
  expect(result.proposals).toEqual([]);
  const compared = f.calls.filter(call => call.state.groups).flatMap(call => call.state.groups as ProposedGroup[])
    .filter(group => group.key === f.group.key);
  expect(compared).toHaveLength(2);
  expect(compared.every(group => group.definition === restriction && group.name === f.term.name)).toBe(true);
  expect(f.calls.filter(call => call.state.selectedGroup).every(call =>
    (call.state.selectedGroup as ProposedGroup).definition === restriction)).toBe(true);
});

it('does not nominate or assess a retired canonical group, even when a native or source nomination is active', async () => {
  const f = fixture('vocabulary'); reviewedSubject(f); f.term.state = 'retired';
  f.context.canvases[0].groups = [{ id: f.group.key, name: 'Authentication' }];
  expect(sharedGroupRefinements(f.context, f.member, 'custom:engineering').some(group => group.key === f.group.key)).toBe(false);
  expect(await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas' }, f.member, f.group, .99))
    .toMatchObject({ result: { status: 'retired_group_requires_restore' }, proposals: [] });
  expect(f.calls).toEqual([]);
});

it('preserves the exact candidate vocabulary definition that promotion would retain', async () => {
  const f = fixture('vocabulary'); f.term.state = 'candidate';
  expect((await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas' }, f.member, f.group, .99)).proposals).toEqual([]);
  expect(f.calls.every(call => (call.state.selectedGroup as ProposedGroup).definition === restriction)).toBe(true);
  expect(f.term.state).toBe('candidate');
});

it.each(['vocabulary', 'native', 'unregistered parent'] as const)('retains authoritative hierarchy and parent restrictions for a %s child', async authority => {
  const f = fixture(authority === 'vocabulary' ? 'vocabulary' : 'native');
  const parent: JevVocabularyTerm = { ...f.term, id: 'identity', name: 'Hardware identity', groupKey: 'custom:identity',
    definition: 'Device-backed identity only; exclude password-only identity.' };
  f.group.key = 'custom:identity/authentication';
  if (authority === 'vocabulary') { f.term.groupKey = f.group.key; f.term.parentId = parent.id; f.context.vocabulary.push(parent); }
  else f.context.canvases[0].groups = [{ id: f.group.key, name: f.term.name, definition: restriction },
    ...(authority === 'native' ? [{ id: parent.groupKey!, name: parent.name, definition: parent.definition }] : [])];
  expect((await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas' }, f.member, f.group, .99)).proposals).toEqual([]);
  for (const call of f.calls) expect((call.state.selectedGroup as ProposedGroup).parent).toEqual(authority === 'unregistered parent'
    ? { key: 'custom:identity', name: 'Identity' } : { key: parent.groupKey, name: parent.name, definition: parent.definition });
});

it('does not borrow a same-key definition from a foreign canvas or a label term', async () => {
  const f = fixture('native');
  f.context.canvases[0].id = 'foreign';
  f.context.vocabulary.push({ ...f.term, kind: 'label' });
  const result = await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas' }, f.member, f.group, .99);
  expect(result.proposals.some(proposal => proposal.mutation.kind === 'document')).toBe(true);
  expect(f.calls.every(call => (call.state.selectedGroup as ProposedGroup).definition === f.group.definition)).toBe(true);
});

it('uses the saved native name as scope when no explicit definition exists, without importing a nominee definition', async () => {
  const f = fixture('native'); delete f.context.canvases[0].groups![0].definition;
  const result = await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas' }, f.member, f.group, .99);
  expect(result.proposals.some(proposal => proposal.mutation.kind === 'document')).toBe(true);
  expect(f.calls.every(call => (call.state.selectedGroup as ProposedGroup).definition?.includes('Device identity'))).toBe(true);
  expect(f.calls.every(call => (call.state.selectedGroup as ProposedGroup).definition !== f.group.definition)).toBe(true);
});
