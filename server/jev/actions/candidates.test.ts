import { expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../../../shared/types.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { lexicalScore, neighbors, relevantNeighbors, terms } from './candidates.js';

function document(id: string, title: string, content: string, canvasId = 'canvas', workspaceId = 'workspace',
  patch: Partial<CanvasBlock> = {}): JevInputDocument {
  return { canvasId, snapshot: { workspaceId, canvasId, blockId: id, incarnation: id,
    sourceGeneration: 1, metadataRevision: 1, contentHash: id },
  block: { id, title, content, file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [], ...patch } };
}
function context(documents: JevInputDocument[]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents } as JevEvaluationContext;
}

it('tokenizes one source query for 158 eligible candidates while preserving exact ranking, limits and scope', () => {
  const source = document('origin', 'Neighbor source query marker Atlas', 'API revision evidence', 'canvas', 'workspace',
    { tags: ['release', 'צוות'], links: ['linked', 'archived'] });
  const linked = document('linked', 'Brand', 'Colors typography');
  const first = document('atlas-a', 'Atlas release', 'API revision evidence');
  const second = document('atlas-b', 'Atlas release', 'API revision evidence');
  const anotherCanvas = document('origin', 'Atlas release', 'API revision evidence', 'another-canvas');
  const titleMatch = document('title-match', 'Atlas', 'Unrelated subject');
  const extras = Array.from({ length: 153 }, (_, index) => document(`extra-${index}`, 'Ancillary', `Different subject ${index}`));
  const input = context([source, second, linked, titleMatch, anotherCanvas, first, ...extras,
    document('foreign', source.block.title, source.block.content, 'canvas', 'other-workspace', { tags: source.block.tags }),
    document('archived', source.block.title, source.block.content, 'canvas', 'workspace', { archived: true })]);
  const lowerCase = String.prototype.toLocaleLowerCase; let queryCalls = 0;
  const native = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function(this: string, ...args: Parameters<typeof lowerCase>) {
    if (String(this).startsWith('Neighbor source query marker Atlas ')) queryCalls += 1;
    return lowerCase.apply(this, args);
  });
  try {
    expect(neighbors(input, source)).toEqual([linked, first, second, anotherCanvas, titleMatch]);
    expect(queryCalls).toBe(1);
  } finally { native.mockRestore(); }
  expect(neighbors(input, source, 1)).toEqual([linked]);
  expect(neighbors(input, source, 0)).toEqual([]);
  expect(neighbors(input, source, 200)).toHaveLength(158);
  expect(input.documents[0]).toBe(source); expect(source.block.links).toEqual(['linked', 'archived']);
});

it('uses fresh visible content, titles, tags and source text after edits without retaining old rankings', () => {
  const source = document('origin', 'Motor', 'observer redraw');
  const first = document('a', 'Motor', 'Unrelated subject');
  const edited = document('b', 'Brand', '<html><head><style>Motor observer redraw</style></head><body>Unrelated subject</body></html>');
  const design = document('c', 'Design', 'colors typography');
  const input = context([source, first, edited, design]);
  expect(neighbors(input, source, 1)).toEqual([first]);
  edited.block.content = '<html><head><style>Unrelated</style></head><body><p>Motor observer redraw</p></body></html>';
  expect(neighbors(input, source, 1)).toEqual([edited]);
  edited.block.content = 'Unrelated subject'; edited.block.title = 'Motor observer redraw';
  expect(neighbors(input, source, 1)).toEqual([edited]);
  source.block.title = 'Design'; source.block.content = 'colors typography';
  expect(neighbors(input, source, 1)).toEqual([design]);
  source.block.content = ''; source.block.tags = ['Motor', 'observer', 'redraw'];
  expect(neighbors(input, source, 1)).toEqual([edited]);
});

it('retains Unicode term uniqueness and public lexical scores including empty or one-character queries', () => {
  expect(terms('ÉCOLE école ЦЕЛЬ ١٢ שלום 漢字 😀 x')).toEqual(new Set(['école', 'цель', '١٢', 'שלום', '漢字']));
  expect(lexicalScore('ÉCOLE ÉCOLE שלום ١٢ 漢字', 'école שלום ١٢')).toBe(0.75);
  expect(lexicalScore('שלום צוות', 'שלום צוות עובד')).toBe(1);
  expect(lexicalScore('', 'available evidence')).toBe(0);
  expect(lexicalScore('a 😀', 'available evidence')).toBe(0);
  expect(lexicalScore('alpha beta', '')).toBe(0);
});

it('retains stable same-id cross-canvas ties and link boosts when a source has no lexical terms or tags', () => {
  const source = document('origin', '.', '', 'canvas', 'workspace', { links: ['same'] });
  const first = document('same', 'Unrelated first', 'No matching query', 'first');
  const second = document('same', 'Unrelated second', 'No matching query', 'second');
  const anotherCanvas = document('origin', 'Unrelated origin', 'No matching query', 'another');
  const input = context([source, second, anotherCanvas, first]);
  const ranked = neighbors(input, source);
  expect(ranked).toEqual([second, first, anotherCanvas]);
  expect(ranked[0]).toBe(second); expect(ranked[1]).toBe(first);
});

it('admits substantive pair neighbors without filling candidate slots with common-word distractors', () => {
  const source = document('source', 'Release checklist', 'Release engineering checks database migrations, health endpoints, and rollback images.');
  const related = document('related', 'Rollback procedure', 'For release failures, restore the last image and check database and health endpoints.');
  const distractor = document('distractor', 'New hire access', 'Before the first day, the manager requests an account and signs the form.');
  expect(relevantNeighbors(context([source, distractor, related]), source).map(item => item.block.id)).toEqual(['related']);
});

it('uses authorized semantic nominations while rejecting absent, foreign, and excluded IDs', () => {
  const source = document('source', 'Release checklist', 'Deploy the service with a safe rollback plan.');
  const semantic = document('semantic', 'Recovery', 'Restore the prior package when an update fails.');
  const excluded = document('excluded', 'Recovery', 'Restore old data.', 'canvas', 'workspace', { processingExcluded: true });
  const foreign = document('foreign', 'Recovery', 'Restore old data.', 'canvas', 'other-workspace');
  const input = context([source, semantic, excluded, foreign]);
  input.retrievedNeighbors = { 'canvas:source': ['canvas:missing', 'canvas:foreign', 'canvas:excluded', 'canvas:semantic'] };
  expect(relevantNeighbors(input, source).map(item => item.block.id)).toEqual(['semantic']);
});

it('keeps widening pair checks from admitting title-only calendar and metadata distractors', () => {
  const source = document('source', 'Release checklist',
    'Release engineering checks database migrations, health endpoints, and rollback images before deployment.');
  const rollback = document('rollback', 'Rollback procedure',
    'A failed release restores the previous image and checks database migrations and health endpoints.');
  const validation = document('validation', 'Release validation',
    'After deployment, release engineering checks the health endpoint, error rates, and rollback readiness.');
  const calendars = Array.from({ length: 12 }, (_, index) => document(`calendar-${index}`,
    `Release checklist deployment recovery calendar ${index}`,
    'Marketing meeting plans webinar guests, visual assets, and calendar reminders. No service procedure was recorded.'));
  const generic = [
    document('announcement', 'Release checklist announcement',
      'The committee discussed the release calendar and service announcements.'),
    document('procurement', 'Release checklist purchasing',
      'Finance recorded a release budget and service contract for event materials.'),
    document('onboarding', 'Release checklist onboarding',
      'New employees receive accounts, training, and workplace access before their first day.'),
  ];
  const input = context([source, ...calendars, ...generic, rollback, validation]);
  expect(relevantNeighbors(input, source, 5).map(item => item.block.id)).toEqual(['rollback', 'validation']);
  expect(relevantNeighbors(input, source, 12).map(item => item.block.id)).toEqual(['rollback', 'validation']);
  input.retrievedNeighbors = { 'canvas:source': ['canvas:validation', 'canvas:rollback'] };
  expect(relevantNeighbors(input, source, 12).map(item => item.block.id)).toEqual(['rollback', 'validation']);
});

it('keeps an explicit source link and a scoped semantic paraphrase despite lexical body filtering', () => {
  const source = document('source', 'Update policy', 'Deploying a new service package requires an emergency reversal plan.',
    'canvas', 'workspace', { links: ['manual'] });
  const manual = document('manual', 'Recorded decision', 'Incident owner approved the migration.');
  const semantic = document('semantic', 'Recovery playbook', 'Restore the prior image when health checks fail.');
  const input = context([source, manual, semantic]);
  input.retrievedNeighbors = { 'canvas:source': ['canvas:semantic'] };
  expect(relevantNeighbors(input, source).map(item => item.block.id)).toEqual(['semantic', 'manual']);
});

it('nominates short explicit body references to scoped document titles without pre-tags or semantic retrieval', () => {
  const source = document('pricing', 'Pricing tiers decision', 'Enterprise requires the SSO review to be complete.');
  const sso = document('sso', 'SSO security review', 'Validate administrator authentication before approval.');
  const pen = document('pen', 'Pen test findings', 'Check the penetration assessment results.');
  const pricing = document('decision', 'Pricing tiers decision', 'Approved Pro charge: $24.');
  const access = document('access', 'Access control policy', 'Administrators must authenticate securely.');
  expect(relevantNeighbors(context([source, sso]), source)).toEqual([sso]);
  source.block.content = 'Review the pen-test, pricing decision, and access policy before publishing.';
  const documents = [source, sso, pen, pricing, access,
    document('foreign', pen.block.title, pen.block.content, 'canvas', 'foreign'),
    document('archived', pricing.block.title, pricing.block.content, 'canvas', 'workspace', { archived: true }),
    document('excluded', access.block.title, access.block.content, 'canvas', 'workspace', { processingExcluded: true })];
  expect(relevantNeighbors(context(documents), source).map(item => item.block.id).sort()).toEqual(['access', 'decision', 'pen']);
  expect(relevantNeighbors(context(documents), source, 1)).toHaveLength(1);
  expect(relevantNeighbors(context(documents), source, 0)).toEqual([]);
});

it('requires a multiword visible body title reference, preserving headings, hidden markup and code boundaries', () => {
  const source = document('source', 'SSO review', '# SSO review\n\n```text\nSSO review\n```\n<script>SSO review</script>\nUnrelated work.');
  const target = document('target', 'SSO security review', 'Administrator authentication approval.');
  const short = document('short', 'Review', 'Administrative approval.');
  const emptyTitle = document('empty-title', '.', 'Other unrelated topic.');
  expect(relevantNeighbors(context([source, target, short, emptyTitle]), source)).toEqual([]);
  source.block.content = 'SSO is mentioned; unrelated work records administrative review.';
  expect(relevantNeighbors(context([source, target]), source)).toEqual([]);
  source.block.content = 'Review SSO before publishing.';
  expect(relevantNeighbors(context([source, target]), source)).toEqual([]);
  source.block.content = 'Unrelated introduction.\n'.repeat(90) + '\nThe SSO review must finish.';
  expect(relevantNeighbors(context([source, target]), source)).toEqual([target]);
});
