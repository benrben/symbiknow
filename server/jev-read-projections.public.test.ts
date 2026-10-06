import { expect, it } from 'vitest';
import { emptyJevWorkspace } from './jev/workspace.js';
import { projectJevState } from './jev-read-projections.js';
import type { JevJob, JevProposal, JevReceipt, JevSourceSnapshot } from '../shared/jev-types.js';

function source(canvasId: string, blockId: string): JevSourceSnapshot {
  return { workspaceId: 'fixture', canvasId, blockId, incarnation: 'one', sourceGeneration: 1,
    contentHash: 'hash', metadataRevision: 1 };
}
function job(id: string, canvasId: string, blockIds?: string[], updatedAt = '2026-01-01'): JevJob {
  return { id, request: { action: 'label', canvasId, blockIds, query: 'release' }, state: 'completed',
    createdAt: updatedAt, updatedAt, sources: [source(canvasId, blockIds?.[0] ?? id)], proposalIds: [] };
}
function proposal(id: string, canvasId: string, blockId: string, createdAt = '2026-01-01'): JevProposal {
  return { id, jobId: 'job-a', action: 'label', title: `Release ${id}`, explanation: 'Review release',
    confidence: 0.9, evidence: [], sources: [source(canvasId, blockId)],
    mutation: { kind: 'document', canvasId, blockId, patch: { tags: ['release'] } },
    state: 'pending', createdAt };
}
function receipt(id: string, sourcesAfter: JevSourceSnapshot[], createdAt = '2026-01-01'): JevReceipt {
  const mutation = { kind: 'document' as const, canvasId: 'operations', blockId: 'runbook', patch: {} };
  return { id, proposalId: id, action: 'label', state: 'applied', actor: 'reviewer', createdAt,
    before: mutation, after: mutation, sourcesAfter };
}

it('keeps compatibility memory navigation within the requested canvas and document before paging', () => {
  const state = emptyJevWorkspace();
  state.vocabulary.push(
    { id: 'release', kind: 'label', name: 'Release', definition: 'Release process', aliases: [], state: 'active', version: 1,
      members: [{ canvasId: 'operations', blockId: 'runbook' }] },
    { id: 'private', kind: 'label', name: 'Private', definition: 'Private research', aliases: [], state: 'active', version: 1,
      members: [{ canvasId: 'research', blockId: 'notes' }] },
  );
  const scoped = projectJevState('memory_map', state, undefined, '', { canvasId: 'operations', limit: 1, paginated: true });
  expect(scoped).toEqual({ items: [expect.objectContaining({ id: 'release', memberCount: 1 })], nextCursor: undefined });
  expect(projectJevState('memory_map', state, 'notes', '', { canvasId: 'operations' })).toEqual([]);
  expect(projectJevState('memory_map', state, 'runbook', 'release', { canvasId: 'operations' }))
    .toEqual([expect.objectContaining({ id: 'release', memberCount: 1 })]);
});

it('scopes compact activity and receipt sources before filtering and pagination', () => {
  const state = emptyJevWorkspace();
  state.jobs.push(job('job-a', 'operations', ['runbook'], '2026-01-03'),
    job('job-b', 'operations', undefined, '2026-01-02'), job('foreign', 'research', ['runbook'], '2026-01-04'));
  state.jobs[0].error = 'x'.repeat(300);
  state.receipts.push(receipt('old', [source('operations', 'runbook')]),
    receipt('mixed', [source('operations', 'runbook'), source('research', 'secret')], '2026-01-03'),
    receipt('foreign', [source('research', 'secret')], '2026-01-04'));
  const first = projectJevState('jev_activity', state, undefined, 'label',
    { canvasId: 'operations', limit: 1 }) as { jobs: Array<{ id: string; error?: string; blockIds: string[] }>;
      receipts: Array<{ id: string; sources: Array<{ canvasId: string; blockId: string }> }>; nextCursor?: string };
  expect(first.jobs.map(item => item.id)).toEqual(['job-a']);
  expect(first.jobs[0].error).toHaveLength(240);
  expect(first.receipts).toEqual([{ id: 'mixed', proposalId: 'mixed', action: 'label', state: 'applied',
    actor: 'reviewer', createdAt: '2026-01-03', automatic: undefined,
    sources: [{ canvasId: 'operations', blockId: 'runbook' }] }]);
  expect(first.nextCursor).toBe('1');
  const second = projectJevState('jev_activity', state, undefined, 'label',
    { canvasId: 'operations', limit: 1, cursor: 1 }) as { jobs: Array<{ id: string; blockIds: string[] }>;
      receipts: Array<{ id: string }>; nextCursor?: string };
  expect(second.jobs).toEqual([expect.objectContaining({ id: 'job-b', blockIds: [] })]);
  expect(second.receipts.map(item => item.id)).toEqual(['old']);
  expect(second.nextCursor).toBeUndefined();
  state.jobs[1].request.query = undefined;
  const byQuestion = projectJevState('jev_activity', state, undefined, 'release', { canvasId: 'operations' }) as
    { jobs: Array<{ id: string }> };
  expect(byQuestion.jobs.map(item => item.id)).toEqual(['job-a']);
  const bySource = projectJevState('jev_activity', state, 'runbook', 'completed', { canvasId: 'operations' }) as
    { jobs: Array<{ id: string }> };
  expect(bySource.jobs.map(item => item.id)).toEqual(['job-a']);
  const forbidden = projectJevState('jev_activity', state, 'secret', '', { canvasId: 'operations' });
  expect(forbidden).toMatchObject({ jobs: [], receipts: [] });
});

it('keeps pending inbox entries within the canvas and excludes cross-canvas mutations', () => {
  const state = emptyJevWorkspace();
  const recent = proposal('recent', 'operations', 'runbook', '2026-01-03');
  const old = proposal('old', 'operations', 'runbook', '2026-01-01');
  const foreign = proposal('foreign', 'research', 'notes', '2026-01-04');
  const mixed = proposal('mixed', 'operations', 'runbook', '2026-01-05');
  mixed.sources.push(source('research', 'secret'));
  const move = proposal('move', 'operations', 'runbook', '2026-01-06');
  move.mutation = { kind: 'move', canvasId: 'operations', blockId: 'runbook', targetCanvasId: 'research' };
  const applied = proposal('applied', 'operations', 'runbook', '2026-01-07');
  applied.state = 'applied';
  state.proposals.push(old, recent, foreign, mixed, move, applied);
  const first = projectJevState('brain_inbox', state, 'runbook', 'RELEASE',
    { canvasId: 'operations', limit: 1, paginated: true }) as { items: JevProposal[]; nextCursor?: string };
  expect(first.items.map(item => item.id)).toEqual(['recent']);
  expect(first.nextCursor).toBe('1');
  const second = projectJevState('brain_inbox', state, undefined, 'review', { canvasId: 'operations', cursor: 1 }) as JevProposal[];
  expect(second.map(item => item.id)).toEqual(['old']);
  expect(projectJevState('brain_inbox', state, 'secret', '', { canvasId: 'operations' })).toEqual([]);
});

it('scopes job lookup, profiles and memory matches to the requested canvas', () => {
  const state = emptyJevWorkspace();
  state.jobs.push(job('job-a', 'operations', ['runbook']), job('job-b', 'research', ['runbook']));
  state.proposals.push(proposal('visible', 'operations', 'runbook'), proposal('hidden', 'research', 'runbook'));
  expect(projectJevState('jev_job', state, 'job-b', '', { canvasId: 'operations' })).toBeNull();
  expect(projectJevState('jev_job', state, 'missing')).toBeNull();
  expect(projectJevState('jev_job', state, 'job-a', '', { canvasId: 'operations' }))
    .toEqual({ job: expect.objectContaining({ id: 'job-a' }), proposals: [expect.objectContaining({ id: 'visible' })] });
  state.profiles = { 'operations:runbook': { role: 'release' }, 'operations:other': { role: 'draft' },
    'research:runbook': { role: 'private release' }, 'runbook:misleading': { role: 'release' } };
  const profiles = projectJevState('find_by', state, 'runbook', 'RELEASE', { canvasId: 'operations' }) as
    { profiles: Record<string, unknown>; coverage: { selected: number; total: number } };
  expect(profiles.profiles).toEqual({ 'operations:runbook': { role: 'release' } });
  expect(profiles.coverage).toMatchObject({ selected: 1, total: 1 });
  const first = projectJevState('find_by', state, undefined, '', { canvasId: 'operations', limit: 1 }) as
    { profiles: Record<string, unknown>; nextCursor?: string; coverage: { total: number } };
  expect(first.coverage.total).toBe(2);
  expect(first.nextCursor).toBe('1');
  expect(projectJevState('related', state)).toEqual({ items: [],
    reason: 'Use the indexed related-document endpoint for current source relationships.' });
  state.vocabulary.push({ id: 'unused', kind: 'label', name: 'Release', definition: 'Release term', aliases: [],
    state: 'active', version: 1, members: [] },
  { id: 'second', kind: 'group', name: 'Other', definition: 'Release process', aliases: [],
    state: 'active', version: 1, members: [{ canvasId: 'operations', blockId: 'runbook' }] });
  const matchedTerms = projectJevState('memory_map', state, undefined, 'release', { canvasId: 'operations' }) as
    Array<{ id: string }>;
  expect(matchedTerms.map(item => item.id)).toEqual(['second']);
  const termPage = projectJevState('memory_map', state, undefined, '', { limit: 1, paginated: true });
  expect(termPage).toMatchObject({ items: [{ id: 'unused' }], nextCursor: '1' });
});
