import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { decideWithJev, type JevAnswer, type JevDecider, type JevQuestion } from '../../jev.js';
import type { JevVocabularyTerm } from '../../../shared/jev-types.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { canvasTopicCatalog } from './group-topics.js';
import { file } from './profile.js';

function document(id: string, title: string, content: string): JevInputDocument {
  const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { canvasId: 'canvas', block: { id, title, content, file: `${id}.md`, kind: 'markdown',
    group: 'custom:engineering', x: 12, y: 34, width: 400, height: 300, links: [],
    incarnation: id, sourceGeneration: 1, metadataRevision: 1, contentHash,
    jevOwnership: { managed: ['group'], pins: [], removedLabels: [], removedLinks: [] } },
    snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id, incarnation: id,
      sourceGeneration: 1, metadataRevision: 1, contentHash } };
}
function pick(question: Extract<JevQuestion, { type: 'choice' }>, choice: string): JevAnswer {
  return { type: 'choice', choice, confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) };
}
function questionState(state: unknown, id: string): { state: unknown; id: string } {
  let local = state; let name = id; let match = /^(\d+)__(.+)$/.exec(name);
  while (match) { local = (local as { questionSets: unknown[] }).questionSets[Number(match[1])]; name = match[2]; match = /^(\d+)__(.+)$/.exec(name); }
  return { state: local, id: name };
}
function fixture() {
  const member = document('sessions', 'Session access', '# Session access\n\n## Authentication\n\nAuthentication verifies user identity before issuing a session.');
  const peer = document('credentials', 'Credential validation', '# Credential validation\n\n## Authentication\n\nAuthentication verifies passwords and rotates credentials safely.');
  const broad: JevVocabularyTerm = { id: 'engineering', kind: 'group', state: 'active', version: 1, name: 'Engineering',
    definition: 'Building and maintaining software, databases, APIs, infrastructure, testing and reliability.',
    groupKey: 'custom:engineering', aliases: [], members: [member, peer].map(item => ({ canvasId: item.canvasId, blockId: item.block.id })) };
  const decider = vi.fn<JevDecider>(async (_key, state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: .99 }];
    const local = questionState(state, id);
    if (question.type !== 'choice') throw new Error('Unexpected grouping question');
    const candidateState = local.state as { groups?: Array<{ key: string; option: string }> };
    const preferred = candidateState.groups?.find(group => group.key === 'custom:authentication') ?? candidateState.groups?.[0];
    const choice = ['place', 'gate'].includes(local.id) ? preferred?.option ?? 'none'
      : local.id === 'group' ? Object.keys(question.criteria).find(key => question.criteria[key].includes('(custom:authentication)')) ?? 'none'
      : Object.keys(question.criteria).find(key => /Authentication (verifies|checks)/.test(question.criteria[key])) ?? 'none';
    return [id, pick(question, choice)];
  })));
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [member, peer], vocabulary: [broad], tasks: [],
    canvases: [{ id: 'canvas', name: 'Engineering' }], settings: emptyJevWorkspace().settings,
    confidenceThreshold: .7, apiKey: 'local-fixture', decider };
  return { member, peer, broad, context, decider, request: { action: 'file' as const, canvasId: 'canvas', blockIds: ['sessions'] } };
}

it('nominates a repeated local subject with exact provenance instead of one private title group per document', () => {
  const f = fixture(); const candidates = canvasTopicCatalog(f.context, f.member);
  expect(candidates.map(group => group.key)).toEqual(['custom:authentication']);
  expect(candidates[0].origins.map(origin => origin.source.blockId)).toEqual(['sessions', 'credentials']);
  for (const passage of candidates[0].origins) {
    const source = f.context.documents.find(item => item.block.id === passage.source.blockId)!;
    expect(passage.source).toEqual(source.snapshot);
    expect(source.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  }
});

it('considers a narrower shared subject when the broad current group wins and requires local evidence before refinement', async () => {
  const f = fixture(); const before = structuredClone(f.context.documents);
  const result = await file(f.context, f.request);
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document');
  expect(membership).toMatchObject({ mutation: { kind: 'document', blockId: 'sessions', patch: { group: 'custom:authentication' } },
    sources: [f.member.snapshot], evidence: [expect.objectContaining({ source: f.member.snapshot,
      quote: 'Authentication verifies user identity before issuing a session.' })] });
  expect(result.proposals.some(proposal => proposal.mutation.kind === 'vocabulary' && proposal.mutation.term.groupKey === 'custom:authentication')).toBe(true);
  expect(f.decider.mock.calls.some(([, state]) => {
    const groups = (state as { groups?: Array<{ key: string }> }).groups;
    return groups?.some(group => group.key === 'custom:engineering') && groups.some(group => group.key === 'custom:authentication');
  })).toBe(true);
  expect(f.context.documents).toEqual(before);
});

function transformAnswers(f: ReturnType<typeof fixture>, transform: (id: string, answer: JevAnswer, question: JevQuestion, state: unknown) => JevAnswer) {
  f.context.decider = async (key, state, questions, fetcher, options) => {
    const answers = await f.decider(key, state, questions, fetcher, options);
    return Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
      const local = questionState(state, id);
      return [id, transform(local.id, answer, questions[id], local.state)];
    }));
  };
}
it.each(['current', 'none'] as const)('retains the current broad group when the refinement comparison chooses %s', async outcome => {
  const f = fixture();
  transformAnswers(f, (id, answer, question, state) => {
    const groups = (state as { groups?: unknown[] }).groups;
    return groups?.length === 2 && ['place', 'gate'].includes(id) && question.type === 'choice'
      ? pick(question, outcome === 'current' ? 'A' : 'none') : answer;
  });
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledTimes(2);
  expect(f.member.block.group).toBe('custom:engineering');
});

it.each(['coherent', 'purpose', 'evidence'] as const)('retains current membership if the selected refinement fails its %s check', async check => {
  const f = fixture();
  transformAnswers(f, (id, answer, question) => {
    if (check === 'coherent' && id === 'coherent' || check === 'purpose' && id.startsWith('purpose_')) return { type: 'noul', noul: .69 };
    return check === 'evidence' && id === 'evidence' && question.type === 'choice' ? pick(question, 'none') : answer;
  });
  const before = structuredClone(f.context.documents);
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledTimes(3);
  expect(f.context.documents).toEqual(before);
});

it.each(['pinned', 'manual'] as const)('preserves a %s current group without asking speculative refinement questions', async ownership => {
  const f = fixture();
  if (ownership === 'pinned') f.member.block.jevOwnership!.pins.push('group');
  else f.member.block.jevOwnership!.managed = [];
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledOnce();
  expect(f.member.block.group).toBe('custom:engineering');
});

it('does not turn a single document’s headings or title into a refinement group', async () => {
  const f = fixture(); f.context.documents = [f.member];
  expect(canvasTopicCatalog(f.context, f.member).some(group => group.key === 'custom:session_access')).toBe(true);
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledOnce();
});

it.each(['foreign canvas', 'foreign workspace', 'changed body', 'changed generation', 'archived', 'excluded'] as const)
('does not refine from %s peer provenance', async invalid => {
  const f = fixture();
  if (invalid === 'foreign canvas') { f.peer.canvasId = 'other'; f.peer.snapshot.canvasId = 'other'; }
  if (invalid === 'foreign workspace') f.peer.snapshot.workspaceId = 'other';
  if (invalid === 'changed body') f.peer.block.content += '\nFreshly edited source without a reviewed profile.';
  if (invalid === 'changed generation') f.peer.block.sourceGeneration!++;
  if (invalid === 'archived') f.peer.block.archived = true;
  if (invalid === 'excluded') f.peer.block.processingExcluded = true;
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledOnce();
});

it.each([[.69, false], [.7, true]] as const)('keeps the unchanged semantic coherence cutoff for shared refinement (%s)', async (value, accepted) => {
  const f = fixture();
  transformAnswers(f, (id, answer) => id === 'coherent' ? { type: 'noul', noul: value } : answer);
  const result = await file(f.context, f.request);
  expect(result.proposals.some(proposal => proposal.mutation.kind === 'document')).toBe(accepted);
  if (accepted) expect(result.proposals.every(proposal => proposal.decisionConfidences?.includes(.7))).toBe(true);
});

it('keeps selective assessments limited to the winning shared candidate and its selected local passage', async () => {
  const f = fixture(); f.context.selectiveGroupAssessment = true;
  const result = await file(f.context, f.request);
  expect(result.proposals.some(proposal => proposal.mutation.kind === 'document')).toBe(true);
  expect(f.decider).toHaveBeenCalledTimes(6);
  expect(Object.keys(f.decider.mock.calls[2][2])).toEqual(['evidence']);
  const semantic = f.decider.mock.calls[3];
  expect(Object.keys(semantic[2])).toEqual(['coherent', 'purpose_2']);
  expect(semantic[1]).toMatchObject({ selectedGroup: { key: 'custom:authentication' },
    localEvidence: expect.arrayContaining([expect.objectContaining({ quote: 'Authentication verifies user identity before issuing a session.' })]) });
  expect(Object.keys(f.decider.mock.calls[4][2])).toEqual(['evidence']);
  expect(Object.keys(f.decider.mock.calls[5][2])).toEqual(['purpose_2']);
  expect(f.decider.mock.calls[5][1]).toMatchObject({ source: { id: 'credentials' } });
});

function updateSource(source: JevInputDocument, content: string): void {
  source.block.content = content;
  source.block.contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  source.snapshot.contentHash = source.block.contentHash;
}
it.each([false, true])('preserves subgroup containment checks during shared refinement (contained=%s)', async contained => {
  const f = fixture();
  updateSource(f.member, '# Engineering\n\n## Backend\n\nEngineering Backend defines persistent API contracts for the service.');
  updateSource(f.peer, '# Engineering\n\n## Backend\n\nEngineering Backend defines durable database contracts for the service.');
  transformAnswers(f, (id, answer, question, state) => {
    if (id.startsWith('containment_')) return { type: 'noul', noul: contained ? .99 : .69 };
    if (question.type !== 'choice') return answer;
    if (['place', 'gate'].includes(id)) {
      const groups = (state as { groups: Array<{ key: string; option: string }> }).groups;
      const choice = groups.find(group => group.key === 'custom:engineering/backend')?.option ?? groups[0].option;
      return pick(question, choice);
    }
    return id === 'evidence' ? pick(question, Object.keys(question.criteria).find(key => question.criteria[key].includes('Engineering Backend defines'))!) : answer;
  });
  const result = await file(f.context, f.request);
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document');
  expect(Boolean(membership)).toBe(contained);
  expect(Object.keys(f.decider.mock.calls[2][2])).toContain('containment_2');
  expect(f.decider.mock.calls[2][1]).toMatchObject({ selectedGroup: {
    parent: { key: 'custom:engineering', name: 'Engineering' }, reusableTaxonomy: true,
  } });
  if (contained) {
    expect(membership).toMatchObject({ mutation: { patch: { group: 'custom:engineering/backend' } },
      evidence: [{ source: f.member.snapshot, quote: 'Engineering Backend defines persistent API contracts for the service.' }] });
    expect(membership!.decisionConfidences).toEqual([1, .99, .99, .99, .99, .99]);
  } else expect(result.proposals).toEqual([]);
});

it('bounds shared refinement competition to sixteen options and retains compact exact-source provenance', async () => {
  const f = fixture();
  const captions = Array.from({ length: 12 }, (_, index) => `Caption ${index} · Shared topic ${index} covers durable service contracts.`);
  const terms = Array.from({ length: 8 }, (_, index) => `Subject ${index}`);
  const body = `# Sources\n\n${captions.join('\n\n')}\n\n${terms.join(', ')} describe reusable service subjects.`;
  updateSource(f.member, body); updateSource(f.peer, body.replace('durable service', 'persistent service'));
  f.context.indexes = Object.fromEntries(f.context.documents.map(source => {
    const quote = source.block.content.split('\n\n').at(-1)!;
    const start = source.block.content.indexOf(quote);
    return [`canvas:${source.block.id}`, { version: 1, topics: terms.map(name => ({ name,
      definition: `Reusable service subject ${name}`, confidence: .99,
      evidence: [{ source: { ...source.snapshot }, start, end: start + quote.length, quote }] })) }];
  }));
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledTimes(2);
  const comparison = f.decider.mock.calls[1];
  const groups = (comparison[1] as { groups: Array<{ key: string; origins?: unknown }> }).groups;
  expect(groups).toHaveLength(16);
  expect(groups[0].key).toBe('custom:engineering');
  expect(Object.keys((comparison[2].place as Extract<JevQuestion, { type: 'choice' }>).criteria)).toHaveLength(17);
  for (const group of groups.slice(1)) {
    expect(group.origins).toBeUndefined();
  }
  const local = canvasTopicCatalog(f.context, f.member).filter(group => groups.some(selected => selected.key === group.key));
  expect(local.every(group => group.origins.length <= 4)).toBe(true);
  expect(local.every(group => new Set(group.origins.map(origin => origin.source.blockId)).size === 2)).toBe(true);
});

it('keeps authorized linked cross-canvas nominations out of local shared refinement', async () => {
  const f = fixture(); f.peer.canvasId = 'other'; f.peer.snapshot.canvasId = 'other';
  f.context.canvases.push({ id: 'other', name: 'Credential reference' });
  f.member.block.crossLinks = [{ canvasId: 'other', blockId: f.peer.block.id }];
  f.context.indexes = Object.fromEntries(f.context.documents.map(source => {
    const quote = source.block.content.split('\n\n').at(-1)!; const start = source.block.content.indexOf(quote);
    return [`${source.canvasId}:${source.block.id}`, { version: 1, topics: [{ name: 'Authentication', definition: 'Verifying user identity',
      confidence: .99, evidence: [{ source: { ...source.snapshot }, start, end: start + quote.length, quote }] }] }];
  }));
  const nomination = canvasTopicCatalog(f.context, f.member).find(group => group.key === 'custom:authentication');
  expect(new Set(nomination!.origins.map(origin => origin.source.canvasId))).toEqual(new Set(['canvas', 'other']));
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledOnce();
});

it('requires a canonical peer incarnation rather than trusting an unstamped legacy nomination', async () => {
  const f = fixture(); delete f.peer.block.incarnation;
  expect(canvasTopicCatalog(f.context, f.member)[0].origins).toHaveLength(2);
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledOnce();
});

it('preserves the member’s exact proof when a shared subject has more than four sources', async () => {
  const f = fixture();
  const peers = Array.from({ length: 6 }, (_, index) => document(`peer-${index}`, `Credential policy ${index}`,
    `# Credential policy ${index}\n\n## Authentication\n\nAuthentication checks account credentials according to policy ${index}.`));
  f.context.documents = [...peers, f.member];
  const nomination = canvasTopicCatalog(f.context, f.member).find(group => group.key === 'custom:authentication')!;
  expect(nomination.origins).toHaveLength(4);
  expect(nomination.origins[0].source).toEqual(f.member.snapshot);
  expect(new Set(nomination.origins.map(origin => origin.source.blockId)).size).toBe(4);
  const result = await file(f.context, f.request);
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')).toMatchObject({
    sources: [f.member.snapshot], mutation: { patch: { group: 'custom:authentication' } },
  });
});


it('wires shared refinement through the shipped SDK request and typed-response boundary', async () => {
  const f = fixture(); const requests: Array<{ state: unknown; questions: Record<string, JevQuestion> }> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { state: unknown; questions: Record<string, JevQuestion> };
    requests.push(body);
    const answers = await f.decider('local-fixture', body.state, body.questions);
    return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.context.decider = (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, fetcher, options);
  const result = await file(f.context, f.request);
  expect(requests).toHaveLength(4);
  expect(Object.keys(requests[0].questions)).toEqual(['place', 'gate']);
  expect(requests[1].state).toMatchObject({ currentGroup: 'custom:engineering', groups: [
    expect.objectContaining({ key: 'custom:engineering' }), expect.objectContaining({ key: 'custom:authentication' }),
  ] });
  expect(JSON.stringify(requests[1].state)).not.toContain('origins');
  expect(JSON.stringify(requests[1].state)).not.toContain('incarnation');
  expect(Object.keys(requests[2].questions)).toEqual(['evidence', 'coherent', 'purpose_0', 'purpose_1', 'purpose_2']);
  expect(Object.keys(requests[3].questions)).toEqual(['evidence', 'purpose_0', 'purpose_1', 'purpose_2']);
  expect(requests[3].state).toMatchObject({ source: { id: 'credentials' } });
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')).toMatchObject({
    mutation: { patch: { group: 'custom:authentication' } }, sources: [f.member.snapshot],
  });
});

function sourceSubjectFixture() {
  const f = fixture(); f.context.documents = [f.member];
  const quote = 'Authentication verifies user identity before issuing a session.';
  const start = f.member.block.content.indexOf(quote);
  const evidence = { source: { ...f.member.snapshot }, start, end: start + quote.length, quote };
  const index = { version: 1, calibration: 1, source: { ...f.member.snapshot }, topics: [{ name: 'Authentication',
    definition: 'Verifying user identity before granting access', confidence: .99, evidence: [evidence] }] };
  f.context.indexes = { 'canvas:sessions': index };
  return { ...f, index };
}
it.each([false, true])('allows a checked meaningful singleton subject only through reusable-taxonomy and own-purpose validation (selective=%s)', async selective => {
  const f = sourceSubjectFixture(); f.context.selectiveGroupAssessment = selective;
  const result = await file(f.context, f.request);
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document');
  expect(membership).toMatchObject({ mutation: { patch: { group: 'custom:authentication' } }, sources: [f.member.snapshot] });
  const comparison = f.decider.mock.calls[1][1] as { groups: Array<{ key: string; nomination?: string; origins?: unknown }> };
  const subject = comparison.groups.find(group => group.key === 'custom:authentication')!;
  expect(subject.nomination).toBe('source_subject');
  expect(subject.origins).toBeUndefined();
  expect(canvasTopicCatalog(f.context, f.member, { sourceSubjects: true }).find(group => group.key === subject.key)!.origins[0].source).toEqual(f.member.snapshot);
  const coherence = f.decider.mock.calls.flatMap(call => Object.entries(call[2])).find(([id]) => id === 'coherent')![1];
  expect(coherence.instructions).toContain('reusable');
  expect(coherence.instructions).toContain('per-document');
});
it.each(['calibration', 'source', 'body', 'confidence'] as const)('rejects an untrusted singleton profile (%s) without refinement calls', async invalid => {
  const f = sourceSubjectFixture();
  if (invalid === 'calibration') f.index.calibration = 0;
  if (invalid === 'source') f.index.source.incarnation = 'foreign';
  if (invalid === 'body') f.index.topics[0].evidence[0].quote = 'Unsupported quotation';
  if (invalid === 'confidence') f.index.topics[0].confidence = .1;
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledOnce();
});
it('does not create a per-document folder after the provider rejects singleton taxonomy coherence', async () => {
  const f = sourceSubjectFixture(); f.index.topics[0].name = 'Session access';
  transformAnswers(f, (id, answer, question, state) => {
    if (id === 'coherent') return { type: 'noul', noul: .69 };
    if (question.type === 'choice' && ['place', 'gate'].includes(id)) {
      const groups = (state as { groups: Array<{ key: string; option: string }> }).groups;
      return pick(question, groups.find(group => group.key === 'custom:session_access')?.option ?? groups[0].option);
    }
    return answer;
  });
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledTimes(3);
  expect(f.member.block.group).toBe('custom:engineering');
});

it('refines an ungrouped document before its first placement instead of saving the broad winner', async () => {
  const f = sourceSubjectFixture(); delete f.member.block.group;
  const before = structuredClone(f.member);
  const result = await file(f.context, f.request);
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document');
  expect(membership).toMatchObject({ mutation: { patch: { group: 'custom:authentication' } }, sources: [f.member.snapshot] });
  expect(result.proposals.filter(proposal => proposal.mutation.kind === 'document')).toHaveLength(1);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'vocabulary', term: { groupKey: 'custom:authentication' } });
  expect(f.decider.mock.calls[1][1]).toMatchObject({ currentGroup: null, baselineGroup: 'custom:engineering' });
  expect(f.decider).toHaveBeenCalledTimes(3);
  expect(f.member).toEqual(before);
});

it.each(['none', 'baseline', 'failed taxonomy'] as const)('keeps first placement’s original evidence guard after refinement chooses %s', async outcome => {
  const f = sourceSubjectFixture(); delete f.member.block.group;
  transformAnswers(f, (id, answer, question, state) => {
    const groups = (state as { groups?: unknown[] }).groups;
    if (groups?.length === 2 && ['place', 'gate'].includes(id) && question.type === 'choice') {
      return outcome === 'failed taxonomy' ? answer : pick(question, outcome === 'none' ? 'none' : 'A');
    }
    return outcome === 'failed taxonomy' && id === 'coherent' ? { type: 'noul', noul: .69 } : answer;
  });
  const result = await file(f.context, f.request);
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0]).toMatchObject({ mutation: { kind: 'document', patch: { group: 'custom:engineering' } },
    sources: [f.member.snapshot], evidence: [{ source: f.member.snapshot, quote: 'Authentication verifies user identity before issuing a session.' }] });
  expect(f.decider).toHaveBeenCalledTimes(outcome === 'failed taxonomy' ? 5 : 4);
  expect(Object.keys(f.decider.mock.calls.at(-1)![2])).toEqual(['purpose_2']);
  expect(f.member.block.group).toBeUndefined();
});

it('does not save the fallback broad group when first placement has no exact local evidence', async () => {
  const f = sourceSubjectFixture(); delete f.member.block.group;
  transformAnswers(f, (id, answer, question, state) => {
    const localId = id.split('__').at(-1)!;
    if (localId === 'evidence' && question.type === 'choice') return pick(question, 'none');
    const groups = (state as { groups?: unknown[] }).groups;
    return groups?.length === 2 && ['place', 'gate'].includes(localId) && question.type === 'choice' ? pick(question, 'none') : answer;
  });
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider.mock.calls[2][1]).toMatchObject({ selectedGroup: { key: 'custom:engineering' } });
  expect(f.member.block.group).toBeUndefined();
});

it.each(['missing ownership', 'not managed yet'] as const)('refines a normal first placement with %s when the empty group is not pinned', async ownership => {
  const f = sourceSubjectFixture(); delete f.member.block.group;
  if (ownership === 'missing ownership') delete f.member.block.jevOwnership;
  else f.member.block.jevOwnership!.managed = [];
  const before = structuredClone(f.member);
  const result = await file(f.context, f.request);
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')).toMatchObject({
    mutation: { patch: { group: 'custom:authentication' } }, sources: [f.member.snapshot],
  });
  expect(f.decider).toHaveBeenCalledTimes(3);
  expect(f.member).toEqual(before);
});
it('does not acquire a new source-subject group while an empty group is explicitly pinned', async () => {
  const f = sourceSubjectFixture(); delete f.member.block.group;
  f.member.block.jevOwnership!.managed = []; f.member.block.jevOwnership!.pins = ['group'];
  const result = await file(f.context, f.request);
  expect(f.decider).toHaveBeenCalledTimes(3);
  expect(result.proposals.some(proposal => proposal.mutation.kind === 'vocabulary')).toBe(false);
  expect(f.decider.mock.calls.some(call => Object.keys(call[2]).includes('coherent'))).toBe(false);
  expect(f.member.block.group).toBeUndefined();
  expect(f.member.block.jevOwnership!.pins).toEqual(['group']);
});


function familyFixture() {
  const f = fixture();
  reviewedSubjects(f);
  return f;
}
function reviewedSubjects(f: ReturnType<typeof fixture>, name: (source: JevInputDocument) => string = () => 'Authentication') {
  f.context.indexes = Object.fromEntries(f.context.documents.map(source => {
    const quote = source.block.content.split('\n\n').at(-1)!; const start = source.block.content.indexOf(quote);
    return [`canvas:${source.block.id}`, { version: 1, calibration: 1, source: { ...source.snapshot },
      topics: [{ name: name(source), definition: 'A checked substantive source subject', confidence: .99,
        evidence: [{ source: { ...source.snapshot }, start, end: start + quote.length, quote }] }] }];
  }));
}
it('requires an independently verified peer main purpose before claiming a useful shared family', async () => {
  const f = familyFixture();
  transformAnswers(f, (id, answer, _question, state) => id.startsWith('purpose_')
    && (state as { source?: { id: string } }).source?.id === f.peer.block.id ? { type: 'noul', noul: .69 } : answer);
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider.mock.calls.some(([, state, questions]) => (state as { source?: { id: string } }).source?.id === 'credentials'
    && Object.keys(questions).some(id => id.startsWith('purpose_')))).toBe(true);
  expect(f.member.block.group).toBe('custom:engineering');
});

it('rejects a page-title singleton about an existing peer subject and retries a useful shared family', async () => {
  const f = fixture(); reviewedSubjects(f, source => source.block.title);
  transformAnswers(f, (id, answer, question, state) => {
    if (id === 'independent') return { type: 'noul', noul: .01 };
    if (id === 'coherent' && (state as { selectedGroup: { key: string } }).selectedGroup.key === 'custom:session_access') return { type: 'noul', noul: .1 };
    if (!['place', 'gate'].includes(id) || question.type !== 'choice') return answer;
    const groups = (state as { groups: Array<{ key: string; option: string }> }).groups;
    const preferred = groups.find(group => group.key === 'custom:session_access')
      ?? groups.find(group => group.key === 'custom:authentication') ?? groups[0];
    return pick(question, preferred.option);
  });
  const result = await file(f.context, f.request);
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')).toMatchObject({
    mutation: { patch: { group: 'custom:authentication' } }, sources: [f.member.snapshot],
  });
  expect(result.proposals.some(proposal => proposal.mutation.kind === 'vocabulary'
    && proposal.mutation.term.groupKey === 'custom:session_access')).toBe(false);
  const independence = f.decider.mock.calls.find(([, , questions]) => questions.independent)!;
  expect(independence[1]).toMatchObject({ source: { id: 'sessions' }, peerSubjects: [expect.objectContaining({ id: 'credentials' })] });
  expect(independence[2].independent.instructions).toContain('same subject');
  const comparisons = f.decider.mock.calls.filter(([, state]) => (state as { baselineGroup?: string }).baselineGroup);
  expect(comparisons).toHaveLength(2);
});

function differentlyNamedSubjectFixture() {
  const f = sourceSubjectFixture(); f.context.documents.push(f.peer);
  const quote = '# Credential validation';
  f.context.indexes!['canvas:credentials'] = { version: 1, calibration: 1, source: { ...f.peer.snapshot }, topics: [{
    name: 'Credential validation', confidence: .99, definition: 'Checking identity credentials',
    evidence: [{ source: { ...f.peer.snapshot }, quote, start: 0, end: quote.length }],
  }] };
  return f;
}
it('validates a non-independent nominated subject as a shared category instead of rejecting it as a singleton', async () => {
  const f = differentlyNamedSubjectFixture();
  expect(canvasTopicCatalog(f.context, f.member, { sourceSubjects: true }).find(group => group.key === 'custom:authentication')!.nomination).toBe('source_subject');
  transformAnswers(f, (id, answer) => id === 'independent' ? { type: 'noul', noul: .1 } : answer);
  const result = await file(f.context, f.request);
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!;
  expect(definition.sources).toEqual(expect.arrayContaining([f.member.snapshot, f.peer.snapshot]));
  expect(definition.evidence).toContainEqual(expect.objectContaining({ source: f.peer.snapshot,
    quote: 'Authentication verifies passwords and rotates credentials safely.' }));
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')).toMatchObject({
    sources: [f.member.snapshot], mutation: { patch: { group: 'custom:authentication' } },
  });
});

it('retains the baseline if a non-independent subject has no independently supported peer main purpose', async () => {
  const f = differentlyNamedSubjectFixture();
  transformAnswers(f, (id, answer, _question, state) => {
    if (id === 'independent') return { type: 'noul', noul: .1 };
    return id.startsWith('purpose_') && (state as { source?: { id: string } }).source?.id === 'credentials'
      ? { type: 'noul', noul: .69 } : answer;
  });
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider.mock.calls.some(([, state]) => (state as { source?: { id: string } }).source?.id === 'credentials')).toBe(true);
  expect(f.member.block.group).toBe('custom:engineering');
});

it.each([[.69, false], [.7, true]] as const)('requires singleton independence from actual nearby subjects at the unchanged cutoff (%s)', async (value, accepted) => {
  const f = fixture(); updateSource(f.peer, '# Service contracts\n\nService contracts specify API transport formats and durable database schemas.');
  f.member.block.tags = ['Engineering']; f.peer.block.tags = ['Engineering'];
  reviewedSubjects(f, source => source === f.member ? 'Authentication' : 'Service contracts');
  transformAnswers(f, (id, answer, _question, state) => {
    if (id === 'independent') return { type: 'noul', noul: value };
    return id.startsWith('purpose_') && (state as { source?: { id: string } }).source?.id === 'credentials'
      ? { type: 'noul', noul: .1 } : answer;
  });
  const result = await file(f.context, f.request);
  expect(result.proposals.some(proposal => proposal.mutation.kind === 'document')).toBe(accepted);
  const independent = f.decider.mock.calls.find(([, , questions]) => questions.independent)!;
  expect(independent[1]).toMatchObject({ selectedSubject: 'Authentication', peerSubjects: [expect.objectContaining({
    id: 'credentials', passages: expect.arrayContaining([expect.objectContaining({ text: 'Service contracts specify API transport formats and durable database schemas.' })]),
  })] });
  if (accepted) {
    expect(result.proposals.every(proposal => proposal.decisionConfidences?.includes(.7))).toBe(true);
    expect(result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!.sources).toEqual([f.member.snapshot]);
  }
});

it('stops peer validation after the first independently supported family member', async () => {
  const f = fixture(); const additional = document('later-peer', 'Token access', '# Token access\n\nAuthentication verifies token owners before admitting a request.');
  f.context.documents.push(additional); reviewedSubjects(f);
  const result = await file(f.context, f.request);
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!;
  expect(definition.sources).toEqual(expect.arrayContaining([f.member.snapshot, f.peer.snapshot]));
  expect(definition.sources).not.toContainEqual(additional.snapshot);
  expect(f.decider.mock.calls.filter(([, state]) => (state as { source?: { id: string } }).source?.id === 'credentials')).toHaveLength(1);
  expect(f.decider.mock.calls.some(([, state]) => (state as { source?: { id: string } }).source?.id === 'later-peer')).toBe(false);
  expect(f.decider).toHaveBeenCalledTimes(4);
});

it('checks a later bounded peer after the first peer fails local main-purpose validation', async () => {
  const f = fixture(); const additional = document('later-peer', 'Token access', '# Token access\n\nAuthentication verifies token owners before admitting a request.');
  f.context.documents.push(additional); reviewedSubjects(f);
  transformAnswers(f, (id, answer, _question, state) => id.startsWith('purpose_')
    && (state as { source?: { id: string } }).source?.id === 'credentials' ? { type: 'noul', noul: .69 } : answer);
  const result = await file(f.context, f.request);
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!;
  expect(definition.sources).toEqual(expect.arrayContaining([f.member.snapshot, additional.snapshot]));
  expect(definition.sources).not.toContainEqual(f.peer.snapshot);
  expect(definition.evidence).toContainEqual(expect.objectContaining({ source: additional.snapshot,
    quote: 'Authentication verifies token owners before admitting a request.' }));
  expect(f.decider).toHaveBeenCalledTimes(5);
});

it('preserves a supplied shared-category definition and appends only independently checked member examples', async () => {
  const f = sourceSubjectFixture(); f.context.documents.push(f.peer); f.index.calibration = 0;
  const result = await file(f.context, f.request);
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!;
  expect(definition.mutation).toMatchObject({ term: { definition: expect.stringContaining('Verifying user identity before granting access') } });
  expect(definition.mutation).toMatchObject({ term: { definition: expect.stringContaining('rotates credentials safely') } });
  expect(definition.sources).toEqual(expect.arrayContaining([f.member.snapshot, f.peer.snapshot]));
  expect(definition.evidence).toContainEqual(expect.objectContaining({ source: f.peer.snapshot,
    quote: 'Authentication verifies passwords and rotates credentials safely.' }));
});
it('binds shared-family definitions to independently checked peer quotes while keeping placement proof local', async () => {
  const f = familyFixture();
  const result = await file(f.context, f.request);
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!;
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document')!;
  expect(definition.sources).toEqual(expect.arrayContaining([f.member.snapshot, f.peer.snapshot]));
  expect(definition.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: f.peer.snapshot,
    quote: 'Authentication verifies passwords and rotates credentials safely.' })]));
  expect(definition.mutation).toMatchObject({ term: { definition: expect.stringContaining('rotates credentials safely') } });
  expect(membership.sources).toEqual([f.member.snapshot]);
  expect(membership.evidence).toEqual([expect.objectContaining({ source: f.member.snapshot,
    quote: 'Authentication verifies user identity before issuing a session.' })]);
});

it('keeps the eligible current subgroup available when more than sixteen other groups exist', async () => {
  const f = fixture();
  for (const source of f.context.documents) {
    updateSource(source, '# Engineering\n\n## Backend\n\nEngineering Backend defines durable service contracts.');
    source.block.group = 'custom:engineering/backend';
  }
  f.context.vocabulary = Array.from({ length: 18 }, (_, index) => ({ ...f.broad, id: `root-${index}`,
    name: `Root ${index}`, groupKey: `custom:root_${index}`, members: [] }));
  f.context.vocabulary.push({ ...f.broad, id: 'backend', name: 'Engineering / Backend', groupKey: 'custom:engineering/backend' });
  transformAnswers(f, (id, answer, question, state) => {
    if (!['place', 'gate'].includes(id) || question.type !== 'choice') return answer;
    const groups = (state as { groups: Array<{ key: string; option: string }> }).groups;
    return pick(question, groups.find(group => group.key === 'custom:engineering/backend')?.option ?? 'none');
  });
  const result = await file(f.context, f.request);
  const initial = (f.decider.mock.calls[0][1] as { groups: Array<{ key: string }> }).groups;
  expect(initial).toHaveLength(16);
  expect(initial[0].key).toBe('custom:engineering/backend');
  expect(initial.slice(1).map(group => group.key)).toEqual(Array.from({ length: 15 }, (_, index) => `custom:root_${index}`));
  expect(result.proposals).toEqual([]);
  expect(f.member.block.group).toBe('custom:engineering/backend');
});

it.each([[.4, .6], [.5, .5]] as const)('honors a leading or tied none refinement instead of forcing the best group (%s/%s)', async (groupProbability, noneProbability) => {
  const f = fixture();
  transformAnswers(f, (id, answer, question, state) => {
    const groups = (state as { groups?: Array<{ key: string; option: string }> }).groups;
    if (id !== 'place' || groups?.length !== 2 || question.type !== 'choice') return answer;
    return { type: 'choice', choice: 'none', confidence: .99, probabilities: { A: 0, B: groupProbability, none: noneProbability } };
  });
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider).toHaveBeenCalledTimes(2);
  expect(f.member.block.group).toBe('custom:engineering');
});

it('uses the source-backed refinement comparison when none leads the initial comparison despite a permissive gate', async () => {
  const f = fixture(); reviewedSubjects(f);
  transformAnswers(f, (id, answer, _question, state) => {
    const groups = (state as { groups?: unknown[] }).groups;
    return id === 'place' && groups?.length === 1
      ? { type: 'choice', choice: 'none', confidence: .99, probabilities: { A: .4, none: .6 } } : answer;
  });
  const result = await file(f.context, f.request);
  const submission = f.decider.mock.calls[1]; const question = Object.keys(submission[2])[0];
  expect(questionState(submission[1], question).state).toMatchObject({ baselineGroup: 'custom:engineering',
    groups: expect.arrayContaining([expect.objectContaining({ key: 'custom:authentication' })]) });
  expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')).toMatchObject({ mutation: { patch: { group: 'custom:authentication' } } });
  expect(f.member.block.group).toBe('custom:engineering');
});

it('bounds rejected alternative attempts to three and retains the broad baseline without defining groups', async () => {
  const f = fixture(); reviewedSubjects(f, source => source.block.title);
  transformAnswers(f, (id, answer, question, state) => {
    if (question.type === 'noul') return { type: 'noul', noul: .1 };
    const groups = (state as { groups?: Array<{ key: string; option: string }> }).groups;
    return ['place', 'gate'].includes(id) && groups && question.type === 'choice'
      ? pick(question, (groups[1] ?? groups[0]).option) : answer;
  });
  const result = await file(f.context, f.request);
  expect(f.decider.mock.calls.filter(([, state]) => (state as { baselineGroup?: string }).baselineGroup)).toHaveLength(3);
  expect(result.proposals).toEqual([]);
  expect(f.member.block.group).toBe('custom:engineering');
});

it('does not prioritize a current subgroup that fails the existing reusable-category eligibility rule', async () => {
  const f = fixture(); f.member.block.group = 'custom:engineering/backend';
  f.broad.groupKey = 'custom:engineering/backend'; f.broad.name = 'Engineering / Backend';
  updateSource(f.member, '# Engineering\n\n## Backend\n\nEngineering Backend defines durable service contracts.');
  f.peer.block.group = 'custom:other';
  transformAnswers(f, (id, answer, question) => question.type === 'choice' && ['place', 'gate'].includes(id) ? pick(question, 'none') : answer);
  await file(f.context, f.request);
  const initial = (f.decider.mock.calls[0][1] as { groups: Array<{ key: string }> }).groups;
  expect(initial.map(group => group.key)).not.toContain('custom:engineering/backend');
  expect(f.member.block.group).toBe('custom:engineering/backend');
});

it.each(['changed body', 'changed incarnation', 'removed', 'archived', 'excluded'] as const)
('rejects family peer proof that becomes %s between comparison and validation', async invalid => {
  const f = familyFixture(); let changed = false;
  transformAnswers(f, (_id, answer, _question, state) => {
    if (!(state as { baselineGroup?: string }).baselineGroup || changed) return answer;
    changed = true;
    if (invalid === 'changed body') f.peer.block.content += '\nAn unreviewed source edit.';
    if (invalid === 'changed incarnation') f.peer.block.incarnation = 'replacement-source';
    if (invalid === 'removed') f.context.documents = [f.member];
    if (invalid === 'archived') f.peer.block.archived = true;
    if (invalid === 'excluded') f.peer.block.processingExcluded = true;
    return answer;
  });
  expect((await file(f.context, f.request)).proposals).toEqual([]);
  expect(f.decider.mock.calls.some(([, state]) => (state as { source?: { id: string } }).source?.id === 'credentials')).toBe(false);
  expect(f.member.block.group).toBe('custom:engineering');
});
