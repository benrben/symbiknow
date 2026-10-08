import { expect, it } from 'vitest';
import { CanvasStore } from '../../storage.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { JevWorkspaceFiles } from '../workspace.js';
import { runCanonicalFilingQueue, type CanonicalPhase, type CanonicalSource } from '../../../scripts/jev-bench/file-canonical-queue.mjs';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

const sources: CanonicalSource[] = [
  { id: 'sessions', title: 'Session access', content: '# Session access\n\n## Authentication\n\nAuthentication verifies user identity before issuing a session.' },
  { id: 'credentials', title: 'Credential validation', content: '# Credential validation\n\n## Authentication\n\nAuthentication verifies passwords and rotates credentials safely.' },
  { id: 'manual', title: 'Manual operating notes', content: '# Manual operating notes\n\nEngineering operates a manually curated service inventory.', manual: true },
];
type State = Record<string, unknown>;
type Call = { phase: CanonicalPhase; document?: string; state: State; questions: Record<string, JevQuestion> };
function localQuestion(state: State, name: string) {
  let local = state; let id = name; let match = /^(\d+)__(.+)$/.exec(id);
  while (match) {
    local = (local.questionSets as State[])[Number(match[1])]; id = match[2]; match = /^(\d+)__(.+)$/.exec(id);
  }
  return { state: resolveSharedQuestionSources(local, state.sourceStates), id };
}
function choice(question: Extract<JevQuestion, { type: 'choice' }>, selected: string): JevAnswer {
  return { type: 'choice', choice: selected, confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) };
}
function selection(state: State, id: string, question: Extract<JevQuestion, { type: 'choice' }>) {
  if (['place', 'gate'].includes(id)) {
    const groups = state.groups as Array<{ key: string; option: string }>;
    return (groups.find(group => group.key === 'custom:authentication') ?? groups[0])?.option ?? 'none';
  }
  if (id === 'role') return Object.keys(question.criteria).find(key => key === 'reference') ?? Object.keys(question.criteria)[0];
  if (id === 'group') return Object.keys(question.criteria).find(key => question.criteria[key].includes('(custom:authentication)')) ?? 'none';
  return Object.keys(question.criteria).find(key => /Authentication verifies/.test(question.criteria[key])) ?? 'none';
}
function answer(state: State, name: string, question: JevQuestion): JevAnswer {
  const local = localQuestion(state, name);
  if (question.type === 'noul') {
    const index = /^logicalTopic_(\d+)$/.exec(local.id);
    const topics = local.state.logicalTopicCandidates as Array<{ name: string }>;
    const value = index ? Number(topics[Number(index[1])].name.toLowerCase() === 'authentication') : Number(local.id !== 'independent');
    return { type: 'noul', noul: value ? .99 : 0 };
  }
  if (question.type !== 'choice') throw new Error('Unexpected benchmark score question');
  return choice(question, selection(local.state, local.id, question));
}
function provider(invalid = false) {
  let phase: CanonicalPhase = 'startup'; let document: string | undefined; const calls: Call[] = [];
  return { calls, phase: (next: CanonicalPhase, source?: string) => { phase = next; document = source; },
    decider: (key: string, state: unknown, questions: Record<string, JevQuestion>) => decideWithJev(key, state, questions, async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as { state: State; questions: Record<string, JevQuestion> };
      const decoded = resolveSharedQuestionTexts(wire.questions, wire.state.questionTexts);
      calls.push({ phase, document, state: wire.state, questions: decoded });
      const answers = Object.fromEntries(Object.entries(decoded).map(([id, question]) => [id, answer(wire.state, id, question)]));
      if (invalid && phase === 'file') answers.place = { type: 'choice', choice: 'A', confidence: .99, probabilities: { A: 1 } };
      return Response.json({ answers });
    }, { maxRetries: 0 }) };
}

it('applies definitions before memberships and exposes prior canonical filings to the next isolated public runtime job', async () => {
  const fixture = provider();
  const report = await runCanonicalFilingQueue({ sources, apiKey: 'offline-sdk-fixture', ...fixture, observe: async session => {
    const canvas = await new CanvasStore(session.root).getCanvas(session.canvasId);
    expect(canvas.blocks).toHaveLength(sources.length);
    for (const source of sources) {
      const native = session.ids.find(id => id.frozenId === source.id)!;
      const block = canvas.blocks.find(block => block.id === native.blockId)!;
      expect(block.content).toBe(source.content); expect(block.title).toBe(source.title);
      expect(block.incarnation).toBeTruthy(); expect(block.sourceGeneration).toBe(1);
      expect(block.group).toBe(source.manual ? 'custom:engineering' : 'custom:authentication');
      expect(block.jevOwnership?.[source.manual ? 'pins' : 'managed']).toContain('group');
    }
    const state = await new JevWorkspaceFiles(session.root).read(session.workspaceId);
    expect(state.jobs).toHaveLength(3);
    expect(state.jobs.every(job => job.request.action === 'file' && job.state === 'completed')).toBe(true);
    expect(state.vocabulary.filter(term => term.groupKey === 'custom:authentication' && term.state === 'active')).toHaveLength(1);
  } });
  expect(report.complete).toBe(true); expect(report.failures).toEqual([]);
  expect(report.rawFinalNativeGroups).toEqual([{ key: 'custom:authentication', members: ['sessions', 'credentials'] },
    { key: 'custom:engineering', members: ['manual'] }]);
  expect(fixture.calls.filter(call => call.phase === 'label' || call.phase === 'startup')).toEqual([]);
  const later = fixture.calls.find(call => call.document === 'credentials' && call.phase === 'file')!;
  expect(later.state.groups).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'custom:authentication',
    members: [expect.objectContaining({ title: 'Session access' })] })]));
  const filing = report.receipts.filter(receipt => receipt.action === 'file');
  const definition = report.proposals.find(proposal => proposal.mutation.kind === 'vocabulary' && proposal.mutation.term.groupKey === 'custom:authentication')!;
  expect(definition.state).toBe('applied');
  expect(filing[0].proposalId).toBe(definition.id);
  expect(filing).toHaveLength(3); expect(filing.every(receipt => receipt.automatic && receipt.state === 'applied')).toBe(true);
  const manual = report.rows.find(row => row.frozenId === 'manual')!;
  expect(report.proposals.some(proposal => proposal.action === 'file' && proposal.sources.some(source => source.blockId === manual.blockId))).toBe(false);
  for (const proposal of report.proposals.filter(proposal => proposal.action === 'file')) {
    expect(proposal.evidence.length).toBeGreaterThan(0);
    for (const evidence of proposal.evidence) {
      const row = report.rows.find(row => row.blockId === evidence.source.blockId)!;
      const source = sources.find(source => source.id === row.frozenId)!;
      expect(source.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
      expect(evidence.source.incarnation).toBe(row.source.incarnation);
      expect(evidence.source.contentHash).toBe(row.source.contentHash);
    }
  }
  expect(report).toMatchObject({ finalReloadVerified: true, projectionOnly: false, automaticDocumentPipeline: false });
  expect(report).toMatchObject({ initialSnapshot: { workspaceCount: 1, canvasCount: 1, documentCount: 3 }, sourceBodiesUnchanged: true });
  for (const row of report.rows) {
    const original = report.initialSnapshot.sources.find(source => source.blockId === row.blockId)!;
    expect(row.source.contentHash).toBe(original.contentHash);
    expect(row.source.incarnation).toBe(original.incarnation);
    expect(row.source.sourceGeneration).toBe(original.sourceGeneration);
  }
});

it('reports a strict SDK invalid-provider failure without committing a guessed filing or changing source bodies', async () => {
  const fixture = provider(true);
  const report = await runCanonicalFilingQueue({ sources: sources.slice(0, 2), apiKey: 'offline-sdk-fixture', ...fixture });
  expect(report.complete).toBe(false);
  expect(report.failures).toHaveLength(2);
  expect(report.failures.every(failure => failure.phase === 'file' && /probabilit|answer|criteria/i.test(failure.error))).toBe(true);
  expect(report.rows.every(row => row.finalGroup === 'custom:engineering' && row.job?.state === 'failed')).toBe(true);
  expect(report.receipts.filter(receipt => receipt.action === 'file')).toEqual([]);
  expect(report.proposals.filter(proposal => proposal.action === 'file')).toEqual([]);
  expect(fixture.calls.filter(call => call.phase === 'file')).toHaveLength(4);
  for (const row of report.rows) expect(row.job).toMatchObject({ attempts: 2 });
  expect(report.finalReloadVerified).toBe(true);
});
