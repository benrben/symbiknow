import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { JevValues, JevVocabularyTerm } from '../../../shared/jev-types.js';
import type { JevAnswer, JevDecider, JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { freshProfileLabelRejections, freshProfileTopics, logicalIndexQuestions, topicMembershipConfidence } from './logical-index.js';
import { label, profile } from './profile.js';

function source(content = '# Typography\n\nTypography uses readable sizes and consistent spacing.', title = 'Typography'): JevInputDocument {
  const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { canvasId: 'canvas', block: { id: 'source', file: 'source.md', title, kind: 'markdown', content,
    incarnation: 'original', sourceGeneration: 1, metadataRevision: 1, contentHash,
    x: 12, y: 34, width: 400, height: 300, links: [] },
    snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source', incarnation: 'original',
      sourceGeneration: 1, metadataRevision: 1, contentHash } };
}
function selected(question: Extract<JevQuestion, { type: 'choice' }>, choice: string): JevAnswer {
  return { type: 'choice', choice, confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) };
}
function term(name: string, definition = `Documents about ${name}`): JevVocabularyTerm {
  return { id: name.toLocaleLowerCase(), name, definition, kind: 'label', state: 'active', version: 1, aliases: [], members: [] };
}
function fixture(accepted = new Set(['Typography'])) {
  const document = source(); const start = document.block.content.indexOf('Typography uses');
  const evidence = { source: { ...document.snapshot }, start, end: document.block.content.length, quote: document.block.content.slice(start) };
  const index: JevValues = { version: 1, calibration: 1, source: { ...document.snapshot },
    topics: [{ name: 'Typography', confidence: .8, evidence: [evidence] }], decisions: [] };
  const decider = vi.fn<JevDecider>(async (_key, state, questions) => {
    const candidates = (state as { labelCandidates: Array<{ name: string }> }).labelCandidates;
    return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      const name = candidates[Number(id.split('_')[1])].name;
      if (question.type === 'noul') return [id, { type: 'noul', noul: accepted.has(name) ? .99 : .01 }];
      if (question.type !== 'choice') throw new Error('A label must ask binary membership and exact evidence');
      return [id, selected(question, accepted.has(name) ? 'p1' : 'none')];
    }));
  });
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [document], vocabulary: [], tasks: [],
    canvases: [{ id: 'canvas', name: 'Reading' }], settings: emptyJevWorkspace().settings, confidenceThreshold: .7,
    apiKey: 'local-fixture', decider, indexes: { 'canvas:source': index } };
  return { document, context, index, evidence, decider, request: { action: 'label' as const, canvasId: 'canvas', blockIds: ['source'] } };
}
function cachedTopic(index: JevValues): JevValues { return (index.topics as JevValues[])[0]; }

it('keeps catalog definitions in nominated questions and accepted profile topics with exact evidence', async () => {
  const f = fixture(); f.document = source('# Security guide\n\nAuthentication protects session access.', 'Security guide');
  f.context.documents = [f.document];
  f.context.decider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: .99 }];
    if (question.type !== 'choice') throw new Error('Unexpected profile score');
    return [id, selected(question, id === 'role' ? Object.keys(question.criteria)[0] : 'p1')];
  }));
  const questions = logicalIndexQuestions(f.context, f.document);
  expect(questions.state.logicalTopicCandidates).toContainEqual(expect.objectContaining({ name: 'Security', definition: expect.stringContaining('authentication') }));
  expect(questions.questions.logicalTopic_0.instructions).toContain('; scope:');
  const result = await profile(f.context, { ...f.request, action: 'profile' });
  const mutation = result.proposals[0].mutation;
  expect(mutation).toMatchObject({ kind: 'derived', values: { logicalIndex: { topics: expect.arrayContaining([expect.objectContaining({ name: 'Security',
    definition: expect.stringContaining('authentication'), origin: 'semantic_category_catalog' })]) } } });
  if (mutation.kind !== 'derived') throw new Error('Expected a derived profile');
  f.context.indexes = { 'canvas:source': mutation.values.logicalIndex as JevValues };
  expect(freshProfileTopics(f.context, f.document)?.[0]).toMatchObject({ name: 'Security', definition: expect.stringContaining('authentication'),
    evidence: [{ source: f.document.snapshot, quote: 'Authentication protects session access.' }] });
});

type CacheChange = (index: JevValues) => void;
const invalidCaches: Array<[string, CacheChange]> = [
  ['missing topics', index => { delete index.topics; }],
  ['non-array topics', index => { index.topics = 'untrusted'; }],
  ['wrong profile version', index => { index.version = 2; }],
  ['uncalibrated profile', index => { index.calibration = 0; }],
  ['absent profile source', index => { delete index.source; }],
  ['foreign source identity', index => { (index.source as JevValues).workspaceId = 'foreign'; }],
  ['non-record topic', index => { index.topics = [null]; }],
  ['blank topic name', index => { cachedTopic(index).name = ' '; }],
  ['non-string topic name', index => { cachedTopic(index).name = 12; }],
  ['missing topic confidence', index => { delete cachedTopic(index).confidence; }],
  ['invalid topic confidence', index => { cachedTopic(index).confidence = 1.1; }],
  ['non-array evidence', index => { cachedTopic(index).evidence = 'not a certificate'; }],
  ['non-record evidence', index => { cachedTopic(index).evidence = [null, 'not a certificate']; }],
  ['foreign evidence identity', index => { const evidence = (cachedTopic(index).evidence as JevValues[])[0]; (evidence.source as JevValues).incarnation = 'recreated'; }],
  ['non-string quotation', index => { (cachedTopic(index).evidence as JevValues[])[0].quote = 12; }],
  ['negative offset', index => { (cachedTopic(index).evidence as JevValues[])[0].start = -1; }],
  ['fractional offset', index => { (cachedTopic(index).evidence as JevValues[])[0].start = .5; }],
  ['non-numeric offset', index => { (cachedTopic(index).evidence as JevValues[])[0].end = 'end'; }],
  ['reversed offsets', index => { const evidence = (cachedTopic(index).evidence as JevValues[])[0]; evidence.end = evidence.start; }],
  ['out-of-body offsets', index => { (cachedTopic(index).evidence as JevValues[])[0].end = 9999; }],
  ['invented quotation', index => { (cachedTopic(index).evidence as JevValues[])[0].quote = 'Invented source'; }],
];
it.each(invalidCaches)('rejudges %s against current source instead of trusting the cached certificate', async (_name, change) => {
  const f = fixture(); const expectedEvidence = structuredClone(f.evidence); change(f.index); const before = structuredClone(f.document);
  expect(freshProfileTopics(f.context, f.document)).toBeUndefined();
  const result = await label(f.context, f.request);
  expect(f.decider).toHaveBeenCalledOnce();
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0]).toMatchObject({ mutation: { kind: 'document', patch: { tags: ['Typography'] } }, sources: [f.document.snapshot], evidence: [expectedEvidence] });
  expect(f.document).toEqual(before);
});

it('rejudges a changed active definition and preserves its current scope in candidate provenance', async () => {
  const f = fixture(); const existing = term('Typography', 'Readable type sizes and spacing'); f.context.vocabulary = [existing];
  cachedTopic(f.index).definition = existing.definition;
  expect(freshProfileTopics(f.context, f.document)?.[0].definition).toBe(existing.definition);
  existing.definition = 'Typography used only in printed catalogues'; existing.version++;
  const result = await label(f.context, f.request);
  expect(f.decider).toHaveBeenCalledOnce();
  expect(f.decider.mock.calls[0][1]).toMatchObject({ labelCandidates: [{ name: 'Typography', definition: existing.definition }] });
  expect(result.result.documents).toMatchObject({ source: { options: [{ origin: 'validated_definition', definition: existing.definition }] } });
});

it('removes duplicate cached negatives once while preserving owner tags without querying a provider', async () => {
  const f = fixture(); f.document.block.tags = ['Old subject', 'Owner tag']; f.index.topics = [];
  f.index.decisions = [{ name: 'Old subject', confidence: .1 }, { name: 'Old subject', confidence: .2 }];
  const result = await label(f.context, f.request);
  expect(f.decider).not.toHaveBeenCalled();
  expect(result.proposals[0]).toMatchObject({ mutation: { kind: 'document', patch: { tags: ['Owner tag'] } }, decisionConfidences: [.9], evidence: [] });
});

it.each([
  ['missing name', { confidence: .1 }], ['non-string name', { name: 1, confidence: .1 }],
  ['absent member label', { name: 'Not present', confidence: .1 }], ['invalid confidence', { name: 'Owner tag', confidence: 1.1 }],
  ['missing confidence', { name: 'Owner tag' }], ['ambiguous rejection', { name: 'Owner tag', confidence: .5 }],
  ['changed definition', { name: 'Owner tag', confidence: .1, definition: 'Earlier scope' }],
] satisfies Array<[string, JevValues]>)('preserves a current label after a %s negative profile decision', async (_name, decision) => {
  const f = fixture(); f.document.block.tags = ['Owner tag']; f.index.topics = []; f.index.decisions = [decision];
  f.context.vocabulary = [term('Owner tag', 'Current scope')];
  expect(freshProfileLabelRejections(f.context, f.document)).toEqual([]);
  expect((await label(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).not.toHaveBeenCalled();
  expect(f.document.block.tags).toEqual(['Owner tag']);
});

it.each(['calibration', 'source', 'decisions'] as const)('declines negative cache reuse when %s is unavailable', field => {
  const f = fixture(); f.document.block.tags = ['Owner tag']; f.index.decisions = [{ name: 'Owner tag', confidence: .1 }];
  delete f.index[field];
  expect(freshProfileLabelRejections(f.context, f.document)).toEqual([]);
  expect(f.document.block.tags).toEqual(['Owner tag']);
});

it('uses indexed catalog topics for fallback nominations and preserves explicit removal ownership', async () => {
  const f = fixture(new Set(['Security'])); f.document = source('# Unrelated caption\n\nAuthentication protects session access.', 'Unrelated caption');
  f.context.documents = [f.document];
  f.index = { version: 1, topics: [{ name: 'Security', confidence: .99 }, { name: 'Stale caption', confidence: .99 }] };
  f.context.indexes = { 'canvas:source': f.index };
  const result = await label(f.context, f.request);
  expect(f.decider.mock.calls[0][1]).toMatchObject({ labelCandidates: [{ name: 'Security', definition: expect.stringContaining('authentication') }] });
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: ['Security'] } });
  f.document.block.jevOwnership = { managed: ['tags'], pins: [], removedLabels: ['SECURITY'], removedLinks: [] };
  f.decider.mockClear();
  expect((await label(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).not.toHaveBeenCalled();
});

it('rejects malformed provider membership at the public label boundary before producing source mutations', async () => {
  const f = fixture(); delete f.context.indexes;
  f.context.decider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) =>
    [id, question.type === 'noul' ? { type: 'noul', noul: 1.1 } : selected(question as Extract<JevQuestion, { type: 'choice' }>, 'p1')]));
  const before = structuredClone(f.document);
  await expect(label(f.context, f.request)).rejects.toMatchObject({ status: 502 });
  expect(f.document).toEqual(before);
  expect(topicMembershipConfidence(undefined)).toBeUndefined();
});

it('profiles meaningful people separately from incidental entities and preserves an unsupported role as unknown', async () => {
  const f = fixture(); f.document = source('# Typography\n\nZoe manages type sizes. Widget is mentioned only as a passing reference.');
  f.context.documents = [f.document];
  f.context.settings.people = [{ id: 'zoe', name: 'Zoe', role: 'Designer' }, { id: 'absent', name: 'Absent', role: 'Reviewer' }];
  f.context.vocabulary = [{ ...term('Widget'), kind: 'entity' }, { ...term('Typography'), kind: 'entity', state: 'retired' }];
  const decider = vi.fn<JevDecider>(async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'entity_0' ? .99 : .01 }];
    if (question.type !== 'choice') throw new Error('Unexpected profile question');
    return [id, selected(question, 'none')];
  })));
  f.context.decider = decider;
  const before = structuredClone(f.document);
  const result = await profile(f.context, { ...f.request, action: 'profile' });
  expect(decider).toHaveBeenCalledOnce();
  expect(decider.mock.calls[0][1]).toMatchObject({ entityCandidates: [
    { id: 'zoe', name: 'Zoe', kind: 'person' }, { id: 'widget', name: 'Widget', kind: 'entity' },
  ] });
  expect(Object.keys(decider.mock.calls[0][2]).filter(id => id.startsWith('entity_'))).toEqual(['entity_0', 'entity_1']);
  expect(result.proposals[0]).toMatchObject({ mutation: { kind: 'derived', values: {
    role: 'unknown', entities: [{ id: 'zoe', name: 'Zoe', kind: 'person' }], keyPassages: [], logicalIndex: { topics: [] },
  } }, evidence: [] });
  expect(f.document).toEqual(before);
});
