import { expect, it } from 'vitest';
import { decideWithJev, estimateJevTokens, type JevAnswer, type JevDecider, type JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import { sourceSnapshot } from '../stamps.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { judge } from './context.js';
import { filingDecision, refinementQuestionSet } from './filing-selection.js';
import { assessGroupRefinement } from './grouping.js';
import { filingPassages } from './group-passages.js';
import type { ProposedGroup } from './group-topics.js';
import { questionRequestFits } from './question-request-budget.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';
import { broadStartContext, broadStartPrerequisites, broadStartReport, engineering, request } from '../../../scripts/jev-bench/file-broad-start.mjs';
import { file } from './profile.js';

type Wire = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
function localState(wire: Wire, id: string) {
  let state = wire.state; let name = id; let match: RegExpExecArray | null;
  while ((match = /^(\d+)__(.+)$/.exec(name))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(match[1])]; name = match[2];
  }
  return { name, state: resolveSharedQuestionTexts(resolveSharedQuestionSources(state, wire.state.sourceStates), wire.state.questionTexts) };
}
function positiveControl(question: JevQuestion, name: string, state: Record<string, unknown>): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .99 };
  if (question.type !== 'choice') throw new Error('Unexpected grouping score question');
  const keys = Object.keys(question.criteria);
  const comparison = Object.hasOwn(state, 'baselineGroup');
  const selected = ['place', 'gate'].includes(name) ? comparison ? 'B' : 'A'
    : keys.includes('p1') ? 'p1' : keys.includes('reference') ? 'reference' : keys[0];
  return { type: 'choice', choice: selected, confidence: .99,
    probabilities: Object.fromEntries(keys.map(key => [key, Number(key === selected)])) };
}
function nativeControl(shared: boolean, calls: Wire[]): JevDecider {
  return (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as Wire;
    expect(questionRequestFits(wire.state, wire.questions, shared)).toBe(true);
    calls.push(wire);
    return Response.json({ answers: Object.fromEntries(Object.entries(wire.questions).map(([id, submitted]) => {
      const question = resolveSharedQuestionTexts(submitted, wire.state.questionTexts);
      const local = localState(wire, id);
      return [id, positiveControl(question, local.name, local.state)];
    })) });
  }, options);
}
function pressureDocument(id: string, multibyte = false): JevInputDocument {
  const body = multibyte ? '身份认证验证账户权限并保护会话凭据。'.repeat(45)
    : 'Authentication establishes checked account access and protects session credentials. '.repeat(9);
  const content = '# Authentication\n\n' + Array.from({ length: 8 }, (_, index) => `${index}: ${body}`).join('\n\n');
  const block = { id, title: 'Authentication reference '.repeat(4).slice(0, 80), content, file: `${id}.md`, kind: 'markdown' as const,
    group: 'custom:engineering', incarnation: id, sourceGeneration: 1, metadataRevision: 1,
    x: 0, y: 0, width: 400, height: 300, links: [],
    jevOwnership: { managed: ['group'], pins: [], removedLabels: [], removedLinks: [] } };
  return { canvasId: 'canvas', block, snapshot: sourceSnapshot('workspace', 'canvas', block) };
}
function pressureFixture(shared: boolean, multibyte = false, distinctPeers = false) {
  const ids = ['member', ...Array.from({ length: distinctPeers ? 60 : 4 }, (_, index) => `peer-${index + 1}`)];
  const documents = ids.map(id => pressureDocument(id, multibyte));
  const [member, ...peers] = documents; const calls: Wire[] = [];
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents, tasks: [], indexes: {},
    canvases: [{ id: 'canvas', name: 'Knowledge' }], vocabulary: [], settings: emptyJevWorkspace().settings,
    apiKey: 'offline-comparison-budget', shareQuestionSources: shared, decider: nativeControl(shared, calls) };
  const origins = filingPassages(member).slice(1, 5);
  const alternatives: ProposedGroup[] = Array.from({ length: 15 }, (_, index) => ({
    key: `custom:authentication_${index}`, name: `Authentication family ${index} ${'category '.repeat(8)}`.slice(0, 80),
    nomination: 'source_family', origins, definition: origins.map(origin => origin.quote).join('\n'),
    candidatePeers: (distinctPeers ? peers.slice(index * 4, index * 4 + 4) : peers).map(peer => peer.snapshot),
    subjectContext: (distinctPeers ? peers.slice(index * 4, index * 4 + 4) : peers).map(peer => ({ name: peer.block.title,
      passages: filingPassages(peer).slice(1, 3), contextOnly: true })),
  }));
  const current = { key: engineering.key, name: engineering.name, definition: engineering.definition.repeat(8) };
  return { context, calls, member, alternatives, current };
}

it.each([false, true])('fits all fifteen alternatives with four maximum-quote peers through the actual SDK comparison (shared=%s)', async shared => {
  const f = pressureFixture(shared); const before = structuredClone(f.alternatives);
  expect(f.alternatives.every(group => group.origins.every(origin => origin.quote.length === 600))).toBe(true);
  const unprojected = { groups: [f.current, ...f.alternatives] };
  expect(estimateJevTokens(unprojected)).toBeGreaterThan(16000);
  const set = refinementQuestionSet(f.context, f.member, f.current, f.alternatives);
  expect(set.state.groups).toHaveLength(16);
  expect(questionRequestFits(set.state, set.questions, false, 200)).toBe(true);
  expect(questionRequestFits(set.state, set.questions, true, 4200)).toBe(true);
  for (const group of set.state.groups.slice(1)) {
    expect(group).not.toHaveProperty('origins'); expect(group).not.toHaveProperty('candidatePeers');
    expect(group).not.toHaveProperty('subjectContext');
    expect(group.definition.length).toBeLessThanOrEqual(300);
    expect(group.peerSubjectIds).toHaveLength(4);
    const previews = group.peerSubjectIds!.map(id => set.state.peerSubjects[id]);
    expect(previews.every(peer => peer.contextOnly && new TextEncoder().encode(peer.purpose).length <= 240)).toBe(true);
  }
  const answers = await judge(f.context, set.state, set.questions);
  expect(f.calls).toHaveLength(1);
  expect(filingDecision(f.context, f.member, set.groups, answers)?.group.key).toBe(f.alternatives[0].key);
  const result = await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas', blockIds: [f.member.block.id] },
    f.member, f.alternatives[0], .99);
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document');
  expect(membership?.evidence).toEqual([filingPassages(f.member)[1]]);
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary');
  expect(definition?.evidence.some(origin => origin.source.blockId === 'peer-1' && origin.quote.length === 600)).toBe(true);
  expect(f.alternatives).toEqual(before);
});
it('keeps all fifteen comparison choices when each family nominates four different multibyte evidence peers', async () => {
  const f = pressureFixture(false, true, true);
  expect(new Set(f.alternatives.flatMap(group => group.candidatePeers ?? []).map(peer => peer.blockId)).size).toBe(60);
  const set = refinementQuestionSet(f.context, f.member, f.current, f.alternatives);
  expect(set.state.groups).toHaveLength(16);
  expect(questionRequestFits(set.state, set.questions, false, 200), String(estimateJevTokens(set.state) + estimateJevTokens(set.questions))).toBe(true);
  await expect(judge(f.context, set.state, set.questions)).resolves.toHaveProperty('place');
  expect(f.calls).toHaveLength(1);
});

it('completes the frozen Atlas profile, fresh label, and comparative filing path through an offline SDK control without a 413', async () => {
  const calls: Wire[] = []; const context = broadStartContext('managed', nativeControl(false, calls));
  const phases: string[] = []; const bodies = context.documents.map(document => document.block.content);
  const prerequisites = await broadStartPrerequisites(context, phase => { phases.push(phase); });
  phases.push('file'); const result = await file(context, request);
  const report = broadStartReport(context, result);
  expect(phases).toEqual(['profile', 'label', 'file']);
  expect(prerequisites.profiled.proposals).toHaveLength(20);
  expect(Object.values(prerequisites.indexes).every(index => Array.isArray(index.topics) && index.topics.length > 0)).toBe(true);
  expect(prerequisites.labeled.proposals.length).toBeGreaterThan(0);
  expect(report.summary).toMatchObject({ exactEvidence: true, definitionsBeforeMembership: true, canonicalWrites: 0 });
  expect(report.summary.refined).toBeGreaterThan(0);
  expect(context.documents.map(document => document.block.content)).toEqual(bodies);
  const comparisons = calls.filter(wire => Object.hasOwn(wire.state, 'baselineGroup'));
  expect(comparisons.length).toBeGreaterThanOrEqual(20);
  expect(comparisons.every(wire => questionRequestFits(wire.state, wire.questions, false, 200))).toBe(true);
  expect(calls.length).toBeLessThanOrEqual(200);
});
it('keeps maximum-length multibyte source quotes within the ordinary comparison budget before SDK invocation', async () => {
  const f = pressureFixture(false, true);
  const set = refinementQuestionSet(f.context, f.member, f.current, f.alternatives);
  expect(f.alternatives[0].origins.every(origin => origin.quote.length === 600)).toBe(true);
  expect(questionRequestFits(set.state, set.questions, false, 200)).toBe(true);
  await expect(judge(f.context, set.state, set.questions)).resolves.toHaveProperty('place');
  expect(f.calls).toHaveLength(1);
});
