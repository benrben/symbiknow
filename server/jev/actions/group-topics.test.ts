import { expect, it } from 'vitest';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { canvasTopicCatalog, reusableGroup } from './group-topics.js';
import { filingPassages } from './group-passages.js';
import { bootstrapGrouping } from './grouping.js';
import { emptyJevWorkspace } from '../workspace.js';

function document(id: string, title: string, content: string): JevInputDocument {
  return { canvasId: 'canvas', block: { id, title, content, file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] },
    snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id, incarnation: id, sourceGeneration: 1, metadataRevision: 1, contentHash: 'hash' } };
}
function context(documents: JevInputDocument[]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents, canvases: [{ id: 'canvas', name: 'Sources' }], tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings };
}
it('retains exact heading provenance when a normalized title nominates the same key without a literal name match', () => {
  const source = document('services', 'platform_services', '# platform_services\nThe platform provides checked service contracts.');
  source.block.tags = ['platform_services'];
  const before = structuredClone(source);
  const catalog = canvasTopicCatalog(context([source]), source);
  expect(catalog).toHaveLength(1);
  expect(catalog[0]).toEqual({ name: 'Platform services', key: 'custom:platform_services', origins: [filingPassages(source)[0]] });
  for (const origin of catalog[0].origins) {
    expect(origin.source).toEqual(source.snapshot);
    expect(source.block.content.slice(origin.start, origin.end)).toBe(origin.quote);
  }
  expect(source).toEqual(before);
});
it('deduplicates ordinary heading title and tag origins while leaving unsupported names without manufactured evidence', () => {
  const source = document('platform', 'Platform', '# Platform\nPlatform keeps exact source data.');
  source.block.tags = ['Platform', 'Platform'];
  const group = canvasTopicCatalog(context([source]), source)[0];
  expect(group).toEqual({ name: 'Platform', key: 'custom:platform', origins: filingPassages(source) });
  const unsupported = document('unmatched', 'platform_services', 'This source describes an independent rollout.');
  unsupported.block.tags = ['platform_services', 'platform_services'];
  expect(canvasTopicCatalog(context([unsupported]), unsupported)).toEqual([
    { name: 'Platform services', key: 'custom:platform_services', origins: [] },
  ]);
});
it('nominates readable HTML heading and title names with exact original evidence even when entities and inline markup differ', () => {
  const source = document('architecture', 'Architecture & API', '<html><head><style>PRIVATE_CSS</style></head><body><h1>Architecture &amp; <code>API</code></h1><p>Architecture connects the browser to the saved API.</p></body></html>');
  const group = canvasTopicCatalog(context([source]), source).find(candidate => candidate.name === source.block.title)!;
  expect(group).toMatchObject({ key: 'custom:architecture_api' });
  expect(group.origins.length).toBeGreaterThan(0);
  expect(group.origins[0].quote).toBe('Architecture &amp; <code>API');
  for (const origin of group.origins) expect(source.block.content.slice(origin.start, origin.end)).toBe(origin.quote);
});
it('requires visible shared local purpose rather than scripts or styles before reusing a nested heading topic', () => {
  const source = document('storage', 'Storage', '<body><h1>Platform</h1><h2>Storage</h2><p>Platform storage persists checked evidence.</p></body>');
  const unrelated = document('hosting', 'Hosting', '<body><h1>Operations</h1><script>Platform Storage</script><style>Platform Storage</style><p>Configure hosting credentials.</p></body>');
  expect(canvasTopicCatalog(context([source, unrelated]), source).some(group => group.key.includes('/'))).toBe(false);
});
it('keeps tiny, overlong and lower-level section headings out of native root group names', () => {
  const long = 'Long heading '.repeat(10);
  const source = document('bounds', 'Source', `# A\n# ${long}\n### Internal section\nNormal source prose.`);
  const names = canvasTopicCatalog(context([source]), source).map(group => group.name);
  expect(names).not.toContain('A'); expect(names).not.toContain(long.trim()); expect(names).not.toContain('Internal section');
  expect(names).toContain('Source');
});
it('nominates a recurring visible category before individual document headings without requiring vocabulary', () => {
  const source = document('architecture', 'Architecture', '<body><span>Platform · Architecture</span><h1>Architecture</h1><p>One server owns saved source files.</p></body>');
  const api = document('api', 'Server API', '<body><span>Platform · Server API</span><h1>Server API</h1><p>The API serves checked source files.</p></body>');
  const catalog = canvasTopicCatalog(context([source, api]), source);
  expect(catalog[0]).toMatchObject({ name: 'Platform', key: 'custom:platform' });
  expect(catalog[0].origins.map(origin => origin.source.blockId)).toEqual(['architecture', 'api']);
  for (const origin of catalog[0].origins) {
    const original = [source, api].find(document => document.block.id === origin.source.blockId)!;
    expect(original.block.content.slice(origin.start, origin.end)).toBe(origin.quote);
  }
});

it('ranks shared signals before individual titles with bounded source reads and exact evidence', () => {
  const names = Array.from({ length: 32 }, (_, index) => `Atlas topic ${String(index).padStart(2, '0')}`);
  const documents = names.map((name, index) => {
    const source = document(`source-${index}`, name, `<body><h1>${name}</h1><h2>Storage</h2><p>Atlas storage connects ${names.join('; ')}.</p></body>`);
    source.block.tags = ['Atlas']; return source;
  });
  let reads = 0;
  for (const source of documents) {
    const content = source.block.content;
    Object.defineProperty(source.block, 'content', { enumerable: true, get: () => { reads++; return content; } });
  }
  const catalog = canvasTopicCatalog(context(documents), documents[0]);
  expect(catalog[0].name).toBe('Atlas');
  expect(catalog).toHaveLength(24);
  expect(catalog.map(group => group.name)).toEqual(expect.arrayContaining([names[0], `${names[0]} / Storage`]));
  expect(reads).toBeLessThanOrEqual(documents.length * 3);
  for (const group of catalog) for (const origin of group.origins) {
    const source = documents.find(document => document.block.id === origin.source.blockId)!;
    expect(origin.source).toEqual(source.snapshot);
    expect(source.block.content.slice(origin.start, origin.end)).toBe(origin.quote);
  }
});

it('finds a reusable broad topic in later imports without borrowing neighboring quotes as the selected member evidence', async () => {
  const documents = Array.from({ length: 158 }, (_, index) => document(`source-${index}`,
    index < 12 ? `Original ${index}` : `Imported ${index - 12}`,
    index < 32 ? `# Independent ${index}\nAn unrelated reference records responsibility ${index}.`
      : '# Release Coordination\nRelease Coordination combines approval, rollout, and checked operational handoffs.'));
  const member = document('selected-import', 'Shipping memo',
    '# Shipping memo\nRelease Coordination manages approval, rollout timing, and named owners for this release.');
  documents[157] = member;
  const catalog = canvasTopicCatalog(context(documents), member);
  const group = catalog.find(candidate => candidate.name === 'Release Coordination');
  expect(group).toMatchObject({ key: 'custom:release_coordination' });
  expect(catalog.map(candidate => candidate.name)).toEqual(['Release Coordination', 'Shipping memo']);
  expect(group!.origins).toHaveLength(4);
  for (const origin of group!.origins) {
    const source = documents.find(item => item.block.id === origin.source.blockId)!;
    expect(documents.indexOf(source)).toBeGreaterThanOrEqual(32);
    expect(source.block.content.slice(origin.start, origin.end)).toBe(origin.quote);
    expect(origin.source).toEqual(source.snapshot);
  }
  expect(member.block.content).toContain('Release Coordination manages approval, rollout timing, and named owners for this release.');
  expect(group!.origins.every(origin => origin.source.blockId !== member.block.id)).toBe(true);
  const input = context(documents); input.apiKey = 'synthetic-group-evidence';
  input.decider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([wireId, question]) => {
    if (question.type === 'noul') return [wireId, { type: 'noul', noul: .99 }];
    if (question.type !== 'choice') throw new Error('Unexpected grouping question type');
    const id = wireId.replace(/^(?:\d+__)+/, '');
    const keys = Object.keys(question.criteria);
    const selected = keys.find(key => id === 'group'
      ? question.criteria[key].endsWith('(custom:release_coordination)')
      : question.criteria[key].includes('Release Coordination manages approval, rollout timing, and named owners')) ?? 'none';
    return [wireId, { type: 'choice', choice: selected, confidence: .99,
      probabilities: Object.fromEntries(keys.map(key => [key, Number(key === selected)])) }];
  }));
  const result = await bootstrapGrouping(input, { action: 'file', canvasId: member.canvasId, blockIds: [member.block.id] }, member);
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document')!;
  expect(membership.mutation).toMatchObject({ kind: 'document', blockId: member.block.id, patch: { group: group!.key } });
  const selectedEvidence = filingPassages(member).find(passage => passage.quote.includes('Release Coordination manages approval'))!;
  expect(membership.evidence).toEqual([selectedEvidence]);
  expect(membership.sources).toEqual([member.snapshot]);
  expect(member.block.content.slice(selectedEvidence.start, selectedEvidence.end)).toBe(selectedEvidence.quote);
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!;
  expect(definition.evidence.some(passage => passage.source.blockId === member.block.id)).toBe(true);
  expect(definition.evidence.some(passage => passage.source.blockId !== member.block.id)).toBe(true);
});

it('checks nested recurrence in the full live local catalog and includes a selected source beyond the first 32 documents', () => {
  const documents = Array.from({ length: 158 }, (_, index) => document(`source-${index}`, `Source ${index}`, `# Independent ${index}\nThis records a distinct source.`));
  const supporting = document('support', 'Storage reference', '# Storage reference\nPlatform Storage persists checked source data.');
  const outside = document('outside-window', 'Other storage', '# Other storage\nPlatform Storage supports background work.');
  const source = document('selected', 'Selected storage', '# Platform\n## Storage\nPlatform Storage keeps exact source data.');
  documents[0] = supporting; documents[32] = outside; documents[157] = source;
  const scoped = context(documents);
  const group = { key: 'custom:platform/storage', name: 'Platform / Storage' };
  expect(reusableGroup(scoped, source, group)).toBe(true);
  expect(canvasTopicCatalog(scoped, source).some(candidate => candidate.key === group.key)).toBe(true);
  expect(canvasTopicCatalog(scoped, source).some(candidate => candidate.origins.some(origin => origin.source.blockId === source.block.id))).toBe(true);
  supporting.block.archived = true;
  expect(reusableGroup(scoped, source, group)).toBe(true);
  outside.block.archived = true;
  expect(reusableGroup(scoped, source, group)).toBe(false);
  supporting.block.archived = false; supporting.block.processingExcluded = true;
  expect(reusableGroup(scoped, source, group)).toBe(false);
  supporting.block.processingExcluded = false; supporting.canvasId = 'private-canvas';
  expect(reusableGroup(scoped, source, group)).toBe(false);
  outside.block.archived = false; outside.block.processingExcluded = true;
  expect(reusableGroup(scoped, source, group)).toBe(false);
  outside.block.processingExcluded = false; outside.canvasId = 'private-canvas';
  expect(reusableGroup(scoped, source, group)).toBe(false);
  expect(reusableGroup(scoped, source, { key: 'custom:platform', name: 'Platform' })).toBe(true);
});

it('keeps detached selected source values stable and declines orphan section headings without inventing a parent', () => {
  const source = document('selected', 'Storage note', '## Orphan section\nStorage note describes source evidence.');
  const original = canvasTopicCatalog(context([source]), source);
  const detached = { ...source, block: { ...source.block } };
  expect(canvasTopicCatalog(context([source]), detached)).toEqual(original);
  expect(original.map(group => group.name)).toEqual(['Storage note']);
  expect(canvasTopicCatalog(context([]), detached)).toEqual(original);
});

it('nominates checked logical topics before incidental titles and keeps their exact current evidence', () => {
  const member = document('selected', 'Incident 42', '# Incident 42\nRestore service from a tested snapshot after a failed deployment.');
  const peer = document('peer', 'Runbook 7', '# Runbook 7\nRecover production using verified backups.');
  const input = context([member, peer]);
  const evidence = filingPassages(member)[1];
  input.indexes = { 'canvas:selected': { version: 1, topics: [{ name: 'Operational recovery', confidence: .96, evidence: [JSON.parse(JSON.stringify(evidence))] }] } };
  const catalog = canvasTopicCatalog(input, member);
  expect(catalog[0]).toEqual({ name: 'Operational recovery', key: 'custom:operational_recovery', origins: [evidence] });
  member.snapshot = { ...member.snapshot, metadataRevision: 2 };
  member.block.tags = ['New label'];
  expect(canvasTopicCatalog(input, member)[0].origins[0].source).toEqual(member.snapshot);
  input.indexes['canvas:selected'] = { version: 1, topics: [{ name: 'Stale index', confidence: .96,
    evidence: [JSON.parse(JSON.stringify({ ...evidence, source: { ...evidence.source, sourceGeneration: 0 } }))] }] };
  expect(canvasTopicCatalog(input, member).some(group => group.name === 'Stale index')).toBe(false);
});
it('ignores malformed logical topics and accepts only a current exact passage at the configured cutoff', () => {
  const member = document('selected', 'Restore note', '# Restore note\nUse a tested backup to restore the service.');
  const input = context([member]);
  const evidence = filingPassages(member)[1];
  const savedEvidence = JSON.parse(JSON.stringify(evidence));
  input.indexes = { 'canvas:selected': { version: 1, topics: [
    null, [], { name: 5, confidence: .95, evidence: [savedEvidence] },
    { name: 'Missing evidence array', confidence: .95 },
    { name: 'A', confidence: .95, evidence: [savedEvidence] },
    { name: 'Long topic '.repeat(12), confidence: .95, evidence: [savedEvidence] },
    { name: 'Missing source', confidence: .95, evidence: [{ start: evidence.start, end: evidence.end, quote: evidence.quote }] },
    { name: 'Invalid source', confidence: .95, evidence: [{ ...savedEvidence, source: 'not-a-source' }] },
    { name: 'Wrong quote', confidence: .95, evidence: [{ ...savedEvidence, quote: 'Invented passage' }] },
    { name: 'Current recovery', confidence: .7, evidence: [savedEvidence] },
  ] } };
  const names = canvasTopicCatalog(input, member).map(group => group.name);
  expect(names).toContain('Current recovery');
  for (const rejected of ['Missing evidence array', 'Missing source', 'Invalid source', 'Wrong quote'])
    expect(names).not.toContain(rejected);
  expect(names.some(name => name.startsWith('Long topic'))).toBe(false);
  input.settings.confidenceThresholds = undefined;
  expect(canvasTopicCatalog(input, member).some(group => group.name === 'Current recovery')).toBe(true);
});

it('rejects a detached source revision and an out-of-scope nested recurrence without reading stale catalog values', () => {
  const member = document('selected', 'Recovery', '# Platform\n## Storage\nPlatform Storage persists checked evidence.');
  const input = context([member]);
  const detached = structuredClone(member);
  detached.snapshot.contentHash = 'different-revision';
  expect(canvasTopicCatalog(input, detached)).toEqual([]);
  expect(reusableGroup(input, detached, { key: 'custom:platform/storage', name: 'Platform / Storage' })).toBe(false);
  const hidden = structuredClone(member);
  hidden.canvasId = 'private'; hidden.snapshot.canvasId = 'private';
  expect(reusableGroup(input, hidden, { key: 'custom:platform/storage', name: 'Platform / Storage' })).toBe(false);
});
it('uses labels and explicit linked neighbors to nominate and rank a preserved manual group name', () => {
  const member = document('selected', 'New procedure', '# New procedure\nRestore the service after an outage.'); member.block.tags = ['Operations'];
  const peer = document('peer', 'Backup details', '# Backup details\nKeep tested recovery snapshots.');
  peer.canvasId = 'other'; peer.snapshot.canvasId = 'other'; peer.block.tags = ['operations']; peer.block.group = 'custom:ops';
  member.block.crossLinks = [{ canvasId: 'other', blockId: peer.block.id, relation: 'prerequisite' }];
  const unrelated = document('noise', 'Garden inventory', '# Garden inventory\nSeedlings compost flowers.');
  const input = context([member, peer, unrelated]); input.canvases.push({ id: 'other', name: 'Other', groups: [{ id: 'custom:ops', name: 'Service Operations' }] });
  const catalog = canvasTopicCatalog(input, member);
  const candidate = catalog.find(group => group.key === 'custom:ops');
  expect(candidate?.name).toBe('Service Operations');
  expect(candidate?.origins.every(origin => origin.source.blockId === peer.block.id)).toBe(true);
  expect(catalog.findIndex(group => group.key === 'custom:ops')).toBeLessThan(catalog.findIndex(group => group.name === 'New procedure'));
  expect(catalog.some(group => group.name === 'Garden inventory')).toBe(false);
  member.block.crossLinks = [];
  expect(canvasTopicCatalog(input, member).some(group => group.key === 'custom:ops')).toBe(false);
});
it('does not import unrelated canvas titles or foreign indexed labels despite matching raw names', () => {
  const member = document('member', 'Deployment', '# Deployment\nDatabase journal transactions.');
  const foreign = document('foreign', 'Foreign secret', '# Foreign secret\nDatabase journal transactions.'); foreign.snapshot.workspaceId = 'private';
  const hidden = document('hidden', 'Hidden secret', '# Hidden secret\nDatabase journal transactions.'); hidden.canvasId = 'private'; hidden.snapshot.canvasId = 'private';
  const unrelated = Array.from({ length: 40 }, (_, index) => document(`noise${index}`, `Garden ${index}`, `# Garden ${index}\nSeedling compost flowers.`));
  const input = context([member, foreign, hidden, ...unrelated]);
  input.indexes = { 'canvas:foreign': { version: 1, topics: [{ name: 'Foreign indexed secret', confidence: 1, evidence: [] }] } };
  expect(canvasTopicCatalog(input, member).map(group => group.name)).toEqual(['Deployment']);
  expect(canvasTopicCatalog(input, hidden)).toEqual([]);
});

it('keeps title-spoofed calendar and procurement sources out of a member group catalog', () => {
  const member = document('release', 'Release checklist',
    '# Release checklist\n\nRelease Engineering · Production deployment\n\nCheck migrations and service health before release.');
  const peer = document('rollback', 'Rollback procedure',
    '# Rollback procedure\n\nRelease Engineering · Production recovery\n\nRestore the prior image after a failed release.');
  const distractors = Array.from({ length: 12 }, (_, index) => document(`noise-${index}`,
    `Release checklist deployment recovery calendar ${index}`,
    index % 2 ? 'Finance recorded a release budget and service contract for event materials.'
      : 'Marketing planned webinar guests, visual assets, and calendar reminders.'));
  const catalog = canvasTopicCatalog(context([member, ...distractors, peer]), member);
  expect(catalog[0]).toMatchObject({ key: 'custom:release_engineering', name: 'Release Engineering' });
  expect(catalog.every(group => !group.name.includes('calendar'))).toBe(true);
  expect(catalog[0].origins.map(origin => origin.source.blockId)).toEqual(['release', 'rollback']);
});

function indexTopics(input: JevEvaluationContext, source: JevInputDocument, names: string[]) {
  input.indexes ??= {};
  input.indexes[`${source.canvasId}:${source.block.id}`] = { version: 1, topics: names.map(name => ({ name, confidence: .96,
    evidence: JSON.parse(JSON.stringify([filingPassages(source)[1]])) })) };
}
function sharedCategoryFixture() {
  const member = document('selected', 'Restore checklist', '# Restore checklist\n\nService Recovery · Restore\n\nRestore the service using a tested recovery snapshot.');
  const peer = document('peer', 'Snapshot policy', '# Snapshot policy\n\nService Recovery · Backups\n\nKeep tested snapshots to recover service after an outage.');
  return { member, peer, input: context([member, peer]) };
}
it('offers the reusable source category instead of competing private title folders even when only the title was indexed', () => {
  const { member, input } = sharedCategoryFixture();
  indexTopics(input, member, ['Restore checklist']); member.block.tags = ['Service Recovery'];
  const groups = canvasTopicCatalog(input, member);
  expect(groups.map(group => group.name)).toEqual(['Service Recovery']);
  expect(new Set(groups[0].origins.map(origin => origin.source.blockId))).toEqual(new Set(['selected', 'peer']));
});
it('offers an independently checked shared logical topic instead of unique heading topics without requiring category captions', () => {
  const member = document('selected', 'Restore checklist', '# Restore checklist\n\nRestore service from a tested snapshot after an outage.');
  const peer = document('peer', 'Backup policy', '# Backup policy\n\nKeep tested snapshots to recover service.');
  const input = context([member, peer]);
  indexTopics(input, member, ['Operational recovery', 'Restore checklist']); indexTopics(input, peer, ['Operational recovery', 'Backup policy']);
  expect(canvasTopicCatalog(input, member).map(group => group.name)).toEqual(['Operational recovery']);
});
it('retains manually named groups while excluding old automatically created singleton competitors', () => {
  const { member, peer, input } = sharedCategoryFixture();
  peer.block.group = 'custom:snapshot_policy';
  peer.block.jevOwnership = { pins: [], managed: ['group'], removedLabels: [], removedLinks: [] };
  expect(canvasTopicCatalog(input, member).map(group => group.name)).toEqual(['Service Recovery']);
  peer.block.jevOwnership.pins = ['group'];
  input.canvases[0].groups = [{ id: 'custom:snapshot_policy', name: 'Approved operational library' }];
  expect(canvasTopicCatalog(input, member).map(group => group.name)).toEqual(expect.arrayContaining(['Service Recovery', 'Approved operational library']));
});
it.each(['selection', 'coherence', 'purpose'] as const)('does not force the shared category when its %s check is unsupported', async rejected => {
  const { member, input } = sharedCategoryFixture();
  input.apiKey = 'offline-shared-category'; input.selectiveGroupAssessment = true;
  input.decider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([wireId, question]) => {
    const id = wireId.replace(/^(?:\d+__)+/, '');
    if (question.type === 'noul') return [wireId, { type: 'noul', noul: (rejected === 'coherence' && id === 'coherent')
      || (rejected === 'purpose' && id.startsWith('purpose_')) ? .2 : .99 }];
    if (question.type !== 'choice') throw new Error('Unexpected shared-group question');
    const keys = Object.keys(question.criteria);
    const choice = id === 'group' ? (rejected === 'selection' ? 'none' : keys[0]) : 'p1';
    return [wireId, { type: 'choice', choice, confidence: .99, probabilities: Object.fromEntries(keys.map(key => [key, Number(key === choice)])) }];
  }));
  const result = await bootstrapGrouping(input, { action: 'file', canvasId: member.canvasId, blockIds: [member.block.id] }, member);
  expect(result.proposals).toEqual([]);
  expect(result.result.status).toMatch(/insufficient/);
  expect(member.block.group).toBeUndefined();
});

it('allows an explicitly selected archived member while excluding archived peers and retaining processing scope checks', () => {
  const member = document('archived-member', 'Archived runbook', '# Archived runbook\nDocumented recovery procedures.'); member.block.archived = true;
  const peer = document('archived-peer', 'Private archived topic', '# Private archived topic\nDocumented recovery procedures.'); peer.block.archived = true;
  const input = context([member, peer]);
  expect(canvasTopicCatalog(input, member).map(group => group.name)).toEqual(['Archived runbook']);
  member.block.processingExcluded = true;
  expect(canvasTopicCatalog(input, member)).toEqual([]);
  member.block.processingExcluded = false; input.canvases = [];
  expect(canvasTopicCatalog(input, member)).toEqual([]);
});
