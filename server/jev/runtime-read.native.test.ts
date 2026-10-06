import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevPrincipal, JevProposal, JevSourceSnapshot } from '../../shared/jev-types.js';
import { readJevWorkspace } from './runtime-read.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

let root: string; let files: JevWorkspaceFiles;
const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canConfigure: true, canApprove: true };
const source = (canvasId: string): JevSourceSnapshot => ({ workspaceId: 'workspace', canvasId, blockId: 'source',
  incarnation: 'incarnation', sourceGeneration: 1, metadataRevision: 1, contentHash: 'exact-hash' });
function proposal(id: string, canvasId: string, jobId = 'automatic-job'): JevProposal {
  return { id, jobId, action: 'file', title: 'Checked filing', explanation: 'Saved source evidence', evidence: [],
    sources: [source(canvasId)], mutation: { kind: 'document', canvasId, blockId: 'source', patch: { group: 'custom:release' } },
    state: 'applied', createdAt: '2026-10-04T12:00:00Z' };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-runtime-read-')); files = new JevWorkspaceFiles(root);
  const state = emptyJevWorkspace();
  state.profiles = { 'visible:source': { role: 'reference', keyPassages: ['Exact visible passage'], detail: 'full visible analysis' },
    'hidden:source': { role: 'report', keyPassages: ['Hidden passage'] },
    'visible:cross-scope': { role: 'report', scopedCanvasIds: ['visible', 'hidden'] } };
  state.proposals = [proposal('visible', 'visible'), proposal('hidden', 'hidden'), proposal('internal', 'visible', 'origin-migration:internal')];
  state.receipts = state.proposals.map(item => ({ id: `receipt-${item.id}`, proposalId: item.id, action: item.action,
    createdAt: item.createdAt, actor: 'Jev', before: item.mutation, after: item.mutation,
    sourcesAfter: item.sources, state: 'applied' }));
  state.jobs = ['visible', 'hidden'].map(canvasId => ({ id: `job-${canvasId}`, request: { action: 'profile', canvasId },
    state: 'completed', createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z', sources: [source(canvasId)],
    proposalIds: [canvasId], result: { status: 'profiled', analysis: 'full analysis' } }));
  Object.assign(state, { resetJournal: { secret: 'internal recovery artifacts' } });
  await files.write('workspace', state);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('returns compact owner progress with visible receipts while keeping full findings available and recovery records private', async () => {
  const progress = await readJevWorkspace(files, 'workspace', owner, true);
  expect(progress.proposals).toEqual([]);
  expect(progress.receipts.map(receipt => receipt.id)).toEqual(['receipt-visible', 'receipt-hidden']);
  expect(progress.receipts.every(receipt => receipt.after.kind === 'document' && Object.keys(receipt.after.patch).length === 0)).toBe(true);
  expect(progress.jobs[0].result).toEqual({ status: 'profiled', progressOutcome: { state: 'changed' } });
  expect(progress.profiles['visible:source']).toEqual({ role: 'reference', keyPassages: ['Exact visible passage'] });
  expect(progress).not.toHaveProperty('resetJournal');
  const full = await readJevWorkspace(files, 'workspace', owner, false);
  expect(full.profiles['visible:source'].detail).toBe('full visible analysis');
  expect(full.proposals.map(item => item.id)).toEqual(['visible', 'hidden']);
  expect(full.receipts[0].after).toMatchObject({ kind: 'document', patch: { group: 'custom:release' } });
  expect(full).not.toHaveProperty('resetJournal');
  expect(await files.read('workspace')).toHaveProperty('resetJournal.secret', 'internal recovery artifacts');
});

it.each(['user', 'token'] as const)('scopes %s progress before compacting it, even when an owner progress packet is already cached', async kind => {
  await readJevWorkspace(files, 'workspace', owner, true);
  const restricted: JevPrincipal = { id: 'restricted', kind, access: 'read', allowedCanvasIds: ['visible'] };
  const progress = await readJevWorkspace(files, 'workspace', restricted, true);
  expect(Object.keys(progress.profiles)).toEqual(['visible:source']);
  expect(progress.jobs.map(job => job.id)).toEqual(['job-visible']);
  expect(progress.receipts.map(receipt => receipt.id)).toEqual(['receipt-visible']);
  expect(progress.proposals).toEqual([]);
  expect(JSON.stringify(progress)).not.toContain('Hidden passage');
  expect(JSON.stringify(progress)).not.toContain('internal recovery artifacts');
});

it('preserves legacy root extensions through the canonical fallback when a progress packet cannot represent them', async () => {
  const state = await files.read('workspace');
  Object.assign(state, { codec: { legacyExtension: ['preserved'] }, state: { externalMetadata: true } });
  await files.write('workspace', state);
  expect(await files.readProgress('workspace')).toBeUndefined();
  const progress = await readJevWorkspace(files, 'workspace', owner, true);
  expect(progress).toHaveProperty('codec.legacyExtension', ['preserved']);
  expect(progress).toHaveProperty('state.externalMetadata', true);
  expect(progress.proposals).toEqual([]);
  expect(progress.receipts.map(receipt => receipt.id)).toEqual(['receipt-visible', 'receipt-hidden']);
  expect(progress).not.toHaveProperty('resetJournal');
});
