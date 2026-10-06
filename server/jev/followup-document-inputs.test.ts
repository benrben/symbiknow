import { expect, it } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevDocumentPatch, JevProposal, JevReceipt } from '../../shared/jev-types.js';
import { emptyJevWorkspace } from './workspace.js';
import { OrganizationDocumentProjection, organizationOwnership } from './followup-document-inputs.js';
import { sourceSnapshot } from './stamps.js';
import { automaticOrganizationReceipt } from './followup-receipt-origin.js';

function block(): CanvasBlock {
  return { id: 'doc', file: 'docs/doc.md', kind: 'markdown', title: 'Source', content: '# Source',
    x: 4, y: 5, width: 280, height: 180, incarnation: 'original', sourceGeneration: 1, metadataRevision: 3,
    group: 'custom:automatic', tags: ['Manual', 'First', 'Second'], links: ['manual', 'automatic'],
    linkTypes: { manual: 'related', automatic: 'implements' },
    crossLinks: [{ canvasId: 'other', blockId: 'manual', relation: 'related' }, { canvasId: 'other', blockId: 'automatic', relation: 'implements' }],
    headline: 'Generated headline', freshness: { reviewAt: '2026-10-04T00:00:00Z' },
    jevOwnership: { managed: ['group', 'tags', 'links', 'crossLinks', 'headline', 'freshness', 'link:canvas:automatic'],
      pins: [], removedLabels: ['Removed'], removedLinks: ['removed-link'] } };
}
function receipt(id: string, before: JevDocumentPatch, after: JevDocumentPatch): JevReceipt {
  return { id, proposalId: id, action: 'label', createdAt: '2026-10-04T00:00:00Z', actor: 'automation',
    state: 'applied', automatic: true, before: { kind: 'document', canvasId: 'canvas', blockId: 'doc', patch: before },
    after: { kind: 'document', canvasId: 'canvas', blockId: 'doc', patch: after }, sourcesAfter: [sourceSnapshot('workspace', 'canvas', block())] };
}
function project(current: CanvasBlock, receipts: JevReceipt[] = [], proposals: JevProposal[] = []): CanvasBlock {
  return new OrganizationDocumentProjection({ ...emptyJevWorkspace(), receipts, proposals }).project('canvas', current);
}
function proposal(id: string, jobId = 'automatic-job'): JevProposal {
  const source = sourceSnapshot('workspace', 'canvas', block());
  return { id, jobId, action: 'label', state: 'applied', createdAt: '2026-10-04T00:00:00Z', title: 'Generated label', explanation: 'Checked source',
    mutation: { kind: 'document', canvasId: 'canvas', blockId: 'doc', patch: { tags: ['Second'] } }, sources: [source],
    evidence: [{ source, start: 0, end: 8, quote: '# Source' }] };
}

it('reverses exact automatic literal patches to mixed manual baselines without reading canvas proofs or mutating receipts', () => {
  const current = block();
  const first = receipt('first', { tags: ['Manual'] }, { tags: ['Manual', 'First'] });
  const second = receipt('second', { tags: ['Manual', 'First'], group: null, links: ['manual'], linkTypes: { manual: 'related' },
    crossLinks: [current.crossLinks![0]], headline: null, freshness: null },
  { tags: current.tags, group: current.group, links: current.links, linkTypes: current.linkTypes,
    crossLinks: current.crossLinks, headline: current.headline, freshness: current.freshness });
  Object.defineProperty(second, 'preparedArtifacts', { get: () => { throw new Error('Native proofs must remain unread'); } });
  const baseline = project(current, [first, second]);
  expect(baseline).toMatchObject({ tags: ['Manual'], links: ['manual'], linkTypes: { manual: 'related' }, crossLinks: [current.crossLinks![0]], x: 4, y: 5 });
  expect(baseline.group).toBeUndefined(); expect(baseline.headline).toBeUndefined(); expect(baseline.freshness).toBeUndefined();
  baseline.tags!.push('Later consumer mutation'); baseline.crossLinks![0].relation = 'prerequisite';
  expect(first.before).toMatchObject({ patch: { tags: ['Manual'] } });
  expect(second.before).toMatchObject({ patch: { crossLinks: [{ relation: 'related' }] } });
  expect(current.tags).toEqual(['Manual', 'First', 'Second']); expect(current.crossLinks![0].relation).toBe('related');
});

it.each(['group', 'tags', 'links', 'linkTypes', 'crossLinks'] as const)('keeps a pinned %s even when its latest value equals a trusted automatic patch', field => {
  const current = block(); current.jevOwnership!.pins.push(field);
  const patch = { [field]: current[field] } as JevDocumentPatch;
  expect(project(current, [receipt('pinned', { [field]: null }, patch)])[field]).toEqual(current[field]);
  if (field === 'linkTypes') expect(project(current, [receipt('links', { links: [] }, { links: current.links })]).links).toEqual(current.links);
});

it('keeps explicit manual management, missing ownership and unrecorded values instead of treating permission as origin', () => {
  const current = block(); const generated = receipt('known', { group: null }, { group: current.group });
  current.jevOwnership!.managed = current.jevOwnership!.managed.filter(field => field !== 'group');
  expect(project(current, [generated]).group).toBe(current.group);
  delete current.jevOwnership; expect(project(current, [generated])).toEqual(current);
  expect(project(block())).toEqual(block());
});

it.each(['incarnation', 'canvas', 'block', 'value', 'inverse', 'manual', 'reviewer', 'override', 'undo'] as const)(
  'keeps ambiguous or externally controlled %s values as inputs', boundary => {
    const current = block(); const generated = receipt('boundary', { tags: ['Manual'] }, { tags: current.tags });
    const origin = proposal('boundary');
    if (boundary === 'incarnation') generated.sourcesAfter[0].incarnation = 'old';
    if (boundary === 'canvas') generated.sourcesAfter[0].canvasId = 'elsewhere';
    if (boundary === 'block') generated.sourcesAfter[0].blockId = 'elsewhere';
    if (boundary === 'value') (generated.after as Extract<JevReceipt['after'], { kind: 'document' }>).patch.tags = ['Different'];
    if (boundary === 'inverse') delete (generated.before as Extract<JevReceipt['before'], { kind: 'document' }>).patch.tags;
    if (boundary === 'manual') { generated.automatic = false; origin.evidence = []; }
    if (boundary === 'reviewer') origin.reviewerEdited = true;
    if (boundary === 'override') origin.jobId = 'override:manual-edit';
    if (boundary === 'undo') origin.jobId = 'undo:receipt';
    expect(project(current, [generated], [origin]).tags).toEqual(current.tags);
  });

it('uses manual and Undo receipts as barriers, including coincident same-value restores after older automatic writes', () => {
  const current = block(); current.tags = ['Final'];
  const older = receipt('old', { tags: ['Manual'] }, { tags: ['Final'] });
  const manual = receipt('manual', { tags: ['Final'] }, { tags: ['Final'] }); manual.automatic = false;
  expect(project(current, [older, manual]).tags).toEqual(['Final']);
  const undo = proposal('manual', 'undo:old');
  expect(project(current, [older, manual], [undo]).tags).toEqual(['Final']);
});

it('reverses a checked automatic null clearing to its manual value while keeping both absent-value normalization branches', () => {
  const current = block(); delete current.group;
  const cleared = receipt('cleared', { group: 'custom:manual' }, { group: null });
  expect(project(current, [cleared]).group).toBe('custom:manual');
});

it.each(['undone', 'derived-before', 'derived-after', 'inverse-canvas', 'inverse-block'] as const)(
  'does not apply an invalid %s receipt target', boundary => {
    const current = block(); const generated = receipt('invalid', { group: null }, { group: current.group });
    if (boundary === 'undone') generated.state = 'undone';
    if (boundary === 'derived-before') generated.before = { kind: 'derived', values: {} };
    if (boundary === 'derived-after') generated.after = { kind: 'derived', values: {} };
    if (boundary === 'inverse-canvas') (generated.before as Extract<JevReceipt['before'], { kind: 'document' }>).canvasId = 'elsewhere';
    if (boundary === 'inverse-block') (generated.before as Extract<JevReceipt['before'], { kind: 'document' }>).blockId = 'elsewhere';
    expect(project(current, [generated]).group).toBe(current.group);
  });

it('ignores unrelated patches while reversing each independently managed field and preserves source generation changes as separate inputs', () => {
  const current = block(); current.sourceGeneration = 7;
  const known = receipt('labels', { tags: ['Manual'] }, { tags: current.tags });
  const unrelated = receipt('other-field', { group: null }, { group: current.group });
  expect(project(current, [known, unrelated])).toMatchObject({ tags: ['Manual'], sourceGeneration: 7 });
});

it('retains stable sorted permissions and all correction memory while excluding generated edge markers', () => {
  const current = block(); current.jevOwnership!.pins = ['tags', 'group'];
  current.jevOwnership!.removedLabels = ['Z', 'A']; current.jevOwnership!.removedLinks = ['Z', 'A'];
  const original = structuredClone(current.jevOwnership);
  expect(organizationOwnership(current.jevOwnership)).toEqual({ pins: ['group', 'tags'], removedLabels: ['A', 'Z'], removedLinks: ['A', 'Z'],
    managed: ['crossLinks', 'freshness', 'group', 'headline', 'links', 'tags'] });
  expect(current.jevOwnership).toEqual(original); expect(organizationOwnership()).toBeUndefined();
});

it('retains automatic flags without proposals, checked approval origins and manual-origin failures distinctly', () => {
  const generated = receipt('origin', { group: null }, { group: block().group });
  expect(automaticOrganizationReceipt(generated)).toBe(true);
  generated.automatic = false; expect(automaticOrganizationReceipt(generated)).toBe(false);
  const original = proposal('origin'); expect(automaticOrganizationReceipt(generated, original)).toBe(true);
  original.sources = []; expect(automaticOrganizationReceipt(generated, original)).toBe(false);
  generated.state = 'undone'; expect(automaticOrganizationReceipt(generated, original)).toBe(false);
});
