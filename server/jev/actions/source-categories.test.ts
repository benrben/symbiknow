import { expect, it } from 'vitest';
import type { JevInputDocument } from './context.js';
import { sharedSourceCategories } from './source-categories.js';

function document(id: string, content: string): JevInputDocument {
  return { canvasId: 'canvas', block: { id, title: id, content, file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 1, height: 1, links: [] },
    snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id, incarnation: id, sourceGeneration: 2, metadataRevision: 3, contentHash: id } };
}

it('shares readable visible categories across local sources with exact original offsets and deduplicates each source', () => {
  const source = document('one', '---\nformat: html\n---\n<head><style>Invented · Topic</style></head><body><span>AI &amp; agents · Tools</span><div>AI &amp; agents · Details</div><p>Tools operate through checked API calls.</p></body>');
  const second = document('two', '<body><span>ai &amp; agents · Chat</span><p>Chat uses source evidence.</p></body>');
  const categories = sharedSourceCategories([source, second], source);
  expect(categories).toHaveLength(1);
  expect(categories[0].name).toBe('AI & agents');
  expect(categories[0].sources).toEqual([source, second]);
  expect(categories[0].origins.map(origin => origin.quote)).toEqual(['AI &amp; agents · Tools', 'ai &amp; agents · Chat']);
  for (const origin of categories[0].origins) {
    const original = [source, second].find(document => document.block.id === origin.source.blockId)!;
    expect(origin.source).toBe(original.snapshot);
    expect(original.block.content.slice(origin.start, origin.end)).toBe(origin.quote);
  }
});

it('rejects blank, tiny, overlong and absent category captions without synthesizing a topic', () => {
  const source = document('one', `Normal prose.\n\n · Blank\n\nA · Tiny\n\n${'Long'.repeat(11)} · Oversized`);
  expect(sharedSourceCategories([source, document('two', source.block.content)], source)).toEqual([]);
  expect(sharedSourceCategories([], source)).toEqual([]);
});

it('requires the selected source to participate in a recurring category', () => {
  const source = document('one', 'Independent source facts.');
  const neighbors = [document('two', 'Platform · Architecture'), document('three', 'Platform · API')];
  expect(sharedSourceCategories([source, ...neighbors], source)).toEqual([]);
  expect(sharedSourceCategories([neighbors[0]], neighbors[0])).toEqual([]);
});

it('excludes archived, processing-excluded, foreign canvas and foreign workspace evidence from category support', () => {
  const source = document('one', 'Platform · Architecture');
  const archived = document('archive', 'Platform · Archive'); archived.block.archived = true;
  const excluded = document('excluded', 'Platform · Secret'); excluded.block.processingExcluded = true;
  const elsewhere = document('elsewhere', 'Platform · External'); elsewhere.canvasId = 'other';
  const foreign = document('foreign', 'Platform · Private'); foreign.snapshot.workspaceId = 'private-workspace';
  const documents = [source, archived, excluded, elsewhere, foreign];
  expect(sharedSourceCategories(documents, source)).toEqual([]);
  const local = document('local', 'Platform · Storage');
  expect(sharedSourceCategories([...documents, local], source)[0].sources).toEqual([source, local]);
});

it('ranks categories by distinct local source support while keeping every exact source origin', () => {
  const source = document('one', 'Operations · Deployment\n\nPlatform · Architecture');
  const second = document('two', 'Platform · Storage\n\nOperations · Testing');
  const third = document('three', 'Platform · API');
  const categories = sharedSourceCategories([source, second, third], source);
  expect(categories.map(category => [category.name, category.sources.length, category.origins.length])).toEqual([
    ['Platform', 3, 3], ['Operations', 2, 2],
  ]);
});

it('bounds nominations to opening visible passages instead of scanning unrelated later lists', () => {
  const prefix = Array.from({ length: 12 }, (_, index) => `Independent body passage ${index}.`).join('\n\n');
  const source = document('one', `${prefix}\n\nUnrelated · Later caption`);
  expect(sharedSourceCategories([source, document('two', 'Unrelated · Another source')], source)).toEqual([]);
});

it('names a Markdown field caption by its readable value, not its source syntax', () => {
  const caption = (tool: string) => `# \`${tool}\`\n\n**Group:** Documents · **REST call:** \`GET /api/${tool}\``;
  const source = document('one', caption('read_doc'));
  const categories = sharedSourceCategories([source, document('two', caption('edit_doc'))], source);
  expect(categories.map(category => category.name)).toEqual(['Documents']);
});

it('nominates repeated category headings across distinct document titles before any profile exists', () => {
  const source = document('sso', '# SSO security review\n\n## Security\n\nSSO enforcement requires a passing security test.');
  const pen = document('pen', '# Pen test\n\n## Security\n\nRetest SAML audience validation before approving security.');
  const pricing = document('pricing', '# Pricing decision\n\n## Pricing\n\nApproved enterprise pricing.');
  const categories = sharedSourceCategories([source, pen, pricing], source);
  expect(categories.map(category => category.name)).toEqual(['Security']);
  expect(categories[0].origins.map(origin => origin.quote)).toEqual(['## Security', '## Security']);
  const runbook = document('runbook', '# Rollback runbook\n\n## Release\n\nRestore the prior deployment.');
  const copy = document('copy', runbook.block.content);
  const blockers = document('blockers', '# Launch blockers\n\n## Release\n\nRehearse rollback before launch.');
  expect(sharedSourceCategories([runbook, copy, blockers], runbook).map(category => category.name)).toEqual(['Release']);
});

it('keeps shared parent hierarchies and manually supplied label categories instead of flattening them', () => {
  const source = document('one', '# Engineering\n\n## Backend\n\nBuild checked APIs.');
  const reference = document('two', '# Engineering\n\n## Backend\n\nPersist backend contracts.');
  expect(sharedSourceCategories([source, reference], source)).toEqual([]);
  const tagged = document('tagged', '# Architecture\n\n## Storage\n\nAtlas architecture records persistence.'); tagged.block.tags = ['Atlas'];
  const other = document('other', '# API\n\n## Storage\n\nAtlas API records persistence.'); other.block.tags = ['Atlas'];
  expect(sharedSourceCategories([tagged, other], tagged)).toEqual([]);
});
it('distinguishes managed labels from owner-pinned categories when nominating repeated headings', () => {
  const source = document('one', '# Architecture\n\n## Storage\n\nPersistence uses durable records.');
  const reference = document('two', '# API\n\n## Storage\n\nPersistence exposes checked interfaces.');
  for (const item of [source, reference]) {
    item.block.tags = ['Technical'];
    item.block.jevOwnership = { managed: ['tags'], pins: [], removedLabels: [], removedLinks: [] };
  }
  expect(sharedSourceCategories([source, reference], source).map(group => group.name)).toEqual(['Storage']);
  source.block.jevOwnership!.pins = ['tags'];
  expect(sharedSourceCategories([source, reference], source)).toEqual([]);
});
