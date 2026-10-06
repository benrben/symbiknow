import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { JevMutation, JevReceipt } from '../../shared/jev-types.js';
import { createApiServer } from '../index.js';
import { compactJevState } from './compact-state.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

function receipt(id: string, before: JevMutation, after = before): JevReceipt {
  return { id, proposalId: id, action: 'profile', createdAt: '2026-10-04T12:00:00Z', actor: 'Jev',
    before, after, sourcesAfter: [], state: 'applied' };
}
function denseState() {
  const state = emptyJevWorkspace();
  const payload = 'Exact saved source evidence. '.repeat(1000);
  state.jobs = Array.from({ length: 158 }, (_, index) => ({ id: `job-${index}`, request: { action: 'profile' as const, canvasId: 'product-roadmap', blockIds: [`doc-${index}`] },
    state: 'completed' as const, createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z',
    sources: [], result: { status: 'profiled', evidence: payload }, proposalIds: [`proposal-${index}`] }));
  state.jobs.push({ ...state.jobs[0], id: 'job-empty', result: undefined });
  state.profiles = Object.fromEntries(Array.from({ length: 158 }, (_, index) => [`product-roadmap:doc-${index}`,
    { role: 'reference', keyPassages: [{ quote: `Evidence ${index}` }, { quote: payload }], qualityRubric: { evidence: payload } }]));
  state.profiles['product-roadmap:legacy'] = { keyPassages: 'Old profile', role: 'unknown' };
  state.receipts = [
    receipt('document', { kind: 'document', canvasId: 'product-roadmap', blockId: 'doc-0', patch: { tags: [payload] } }),
    receipt('content', { kind: 'content', canvasId: 'product-roadmap', blockId: 'doc-1', content: payload, expectedContentHash: 'hash', draftId: 'draft' }),
    receipt('move', { kind: 'move', canvasId: 'product-roadmap', blockId: 'doc-2', targetCanvasId: 'engineering' }),
    receipt('derived', { kind: 'derived', blockId: 'doc-3', values: { evidence: payload } }),
    receipt('task', { kind: 'task_delete', canvasId: 'product-roadmap', taskId: 'task', expectedUpdatedAt: 'now' }),
  ];
  return state;
}

it('keeps progress and canvas invalidation identity while excluding heavy findings without mutating the saved ledger', () => {
  const state = denseState(); const before = structuredClone(state);
  const compact = compactJevState(state);
  expect(compact.settings).toEqual(state.settings);
  expect(compact.jobs[0]).toEqual({ ...state.jobs[0], result: { status: 'profiled',
    progressOutcome: { state: 'no_change', reason: 'profiled' } }, sources: [], proposalIds: [] });
  expect(compact.jobs.at(-1)?.result).toEqual({ status: null,
    progressOutcome: { state: 'no_change', reason: 'No supported change' } });
  expect(compact.profiles['product-roadmap:doc-0']).toEqual({ role: 'reference', keyPassages: [{ quote: 'Evidence 0' }] });
  expect(compact.profiles['product-roadmap:legacy']).toEqual({ role: 'unknown', keyPassages: [] });
  expect(compact.receipts.map(item => item.id)).toEqual(['document', 'content', 'move']);
  expect(compact.receipts[0].after).toMatchObject({ kind: 'document', patch: {} });
  expect(compact.receipts[1].after).toMatchObject({ kind: 'content', content: '' });
  expect(compact.receipts[2]).toEqual(state.receipts[2]);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(state).length / 30);
  expect(state).toEqual(before);
});

it('keeps superseded cancellation records durable while omitting them from routine progress', () => {
  const state = denseState();
  state.jobs.push({ ...state.jobs[0], id: 'superseded', state: 'cancelled', error: 'Superseded by a newer source revision' });
  expect(state.jobs.at(-1)?.id).toBe('superseded');
  expect(compactJevState(state).jobs.some(job => job.id === 'superseded')).toBe(false);
});

it('retains exact saved progress and distinguishes changed, held, waiting, and failed actions', () => {
  const state = emptyJevWorkspace(); const template = denseState().jobs[0];
  const job = (id: string, fields: Partial<typeof template>) => ({ ...template, id, proposalIds: [], ...fields });
  state.jobs = [
    job('saved', { state: 'failed', result: { progressOutcome: { state: 'changed', reason: 'Durable choice' } } }),
    job('failed', { state: 'failed', error: 'Offline check failed', result: undefined }),
    job('failed-default', { state: 'failed', result: undefined }),
    job('waiting', { state: 'running', result: undefined }),
    job('changed', { proposalIds: ['applied'], result: { status: 'checked' } }),
    job('held', { proposalIds: ['held'], result: { status: 'checked' } }),
    job('reason', { result: { status: 'checked', reason: 'Insufficient evidence' } }),
  ];
  state.proposals = [
    { id: 'applied', state: 'applied' }, { id: 'held', state: 'dismissed', automaticHoldReason: 'Pinned by owner' },
  ] as typeof state.proposals;
  const outcomes = compactJevState(state).jobs.map(item => item.result?.progressOutcome);
  expect(outcomes).toEqual([
    { state: 'changed', reason: 'Durable choice' }, { state: 'failed', reason: 'Offline check failed' },
    { state: 'failed', reason: 'Decision failed' }, { state: 'waiting' }, { state: 'changed' },
    { state: 'no_change', reason: 'Pinned by owner' },
    { state: 'no_change', reason: 'Insufficient evidence' },
  ]);
});

it('keeps compact durable action progress without exposing the active intent or context proof', () => {
  const state = emptyJevWorkspace(); const template = denseState().jobs[0];
  state.jobs = [{ ...template, id: 'document-root', documentPlan: { version: 2,
    originalSources: [{ blockId: 'first' }, { blockId: 'second' }], completedActions: ['profile'],
    activeJob: { id: 'active-private-intent' }, contextProof: { sources: ['private-evidence'] },
    claimPreparedAt: '2026-10-06T00:00:00Z', queueWaitMs: 0 } }] as unknown as typeof state.jobs;
  const compact = compactJevState(state);
  expect((compact.jobs[0] as typeof compact.jobs[0] & { documentPlan?: Record<string, unknown> }).documentPlan)
    .toMatchObject({ version: 2, originalSources: [{ blockId: 'first' }], completedActions: ['profile'] });
  expect(JSON.stringify(compact.jobs[0])).not.toContain('active-private-intent');
  expect(JSON.stringify(compact.jobs[0])).not.toContain('private-evidence');
  expect(JSON.stringify(state.jobs[0])).toContain('private-evidence');
});

it('serves a compact owner poll then the exact full analysis on demand through native HTTP', async () => {
  for (const key of ['SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'TYPESAFE_API_KEY']) vi.stubEnv(key, '');
  const root = await mkdtemp(path.join(tmpdir(), 'jev-compact-http-')); let server: Server | undefined;
  try {
    server = await createApiServer({ dataDir: root });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing API address');
    const url = `http://127.0.0.1:${address.port}/api/workspaces/acme-team/jev/state`;
    expect((await fetch(url)).status).toBe(200);
    const files = new JevWorkspaceFiles(root); const state = denseState(); await files.write('acme-team', state);
    const summaryResponse = await fetch(url + '?summary=1'); expect(summaryResponse.status).toBe(200);
    const summary = await summaryResponse.json();
    expect(summary).toMatchObject({ summary: true, canConfigure: true, hasApiKey: false, profiles: {
      'product-roadmap:doc-0': { role: 'reference', keyPassages: [{ quote: 'Evidence 0' }] } } });
    expect(summary.jobs[0].result).toEqual({ status: 'profiled',
      progressOutcome: { state: 'no_change', reason: 'profiled' } });
    const full = await fetch(url).then(response => response.json());
    expect(full.summary).toBe(false); expect(full.profiles).toEqual(state.profiles); expect(full.jobs).toEqual(state.jobs);
    expect(await files.read('acme-team')).toEqual(state);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  }
});
