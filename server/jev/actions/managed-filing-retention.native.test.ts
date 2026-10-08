import { expect, it } from 'vitest';
import type { JevProposal, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { automaticHoldReason } from '../eligibility.js';
import { sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingPassages } from './group-passages.js';
import { file } from './profile.js';
import { questionRequestFits } from './question-request-budget.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

type Wire = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
type LocalState = {
  groups?: Array<{ key: string; option: string }>;
  baselineGroup?: string;
  selectedGroup?: { key: string };
  source?: { id: string };
};
type Checked = { id: string; state: LocalState };
type Options = { current?: string; refinement?: 'subject' | 'baseline'; broadPurpose?: boolean; subjectPurpose?: boolean };
const subject = 'custom:authentication';
const broad = 'custom:engineering';
const prose = 'Authentication verifies account credentials and protects sessions.';

function document(id: string, title: string, group: string): JevInputDocument {
  const block = { id, title, file: `${id}.md`, kind: 'markdown' as const,
    content: `# ${title}\n\n## Authentication\n\n${prose}`, group,
    incarnation: id, sourceGeneration: 1, metadataRevision: 1,
    x: 0, y: 0, width: 400, height: 300, links: [],
    jevOwnership: { managed: ['group'], pins: [], removedLabels: [], removedLinks: [] } };
  return { canvasId: 'canvas', block, snapshot: sourceSnapshot('workspace', 'canvas', block) };
}
function term(name: string, key: string, definition: string): JevVocabularyTerm {
  return { id: key, kind: 'group', name, groupKey: key, definition, aliases: [], state: 'active', version: 1, members: [] };
}
function localState(wire: Wire, id: string): Checked {
  let state = wire.state; let name = id; let match: RegExpExecArray | null;
  while ((match = /^(\d+)__(.+)$/.exec(name))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(match[1])]; name = match[2];
  }
  return { id: name, state: resolveSharedQuestionTexts(resolveSharedQuestionSources(state, wire.state.sourceStates), wire.state.questionTexts) };
}
function answer(question: JevQuestion, checked: Checked, options: Options): JevAnswer {
  const { id, state } = checked;
  if (question.type === 'noul') {
    const scopeRejected = (options.broadPurpose === false && state.selectedGroup?.key === broad)
      || (options.subjectPurpose === false && state.selectedGroup?.key === subject);
    const rejected = scopeRejected && id.startsWith('purpose_');
    return { type: 'noul', noul: rejected ? .69 : .99 };
  }
  if (question.type !== 'choice') throw new Error('Unexpected managed filing question');
  const preferred = state.baselineGroup && options.refinement !== 'baseline' ? subject : broad;
  const choice = ['place', 'gate'].includes(id) ? state.groups!.find(group => group.key === preferred)?.option ?? 'none'
    : id === 'group' ? 'none' : Object.keys(question.criteria).find(key => question.criteria[key].includes(prose)) ?? 'none';
  return { type: 'choice', choice, confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) };
}
function fixture(shared: boolean, options: Options = {}) {
  const member = document('member', 'Session access', options.current ?? subject);
  const peer = document('peer', 'Credential verification', subject);
  const calls: Wire[] = []; const checks: Checked[] = [];
  const state = emptyJevWorkspace();
  state.settings.externalProcessing = true; state.settings.modes.file = 'auto';
  state.vocabulary = [term('Engineering', broad, 'Building and maintaining software systems.'),
    term('Authentication', subject, 'Verifying identities and credentials to control access.')];
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [member, peer],
    canvases: [{ id: 'canvas', name: 'Knowledge' }], tasks: [], vocabulary: state.vocabulary,
    settings: state.settings, confidenceThreshold: .7, apiKey: 'offline-managed-retention', shareQuestionSources: shared,
    decider: (key, input, questions, _fetcher, sdkOptions) => decideWithJev(key, input, questions, async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Wire; calls.push(wire);
      expect(questionRequestFits(wire.state, wire.questions, shared)).toBe(true);
      return Response.json({ answers: Object.fromEntries(Object.entries(wire.questions).map(([id, submitted]) => {
        const checked = localState(wire, id); checks.push(checked);
        const question = resolveSharedQuestionTexts(submitted, wire.state.questionTexts);
        return [id, answer(question, checked, options)];
      })) });
    }, sdkOptions) };
  return { member, peer, state, context, calls, checks,
    request: { action: 'file' as const, canvasId: 'canvas', blockIds: ['member'] } };
}

it.each([false, true])('retains a checked managed subject when the initial broad winner differs without repeated membership writes (shared=%s)', async shared => {
  const f = fixture(shared); const before = structuredClone({ documents: f.context.documents, vocabulary: f.context.vocabulary });
  const first = await file(f.context, f.request);
  const second = await file(f.context, f.request);
  expect(first.proposals).toEqual([]); expect(second.proposals).toEqual([]);
  expect(f.calls.filter(call => call.state.baselineGroup === broad)).toHaveLength(2);
  expect(f.checks.some(check => check.state.source?.id === 'member' && check.state.selectedGroup?.key === subject && check.id === 'coherent')).toBe(true);
  expect(f.checks.some(check => check.state.source?.id === 'peer' && check.state.selectedGroup?.key === subject && check.id.startsWith('purpose_'))).toBe(true);
  expect(f.context.documents).toEqual(before.documents); expect(f.context.vocabulary).toEqual(before.vocabulary);
  expect(f.member.block).not.toHaveProperty('jevMutationId');
});

it.each([false, true])('checks a useful refinement before moving from a wrong managed group to the broad initial winner (shared=%s)', async shared => {
  const f = fixture(shared, { current: 'custom:legacy' }); const before = structuredClone(f.context.documents);
  const result = await file(f.context, f.request);
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0]).toMatchObject({ mutation: { kind: 'document', patch: { group: subject } },
    sources: [f.member.snapshot], evidence: [filingPassages(f.member)[2]] });
  expect(f.calls.some(call => call.state.baselineGroup === broad)).toBe(true);
  expect(f.context.documents).toEqual(before);
});

it.each([true, false])('falls back to exact selected-group purpose checks after refinement retains the baseline (purpose supported=%s)', async supported => {
  const f = fixture(true, { refinement: 'baseline', broadPurpose: supported });
  const before = structuredClone(f.context.documents); const result = await file(f.context, f.request);
  expect(f.calls.some(call => call.state.baselineGroup === broad)).toBe(true);
  expect(f.checks.some(check => check.state.selectedGroup?.key === broad && check.id === 'evidence')).toBe(true);
  expect(f.checks.some(check => check.state.selectedGroup?.key === broad && check.id === 'purpose_2')).toBe(true);
  if (supported) {
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ mutation: { kind: 'document', patch: { group: broad } },
      sources: [f.member.snapshot], evidence: [filingPassages(f.member)[2]] });
  } else expect(result.proposals).toEqual([]);
  expect(f.context.documents).toEqual(before);
});

it('does not treat former managed membership as proof when its own current exact passage fails refinement purpose', async () => {
  const f = fixture(true, { subjectPurpose: false }); const before = structuredClone(f.context.documents);
  const result = await file(f.context, f.request);
  expect(f.checks.some(check => check.state.selectedGroup?.key === subject && check.id === 'purpose_2')).toBe(true);
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0]).toMatchObject({ mutation: { kind: 'document', patch: { group: broad } },
    sources: [f.member.snapshot], evidence: [filingPassages(f.member)[2]] });
  expect(f.context.documents).toEqual(before);
});

it.each(['manual', 'pinned'] as const)('keeps %s ownership protected and does not invoke refinement for the differing initial winner', async ownership => {
  const f = fixture(true);
  if (ownership === 'manual') f.member.block.jevOwnership!.managed = [];
  else f.member.block.jevOwnership!.pins = ['group'];
  const before = structuredClone(f.context.documents); const result = await file(f.context, f.request);
  expect(f.calls.every(call => !Object.hasOwn(call.state, 'baselineGroup'))).toBe(true);
  expect(result.proposals).toHaveLength(1);
  const candidate: JevProposal = { ...result.proposals[0], id: 'protected', jobId: 'file-job', state: 'pending', createdAt: '2026-10-08T00:00:00.000Z' };
  expect(automaticHoldReason(f.state, candidate, f.context)).toBe('A field is pinned or managed manually');
  expect(f.context.documents).toEqual(before);
  expect(f.member.block).not.toHaveProperty('jevMutationId');
});
