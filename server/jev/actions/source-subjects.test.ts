import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { JevValues } from '../../../shared/jev-types.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { emptyJevWorkspace } from '../workspace.js';
import { canvasTopicCatalog } from './group-topics.js';
import { sourcePassages } from './source-passages.js';
import { sourceSubjects } from './source-categories.js';
import { sourceSubjectFamilies } from './source-subject-families.js';

function document(id: string, heading: string, body: string): JevInputDocument {
  const content = `# ${heading}\n\n${body}`;
  const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { canvasId: 'canvas', block: { id, title: `Reference ${id}`, file: `${id}.md`, kind: 'markdown', content,
    x: 0, y: 0, width: 400, height: 300, links: [], group: 'custom:engineering', incarnation: id,
    sourceGeneration: 1, metadataRevision: 1, contentHash, jevOwnership: { managed: ['group'], pins: [], removedLabels: [], removedLinks: [] } },
  snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id, incarnation: id,
    sourceGeneration: 1, metadataRevision: 1, contentHash } };
}
function fixture() {
  const member = document('sessions', 'Session authentication', 'Authentication verifies user credentials and issues protected sessions.');
  const peer = document('credentials', 'Credential verification', 'Authentication validates credentials before protected sessions are issued.');
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [member, peer],
    canvases: [{ id: 'canvas', name: 'Sources' }], settings: emptyJevWorkspace().settings, vocabulary: [], tasks: [], indexes: {} };
  for (const source of context.documents) {
    const passages = sourcePassages(source.block.content);
    const topic = (name: string, index: number) => ({ name, confidence: .98,
      evidence: [{ source: { ...source.snapshot }, start: passages[index].start, end: passages[index].end, quote: passages[index].quote }] });
    context.indexes![`canvas:${source.block.id}`] = { version: 1, calibration: 1, source: { ...source.snapshot }, topics: [
      { ...topic('Engineering', 1), definition: 'Building and maintaining technical systems.' }, topic(passages[0].text, 0),
    ] };
  }
  return { context, member, peer };
}
it('compares differently named checked subjects despite a shared broad group without claiming peer membership', () => {
  const f = fixture(); const before = structuredClone(f.context);
  expect(canvasTopicCatalog(f.context, f.member).map(group => group.name)).toEqual(['Engineering']);
  const candidates = canvasTopicCatalog(f.context, f.member, { sourceSubjects: true });
  expect(candidates.map(group => group.name)).toEqual(expect.arrayContaining(['Engineering', 'Session authentication', 'Credential verification']));
  for (const group of candidates.filter(group => group.nomination === 'source_subject')) {
    expect(group.origins.length).toBeLessThanOrEqual(4);
    expect(group.origins.every(origin => origin.source.blockId === f.member.block.id)).toBe(true);
    for (const origin of group.origins) expect(f.member.block.content.slice(origin.start, origin.end)).toBe(origin.quote);
    expect(group.definition).toBe(group.key === 'custom:engineering' ? 'Building and maintaining technical systems.' : undefined);
  }
  expect(candidates.find(group => group.name === 'Credential verification')!.subjectContext)
    .toEqual([expect.objectContaining({ name: 'Credential verification', contextOnly: true })]);
  expect(f.context).toEqual(before);
});
it('allows a checked substantive singleton subject while arbitrary metadata titles and secondary headings remain untrusted', () => {
  const f = fixture(); f.context.documents = [f.member];
  expect(sourceSubjects(f.context, f.member)[0].name).toBe('Session authentication');
  const index = f.context.indexes!['canvas:sessions'];
  const topics = index.topics as JevValues[];
  topics[1].name = f.member.block.title;
  expect(sourceSubjects(f.context, f.member).map(subject => subject.name)).toEqual(['Engineering']);
  topics[1].name = 'Authentication';
  const body = sourcePassages(f.member.block.content)[1];
  topics[1].evidence = [{ source: { ...f.member.snapshot }, start: body.start, end: body.end, quote: body.quote }];
  expect(sourceSubjects(f.context, f.member).map(subject => subject.name)).toContain('Authentication');
});
it.each(['calibration', 'body', 'generation', 'evidence', 'confidence'] as const)('rejects an untrusted %s subject before refinement', failure => {
  const f = fixture(); const index = f.context.indexes!['canvas:sessions'];
  if (failure === 'calibration') index.calibration = 0;
  if (failure === 'body') (index.source as JevValues).contentHash = 'old-body';
  if (failure === 'generation') (index.source as JevValues).sourceGeneration = 2;
  if (failure === 'evidence') for (const topic of index.topics as JevValues[]) (topic.evidence as JevValues[])[0].quote = 'invented';
  if (failure === 'confidence') for (const topic of index.topics as JevValues[]) topic.confidence = Number.NaN;
  expect(sourceSubjects(f.context, f.member)).toEqual([]);
  expect(canvasTopicCatalog(f.context, f.member, { sourceSubjects: true }).some(group => group.nomination === 'source_subject')).toBe(false);
});
it.each(['foreign', 'archived', 'excluded'] as const)('excludes %s neighbors from semantic subject nominations and context', failure => {
  const f = fixture();
  if (failure === 'foreign') { f.peer.canvasId = 'private'; f.peer.snapshot.canvasId = 'private'; }
  if (failure === 'archived') f.peer.block.archived = true;
  if (failure === 'excluded') f.peer.block.processingExcluded = true;
  const groups = canvasTopicCatalog(f.context, f.member, { sourceSubjects: true });
  expect(groups.some(group => group.name === 'Credential verification')).toBe(false);
  expect(groups.flatMap(group => group.subjectContext ?? [])).toEqual([]);
});
it('rebases body-fresh checked subjects after metadata-only changes without rewriting the saved index', () => {
  const f = fixture(); const previous = structuredClone(f.context.indexes);
  f.member.snapshot.metadataRevision++;
  f.member.block.metadataRevision = f.member.snapshot.metadataRevision;
  const subjects = sourceSubjects(f.context, f.member);
  expect(subjects[0].name).toBe('Session authentication');
  expect(subjects.flatMap(subject => subject.origins).every(origin => origin.source.metadataRevision === 2)).toBe(true);
  expect(f.context.indexes).toEqual(previous);
});
it('bounds nearby checked subject context while preserving the selected member proof', () => {
  const f = fixture();
  for (let index = 0; index < 12; index++) {
    const source = document(`neighbor-${index}`, `Credential process ${index}`,
      'Authentication validates credentials before protected sessions are issued.');
    const profile = structuredClone(f.context.indexes!['canvas:credentials']);
    profile.source = { ...source.snapshot };
    const passages = sourcePassages(source.block.content);
    for (const [number, topic] of (profile.topics as JevValues[]).entries()) {
      const passage = passages[number === 0 ? 1 : 0];
      if (number === 1) topic.name = passages[0].text;
      topic.evidence = [{ source: { ...source.snapshot }, start: passage.start, end: passage.end, quote: passage.quote }];
    }
    f.context.documents.push(source); f.context.indexes![`canvas:${source.block.id}`] = profile;
  }
  const groups = canvasTopicCatalog(f.context, f.member, { sourceSubjects: true });
  for (const group of groups) {
    const origins = (group.subjectContext ?? []).flatMap(subject => subject.passages);
    expect(new Set(origins.map(origin => origin.source.blockId)).size).toBeLessThanOrEqual(4);
    expect((group.candidatePeers ?? []).length).toBeLessThanOrEqual(4);
  }
  expect(groups.filter(group => group.nomination === 'source_subject').length).toBeLessThanOrEqual(16);
  for (const group of groups.filter(group => group.nomination === 'source_subject')) {
    expect(group.origins.every(origin => origin.source.blockId === f.member.block.id)).toBe(true);
    expect(group.origins.length).toBeLessThanOrEqual(4);
    expect((group.subjectContext ?? []).length).toBeLessThanOrEqual(2);
  }
});
it('nominates a reusable body-evidence family for differently named authentication subjects without claiming peer truth', () => {
  const f = fixture();
  const family = sourceSubjectFamilies(f.context, f.member).find(group => group.key === 'custom:authentication')!;
  expect(family).toMatchObject({ nomination: 'source_family', candidatePeers: [f.peer.snapshot] });
  expect(family.definition).toBeUndefined();
  expect(family.origins.every(origin => origin.source.blockId === f.member.block.id)).toBe(true);
  expect(family.subjectContext).toEqual([expect.objectContaining({ name: 'Engineering', contextOnly: true })]);
  expect(sourceSubjectFamilies(f.context, f.peer).find(group => group.key === family.key)?.name).toBe(family.name);
  const candidates = canvasTopicCatalog(f.context, f.member, { sourceSubjects: true });
  expect(candidates.findIndex(group => group.key === family.key))
    .toBeLessThan(candidates.findIndex(group => group.name === 'Session authentication'));
});
it('nominates shared document purpose from checked body evidence across disjoint headings', () => {
  const f = fixture();
  const replacements = [document('sessions', 'Document operations', 'Documents are edited safely using versioned files.'),
    document('credentials', 'Safe collaboration', 'Documents retain exact history when multiple agents edit files.')];
  for (const source of replacements) {
    const passages = sourcePassages(source.block.content);
    const profile = f.context.indexes![`canvas:${source.block.id}`];
    profile.source = { ...source.snapshot };
    for (const [index, topic] of (profile.topics as JevValues[]).entries()) {
      const passage = passages[index === 0 ? 1 : 0];
      if (index === 1) topic.name = passage.text;
      topic.evidence = [{ source: { ...source.snapshot }, start: passage.start, end: passage.end, quote: passage.quote }];
    }
  }
  f.context.documents = replacements;
  const groups = sourceSubjectFamilies(f.context, replacements[0]);
  expect(groups.map(group => group.key)).toContain('custom:documents');
  expect(groups.every(group => group.origins.every(origin => origin.source.blockId === 'sessions'))).toBe(true);
});
it('does not turn unchecked fallback body words or repeated administrative headings into trusted families', () => {
  const f = fixture();
  for (const index of Object.values(f.context.indexes!)) index.topics = (index.topics as JevValues[]).slice(1);
  expect(sourceSubjectFamilies(f.context, f.member)).toEqual([]);
  expect(sourceSubjects(f.context, f.member)[0].bodyEvidence).toEqual([]);
  for (const source of f.context.documents) {
    const content = source.block.content.replace(/^# .+/, '# System overview guide checklist');
    source.block.content = content;
    const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    source.snapshot.contentHash = contentHash; source.block.contentHash = contentHash;
    const profile = f.context.indexes![`canvas:${source.block.id}`];
    profile.source = { ...source.snapshot };
    const heading = sourcePassages(content)[0];
    (profile.topics as JevValues[])[0] = { name: heading.text, confidence: .99,
      evidence: [{ source: { ...source.snapshot }, start: heading.start, end: heading.end, quote: heading.quote }] };
  }
  expect(sourceSubjectFamilies(f.context, f.member)).toEqual([]);
});
it('deduplicates repeated profile topics per source and bounds family and peer nominations deterministically', () => {
  const f = fixture();
  for (const index of Object.values(f.context.indexes!)) index.topics = Array(6).fill((index.topics as JevValues[])[0]);
  const forward = sourceSubjectFamilies(f.context, f.member);
  const reverse = sourceSubjectFamilies({ ...f.context, documents: [...f.context.documents].reverse() }, f.member);
  expect(reverse).toEqual(forward);
  expect(forward.length).toBeLessThanOrEqual(8);
  expect(forward.every(group => group.candidatePeers?.length === 1)).toBe(true);
  f.context.documents = [f.member];
  expect(sourceSubjectFamilies(f.context, f.member)).toEqual([]);
});
it.each(['stale', 'uncalibrated', 'archived', 'excluded', 'foreign'] as const)
('rejects %s evidence peers before family nomination and singleton independence context', failure => {
  const f = fixture(); const index = f.context.indexes!['canvas:credentials'];
  if (failure === 'stale') (index.source as JevValues).contentHash = 'old';
  if (failure === 'uncalibrated') index.calibration = 0;
  if (failure === 'archived') f.peer.block.archived = true;
  if (failure === 'excluded') f.peer.block.processingExcluded = true;
  if (failure === 'foreign') f.peer.snapshot.workspaceId = 'private';
  expect(sourceSubjectFamilies(f.context, f.member)).toEqual([]);
  const groups = canvasTopicCatalog(f.context, f.member, { sourceSubjects: true });
  expect(groups.flatMap(group => group.candidatePeers ?? [])).toEqual([]);
});
const invalidTopics: Array<{ name: string; topic: JevValues }> = [
  { name: 'missing topic name', topic: { confidence: .99, evidence: [] } },
  { name: 'missing evidence array', topic: { name: 'Authentication', confidence: .99 } },
  { name: 'empty category', topic: { name: ' ', confidence: .99, evidence: [] } },
  { name: 'oversized category', topic: { name: 'A'.repeat(81), confidence: .99, evidence: [] } },
  { name: 'missing evidence source', topic: { name: 'Authentication', confidence: .99, evidence: [{ quote: 'Authentication' }] } },
  { name: 'foreign evidence identity', topic: { name: 'Authentication', confidence: .99, evidence: [{ source: { workspaceId: 'private' } }] } },
];
it.each(invalidTopics)('ignores $name in a persisted profile without granting taxonomy provenance', ({ topic }) => {
  const f = fixture(); f.context.indexes!['canvas:sessions'].topics = [topic];
  expect(sourceSubjects(f.context, f.member)).toEqual([]);
});
it('requires substantive body support even for a current checked heading', () => {
  const f = fixture(); const source = document('sessions', 'Session authentication', '');
  f.context.documents = [source]; const profile = f.context.indexes!['canvas:sessions']; profile.source = { ...source.snapshot };
  const heading = sourcePassages(source.block.content)[0];
  profile.topics = [{ name: heading.text, confidence: .99,
    evidence: [{ source: { ...source.snapshot }, start: heading.start, end: heading.end, quote: heading.quote }] }];
  expect(sourceSubjects(f.context, source)).toEqual([]);
});
it('accepts exact substantive topics without headings at the default calibrated threshold', () => {
  const f = fixture(); const source = f.member;
  source.block.content = 'Authentication validates account credentials.';
  source.snapshot.contentHash = createHash('sha256').update(source.block.content).digest('hex').slice(0, 16);
  source.block.contentHash = source.snapshot.contentHash;
  const profile = f.context.indexes!['canvas:sessions']; profile.source = { ...source.snapshot };
  const body = sourcePassages(source.block.content)[0];
  profile.topics = [{ name: 'Authentication', confidence: .7,
    evidence: [{ source: { ...source.snapshot }, start: body.start, end: body.end, quote: body.quote }] }];
  delete f.context.settings.confidenceThresholds;
  expect(sourceSubjects(f.context, source)).toEqual([expect.objectContaining({ name: 'Authentication', bodyEvidence: [expect.objectContaining({ quote: body.quote })] })]);
});
it('does not nominate a number-only checked heading as a lexical shared family', () => {
  const f = fixture();
  for (const source of f.context.documents) {
    const content = source.block.content.replace(/^# .+/, '# 287'); source.block.content = content;
    source.snapshot.contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    source.block.contentHash = source.snapshot.contentHash;
    const profile = f.context.indexes![`canvas:${source.block.id}`]; profile.source = { ...source.snapshot };
    const heading = sourcePassages(content)[0];
    profile.topics = [{ name: '287', confidence: .99, evidence: [{ source: { ...source.snapshot }, start: heading.start, end: heading.end, quote: heading.quote }] }];
  }
  expect(sourceSubjectFamilies(f.context, f.member)).toEqual([]);
});
it('rejects repeated oversized body identifiers while retaining a genuine bounded shared subject', () => {
  const f = fixture(); const huge = 'PrivateIdentifier'.repeat(25);
  for (const source of f.context.documents) {
    source.block.content = `# ${source.block.id === 'sessions' ? 'Session authentication' : 'Credential verification'}\n\nQ Authentication validates credentials. ${huge} credential verification is checked.`;
    source.snapshot.contentHash = createHash('sha256').update(source.block.content).digest('hex').slice(0, 16);
    source.block.contentHash = source.snapshot.contentHash;
    const profile = f.context.indexes![`canvas:${source.block.id}`]; profile.source = { ...source.snapshot };
    const [heading, body] = sourcePassages(source.block.content);
    profile.topics = [{ name: heading.text, confidence: .99,
      evidence: [{ source: { ...source.snapshot }, start: heading.start, end: heading.end, quote: heading.quote }] },
    { name: 'Authentication', confidence: .99,
      evidence: [{ source: { ...source.snapshot }, start: body.start, end: body.end, quote: body.quote }] }];
  }
  const families = sourceSubjectFamilies(f.context, f.member);
  expect(families.map(group => group.key)).toContain('custom:authentication');
  expect(families.every(group => group.name.length >= 2 && group.name.length <= 80)).toBe(true);
  expect(families.some(group => group.name.toLowerCase().includes('privateidentifier'))).toBe(false);
  expect(families.some(group => group.name === 'q')).toBe(false);
});
it.each(['Canvas', 'Analysis', 'Series', 'Policies'])('preserves checked %s spelling and stable representative source case without guessing singular forms', name => {
  const f = fixture();
  for (const source of f.context.documents) {
    const heading = source.block.id === 'credentials' ? name : name.toUpperCase();
    source.block.content = `# ${heading}\n\n${name} defines the checked subject and substantive source purpose.`;
    source.snapshot.contentHash = createHash('sha256').update(source.block.content).digest('hex').slice(0, 16);
    source.block.contentHash = source.snapshot.contentHash;
    const profile = f.context.indexes![`canvas:${source.block.id}`]; profile.source = { ...source.snapshot };
    const passage = sourcePassages(source.block.content)[0];
    profile.topics = [{ name: passage.text, confidence: .99, evidence: [{ source: { ...source.snapshot },
      start: passage.start, end: passage.end, quote: passage.quote }] }];
  }
  const key = `custom:${name.toLowerCase()}`;
  const forward = sourceSubjectFamilies(f.context, f.member);
  expect(forward.find(group => group.key === key)?.name).toBe(name);
  expect(sourceSubjectFamilies({ ...f.context, documents: [...f.context.documents].reverse() }, f.member)).toEqual(forward);
  expect(forward.some(group => group.name === name.slice(0, -1))).toBe(false);
});
function checkedCorpus(sources: JevInputDocument[]): JevEvaluationContext {
  const context = fixture().context;
  context.documents = sources; context.indexes = {};
  for (const source of sources) {
    const [heading, body] = sourcePassages(source.block.content);
    const topic = (name: string, passage: typeof heading) => ({ name, confidence: .99,
      evidence: [{ source: { ...source.snapshot }, start: passage.start, end: passage.end, quote: passage.quote }] });
    context.indexes[`canvas:${source.block.id}`] = { version: 1, calibration: 1, source: { ...source.snapshot },
      topics: [topic('Engineering', body), topic(heading.text, heading)] };
  }
  return context;
}
const transportWords = 'Server request router payload endpoint transport worker queue response client socket channel';
it('ranks the member checked primary subject above common words promoted by unrelated peer headings', () => {
  const words = transportWords.split(' ');
  const sources = [document('member', 'Orchid cultivation', `Orchid grows in carefully managed soil. ${transportWords}.`),
    document('peer', 'Orchid propagation', `Orchid roots require suitable growing conditions. ${transportWords}.`),
    ...Array.from({ length: 9 }, (_, index) => document(`other-${index}`, words.slice(index, index + 3).join(' '),
      `Independent operational responsibilities involve ${transportWords}.`))];
  const context = checkedCorpus(sources);
  const groups = sourceSubjectFamilies(context, sources[0]);
  expect(groups[0].key).toBe('custom:orchid');
  expect(groups.length).toBeLessThanOrEqual(8);
  expect(groups[0].candidatePeers).toEqual([sources[1].snapshot]);
  expect(groups[0].origins.every(origin => origin.source.blockId === 'member')).toBe(true);
  expect(sourceSubjectFamilies({ ...context, documents: [...sources].reverse() }, sources[0])).toEqual(groups);
});
it('uses corpus specificity for checked body families when differently named main subjects share no words', () => {
  const sources = [document('member', 'Orchid cultivation', `Pollination. ${transportWords}.`),
    document('peer', 'Flower reproduction', `Pollination protects flowers. ${transportWords}.`),
    ...Array.from({ length: 9 }, (_, index) => document(`other-${index}`, `Distinct responsibility ${index}`,
      `Unrelated duties involve ${transportWords}.`))];
  const context = checkedCorpus(sources);
  const groups = sourceSubjectFamilies(context, sources[0]);
  expect(groups[0].key).toBe('custom:pollination');
  expect(groups[0].candidatePeers).toEqual([sources[1].snapshot]);
  expect(groups[0].definition).toBeUndefined();
});
it('uses a checked substantive topic name when sources have no main heading', () => {
  const f = fixture();
  for (const source of f.context.documents) {
    source.block.content = `Authentication protects account credentials for ${source.block.id}.`;
    source.snapshot.contentHash = createHash('sha256').update(source.block.content).digest('hex').slice(0, 16);
    source.block.contentHash = source.snapshot.contentHash;
    const passage = sourcePassages(source.block.content)[0];
    f.context.indexes![`canvas:${source.block.id}`] = { version: 1, calibration: 1, source: { ...source.snapshot },
      topics: [{ name: 'Authentication', confidence: .99, evidence: [{ source: { ...source.snapshot },
        start: passage.start, end: passage.end, quote: passage.quote }] }] };
  }
  expect(sourceSubjectFamilies(f.context, f.member)[0].key).toBe('custom:authentication');
});
