import { expect, it } from 'vitest';
import { file } from '../../server/jev/actions/profile.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../server/jev.js';
import type { JevEvaluation } from '../../shared/jev-types.js';
import { atlasIds, broadStartContext, broadStartManifest, broadStartPrerequisites, broadStartReport, engineering, request } from './file-broad-start.mjs';

it('starts all twenty frozen Atlas sources in one existing Engineering group, with nineteen unchanged family keys', () => {
  const context = broadStartContext('managed', async () => { throw new Error('No provider permitted'); });
  const manifest = broadStartManifest(context);
  expect(context.documents.map(document => document.block.id)).toEqual(atlasIds);
  expect(context.vocabulary).toHaveLength(1);
  expect(context.vocabulary[0].members).toHaveLength(20);
  expect(context.documents.every(document => document.block.group === engineering.key)).toBe(true);
  expect(manifest.frozenFamilyKeys.flatMap(group => group.members)).toHaveLength(19);
  expect(context.vocabulary[0].definition).toBe(engineering.definition);
  expect(manifest.frozenFamilyKeys.find(group => group.key === engineering.key)!.definition)
    .toBe('Architecture, running and testing the app, errors, project history, and plans');
  expect(manifest.acceptableAlternates.architecture).toEqual(['custom:engineering', 'custom:documents']);
  expect(manifest.unscoredDocuments).toEqual(['README']);
  expect(manifest.candidates.every(row => row.alternatives.length <= 15)).toBe(true);
  for (const row of manifest.candidates) for (const group of row.alternatives) {
    expect(new Set(group.origins.map(origin => origin.source.blockId)).size).toBeGreaterThanOrEqual(2);
    expect(group.origins.some(origin => origin.source.blockId === row.document)).toBe(true);
    expect(group.origins.length).toBeLessThanOrEqual(4);
  }
});

it.each(['manual', 'pinned'] as const)('measures actual file() retention for %s initial memberships without a refinement request', async ownership => {
  let calls = 0;
  const context = broadStartContext(ownership, async (_key, _state, questions) => {
    calls++;
    return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      expect(['place', 'gate']).toContain(id);
      if (question.type !== 'choice') throw new Error('Unexpected question');
      return [id, { type: 'choice' as const, choice: 'A', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === 'A')])) }];
    }));
  });
  const before = JSON.stringify(context.documents);
  const result = await file(context, request);
  const report = broadStartReport(context, result);
  expect(result.proposals).toEqual([]);
  expect(calls).toBe(20);
  expect(JSON.stringify(context.documents)).toBe(before);
  expect(report.summary).toMatchObject({ retainedEngineering: 20, refined: 0, canonicalWrites: 0 });
  expect(report.summary.manualOrPinned).toHaveLength(20);
});

it('rejects fabricated evidence and definition-after-membership while reporting unmodified source-derived group names', () => {
  const context = broadStartContext('managed', async () => ({}));
  const source = context.documents[0];
  const passage = { source: source.snapshot, start: 0, end: 14, quote: source.block.content.slice(0, 14) };
  const term = { ...context.vocabulary[0], id: 'raw-topic', groupKey: 'custom:raw-source-name', name: 'Raw source name' };
  const membership: JevEvaluation['proposals'][number] = { action: 'file', title: 'Raw placement', explanation: 'Exact local source',
    sources: [source.snapshot], evidence: [passage], mutation: { kind: 'document', canvasId: source.canvasId,
      blockId: source.block.id, patch: { group: term.groupKey } } };
  const definition: JevEvaluation['proposals'][number] = { ...membership, mutation: { kind: 'vocabulary', operation: 'define', term } };
  const result = { result: { documents: {} }, proposals: [definition, membership] };
  const report = broadStartReport(context, result);
  expect(report.rows[0]).toMatchObject({ document: 'README', scored: false, proposed: 'custom:raw-source-name' });
  expect(report.summary.singletonGroups).toEqual([{ key: 'custom:raw-source-name', members: ['README'] }]);
  expect(report.rawProposals[0].mutation).toMatchObject({ term: { name: 'Raw source name' } });
  expect(() => broadStartReport(context, { ...result, proposals: [membership, definition] })).toThrow('define-before-membership');
  expect(() => broadStartReport(context, { ...result, proposals: [{ ...definition, evidence: [{ ...passage, quote: 'fabricated' }] }, membership] })).toThrow('exact evidence');
  expect(() => broadStartReport(context, { ...result, proposals: [definition, { ...membership, sources: [] }] })).toThrow('exact evidence');
});

it('runs actual profile and fresh-label prerequisites using production candidates, retaining exact sources and ownership in memory', async () => {
  let calls = 0;
  const context = broadStartContext('managed', async (_key, state, questions) => {
    calls++;
    expect(state).toHaveProperty('logicalTopicCandidates');
    return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul' as const, noul: 0 }];
      if (question.type !== 'choice') throw new Error('Unexpected question');
      return [id, { type: 'choice' as const, choice: 'none', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === 'none')])) }];
    }));
  });
  const before = structuredClone(context.documents);
  const phases: string[] = [];
  const prerequisites = await broadStartPrerequisites(context, phase => { phases.push(phase); });
  expect(phases).toEqual(['profile', 'label']);
  expect(calls).toBe(20);
  expect(prerequisites.profiled.proposals).toHaveLength(20);
  expect(prerequisites.labeled.proposals).toEqual([]);
  expect(Object.keys(prerequisites.indexes)).toHaveLength(20);
  expect(prerequisites.indexes['atlas:architecture']).toMatchObject({ calibration: 1, source: before[1].snapshot, topics: [] });
  expect(context.documents).toEqual(before);
});

it('applies actual label proposals in memory while retaining fresh profile indexes and the broad group', async () => {
  const context = broadStartContext('managed', async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul' as const, noul: .99 }];
    if (question.type !== 'choice') throw new Error('Unexpected question');
    const chosen = Object.hasOwn(question.criteria, 'p0') ? 'p0' : 'none';
    return [id, { type: 'choice' as const, choice: chosen, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === chosen)])) }];
  })));
  const before = context.documents.map(document => document.block.content);
  const result = await broadStartPrerequisites(context);
  expect(result.labeled.proposals.length).toBeGreaterThan(0);
  expect(context.documents.map(document => document.block.content)).toEqual(before);
  expect(context.documents.every(document => document.block.group === engineering.key)).toBe(true);
  for (const proposal of result.labeled.proposals) {
    if (proposal.mutation.kind !== 'document') throw new Error('Unexpected label mutation');
    const mutation = proposal.mutation;
    const document = context.documents.find(document => document.block.id === mutation.blockId)!;
    expect(document.block.tags).toEqual(mutation.patch.tags);
    expect(document.block.jevOwnership!.managed).toContain('tags');
    expect(document.snapshot.metadataRevision).toBe(2);
    expect(document.snapshot.sourceGeneration).toBe(1);
    expect(context.indexes![`atlas:${document.block.id}`]).toMatchObject({ calibration: 1, source: { contentHash: document.snapshot.contentHash } });
  }
});

function positiveProfileAnswers(questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: .99 }];
    if (question.type !== 'choice') throw new Error('Unexpected profile score question');
    const selected = Object.hasOwn(question.criteria, 'p0') ? 'p0' : Object.keys(question.criteria)[0];
    return [id, { type: 'choice', choice: selected, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) }];
  }));
}
it('holds one invalid per-document SDK profile while recording fresh indexes and labels for every unrelated success', async () => {
  const calls: string[] = []; const freshCounts: number[] = [];
  const context = broadStartContext('managed', (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions,
    async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as { state: { document: { id: string } }; questions: Record<string, JevQuestion> };
      calls.push(wire.state.document.id); freshCounts.push(Object.keys(context.indexes ?? {}).length);
      const answers = positiveProfileAnswers(wire.questions);
      if (wire.state.document.id === 'architecture') {
        const answer = answers.logicalTopicEvidence_0;
        if (answer.type !== 'choice') throw new Error('Expected the canonical profile evidence choice');
        delete answer.probabilities.none;
      }
      return Response.json({ answers });
    }, options));
  const original = structuredClone(context.documents.find(source => source.block.id === 'architecture'))!;
  const result = await broadStartPrerequisites(context);
  expect(calls).toEqual(atlasIds);
  expect(freshCounts.slice(0, 4)).toEqual([0, 1, 1, 2]);
  expect(result.failedProfiles).toEqual([{ document: 'architecture', status: 502,
    error: 'Jev returned an invalid answer for logicalTopicEvidence_0' }]);
  expect(result.successfulDocuments).toEqual(atlasIds.filter(id => id !== 'architecture'));
  expect(result.profiled.proposals).toHaveLength(19);
  expect(result.indexes['atlas:architecture']).toBeUndefined();
  expect(Object.keys(result.indexes)).toHaveLength(19);
  expect(result.labeled.proposals).toHaveLength(19);
  expect(result.labeled.proposals.some(proposal => proposal.mutation.kind === 'document' && proposal.mutation.blockId === 'architecture')).toBe(false);
  expect(context.documents.find(source => source.block.id === 'architecture')).toEqual(original);
  expect(context.documents.find(source => source.block.id === 'testing')!.snapshot.metadataRevision).toBe(2);
});
it('reports all failed profiles explicitly and performs no label decision or metadata mutation without a fresh index', async () => {
  const context = broadStartContext('managed', async () => { throw new Error('Offline invalid profile control'); });
  const before = structuredClone(context.documents); const phases: string[] = [];
  const result = await broadStartPrerequisites(context, phase => { phases.push(phase); });
  expect(phases).toEqual(['profile', 'label']);
  expect(result.failedProfiles.map(failure => failure.document)).toEqual(atlasIds);
  expect(result.successfulDocuments).toEqual([]);
  expect(result.profiled.proposals).toEqual([]); expect(result.labeled.proposals).toEqual([]);
  expect(result.indexes).toEqual({}); expect(context.documents).toEqual(before);
});
it('stops cancelled prerequisites rather than continuing to unrelated provider judgments', async () => {
  const controller = new AbortController(); let calls = 0;
  const context = broadStartContext('managed', async () => { calls++; controller.abort(); throw new Error('Cancelled fixture'); });
  context.signal = controller.signal;
  await expect(broadStartPrerequisites(context)).rejects.toThrow('Cancelled fixture');
  expect(calls).toBe(1); expect(context.indexes).toEqual({});
});
