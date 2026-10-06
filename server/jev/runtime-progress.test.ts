import { expect, it } from 'vitest';
import { emptyJevWorkspace } from './workspace.js';
import { documentProgress, documentProgresses, decisionInspection } from './runtime-progress.js';
import { documentActions, type DocumentJob } from './runtime-document.js';
import { compactJevState } from './compact-state.js';
import { scopedState } from './authorization.js';

function fixture() {
  const state = emptyJevWorkspace();
  const source = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'one', incarnation: 'inc',
    sourceGeneration: 1, metadataRevision: 1, contentHash: 'hash' };
  const root: DocumentJob = { id: 'root', request: { action: 'profile', canvasId: 'canvas', blockIds: ['one'] },
    state: 'running', createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:01.000Z',
    sources: [source], proposalIds: ['profile-proposal'], principal: { id: 'automation', kind: 'automation', access: 'write' },
    authorizationFingerprint: 'fingerprint', settingsKey: 'settings', attempts: 1,
    documentPlan: { version: 2, originalSources: [source], completedActions: ['profile', 'label'],
      claimPreparedAt: '2026-10-06T00:00:00.000Z', queueWaitMs: 0 } };
  const label: DocumentJob = { ...root, id: 'root:label', documentPlan: undefined,
    request: { action: 'label', canvasId: 'canvas', blockIds: ['one'] }, result: { status: 'no_change', reason: 'No supported labels' },
    proposalIds: [], state: 'completed' };
  state.jobs.push(root, label);
  state.proposals.push({ id: 'profile-proposal', jobId: 'root', action: 'profile', title: 'Profile', explanation: 'Evidence',
    evidence: [], sources: [source], mutation: { kind: 'derived', blockId: 'one', values: { role: 'runbook' } },
    state: 'applied', createdAt: '2026-10-06T00:00:01.000Z' });
  return { state, root };
}

it('shows each saved action without scanning receipt history and marks completion only after its durable checkpoint', () => {
  const { state, root } = fixture();
  Object.defineProperty(state, 'receipts', { get() { throw new Error('receipt history scanned'); } });
  const pending = documentProgress(state, root.id)!;
  expect(pending.durable).toBe(false);
  expect(pending.actions.map(action => action.state)).toEqual(['changed', 'no_change', 'waiting', 'waiting', 'waiting', 'waiting']);
  expect(pending.actions[1].reason).toBe('No supported labels');
  root.state = 'completed'; root.documentPlan!.completedActions = [...documentActions];
  expect(documentProgress(state, root.id)!.durable).toBe(false);
  root.documentPlan!.completionPreparedAt = '2026-10-06T00:00:02.000Z';
  expect(documentProgress(state, root.id)).toMatchObject({ durable: true, checkpointId: 'root' });
});

it('reports the failed frontier and exposes detailed evidence only on explicit inspection', () => {
  const { state, root } = fixture();
  root.documentPlan!.failedAction = 'link'; root.documentPlan!.failureReason = 'Provider unavailable';
  expect(documentProgress(state, root.id)!.actions[2]).toMatchObject({ state: 'failed', reason: 'Provider unavailable' });
  expect(decisionInspection(state, root.id, 'profile')).toMatchObject({ jobId: 'root', action: 'profile',
    proposals: [{ id: 'profile-proposal', state: 'applied' }] });
  expect(decisionInspection(state, root.id, 'link')).toBeUndefined();
});

it('retains accurate action outcomes and the root job ID for a canvas-scoped compact poll', () => {
  const { state, root } = fixture();
  root.state = 'completed'; root.documentPlan!.completedActions = [...documentActions];
  root.documentPlan!.completionPreparedAt = '2026-10-06T00:00:02.000Z';
  const scoped = scopedState(state, { id: 'token', kind: 'token', access: 'read', allowedCanvasIds: ['canvas'] });
  const compact = compactJevState(scoped);
  expect(compact.jobs[0].result).toMatchObject({ progressOutcome: { state: 'changed' } });
  expect((compact.jobs[0] as DocumentJob).documentPlan).toBeDefined();
  expect((compact.jobs[0] as DocumentJob).documentPlan).not.toHaveProperty('contextProof');
  const progress = documentProgress(compact, root.id)!;
  expect(progress).toMatchObject({ jobId: root.id, durable: true });
  expect(progress.actions.slice(0, 2)).toMatchObject([
    { action: 'profile', state: 'changed' }, { action: 'label', state: 'no_change', reason: 'No supported labels' }]);
});

it('bounds on-demand inspection while exposing candidate origins and exact retained evidence', () => {
  const { state, root } = fixture();
  root.result = { documents: { one: { decisionOptions: { roleIds: ['runbook'],
    topicCandidates: [{ name: 'Atlas', origin: 'source_heading' }] } } },
  candidateOptions: [{ targetId: 'two', origin: 'shared_index' }], reason: 'Source-backed choice' };
  state.proposals[0].evidence = [{ source: root.sources[0], start: 0, end: 5, quote: 'Atlas' }];
  const detail = decisionInspection(state, root.id, 'profile')!;
  expect(detail.candidateOptions).toEqual(expect.arrayContaining([
    { targetId: 'two', origin: 'shared_index' },
    expect.objectContaining({ blockId: 'one', kind: 'decisionOptions' }),
  ]));
  expect(detail.proposals[0].evidence).toEqual(state.proposals[0].evidence);
  root.result = { candidateOptions: Array.from({ length: 100 }, (_, index) => ({ id: index, origin: 'source_heading',
    description: 'long option'.repeat(300) })),
    details: 'Large private analysis'.repeat(5_000) };
  const bounded = decisionInspection(state, root.id, 'profile')!;
  expect(bounded.candidateOptions).toHaveLength(24);
  expect(bounded.candidateOptions[0]).toMatchObject({ id: 0, origin: 'source_heading', truncated: true });
  expect(bounded.result).toMatchObject({ truncated: true });
});

it('reconstructs changed, retained no-change, failed, and compacted outcomes without receipt reads', () => {
  const { state, root } = fixture();
  Object.defineProperty(state, 'receipts', { get() { throw new Error('receipt history scanned'); } });
  const label = state.jobs.find(job => job.id === 'root:label')!;
  label.result = { progressOutcome: { state: 'no_change', reason: 'Pinned label' } };
  expect(documentProgress(state, root.id)!.actions[1]).toMatchObject({ state: 'no_change', reason: 'Pinned label' });
  label.result = { progressOutcome: { state: 'changed' } };
  expect(documentProgress(state, root.id)!.actions[1]).toMatchObject({ state: 'changed' });
  expect(documentProgress(state, root.id)!.actions[1]).not.toHaveProperty('reason');
  label.result = { progressOutcome: { state: 'invalid' }, status: 'checked' } as typeof label.result;
  label.state = 'failed'; delete label.error;
  expect(documentProgress(state, root.id)!.actions[1]).toMatchObject({ state: 'failed', reason: 'Decision failed' });
  label.state = 'completed'; label.result = { status: 'checked' };
  expect(documentProgress(state, root.id)!.actions[1]).toMatchObject({ state: 'no_change', reason: 'checked' });
  label.result = {};
  expect(documentProgress(state, root.id)!.actions[1]).toMatchObject({ state: 'no_change', reason: 'No supported change' });
  label.proposalIds = ['held-proposal']; state.proposals.push({ ...state.proposals[0], id: 'held-proposal',
    jobId: label.id, state: 'pending', automaticHoldReason: 'Reviewer pinned labels' });
  expect(documentProgress(state, root.id)!.actions[1]).toMatchObject({ state: 'no_change', reason: 'Reviewer pinned labels' });
  state.jobs = state.jobs.filter(job => job.id !== label.id);
  expect(documentProgress(state, root.id)!.actions[1]).toMatchObject({ state: 'no_change',
    reason: 'Completed; detailed decision was compacted' });
});

it('does not advertise a stale checkpoint and handles missing plans, sources, and unknown jobs', () => {
  const { state, root } = fixture();
  expect(documentProgress(state, 'unknown')).toBeUndefined();
  expect(decisionInspection(state, 'unknown', 'profile')).toBeUndefined();
  root.state = 'completed'; root.documentPlan!.completionPreparedAt = '2026-10-06T00:00:02.000Z';
  expect(documentProgress(state, root.id)).toMatchObject({ durable: false });
  root.documentPlan!.failedAction = 'link';
  expect(documentProgress(state, root.id)!.actions[2]).toMatchObject({ state: 'failed', reason: 'Decision failed' });
  root.documentPlan!.failedAction = 'label';
  expect(documentProgress(state, root.id)!.actions[1]).toMatchObject({ state: 'failed',
    decisionId: 'root:label', reason: 'Decision failed' });
  root.documentPlan!.originalSources = [];
  expect(documentProgress(state, root.id)).toBeUndefined();
  expect(documentProgresses(state)).toEqual([]);
  root.documentPlan = undefined;
  expect(decisionInspection(state, root.id, 'profile')).toBeUndefined();
  expect(documentProgresses(state)).toEqual([]);
});

it('uses a saved active decision after restart and keeps scoped progress available', () => {
  const { state, root } = fixture();
  const active = { ...state.jobs[1], id: 'root:link', request: { action: 'link' as const, canvasId: 'canvas', blockIds: ['one'] },
    state: 'running' as const, result: { progressOutcome: { state: 'waiting' as const, reason: 'Checking current links' } } };
  root.documentPlan!.activeJob = { ...active, principal: root.principal, attempts: 1,
    authorizationFingerprint: 'fingerprint', settingsKey: 'settings' };
  root.documentPlan!.completedActions.push('link');
  expect(documentProgress(state, root.id)!.actions[2]).toMatchObject({ state: 'waiting', decisionId: active.id,
    reason: 'Checking current links' });
  expect(decisionInspection(state, root.id, 'link')).toMatchObject({ jobId: active.id, action: 'link' });
  root.documentPlan!.completedActions.pop();
  expect(documentProgress(state, root.id)!.actions[2]).toMatchObject({ state: 'waiting', decisionId: active.id });
  const scoped = scopedState(state, { id: 'token', kind: 'token', access: 'read', allowedCanvasIds: ['canvas'] });
  expect(documentProgress(scoped, root.id)!.actions[2]).toMatchObject({ state: 'waiting' });
  expect(documentProgresses(scoped)).toHaveLength(1);
});

it('bounds malformed inspection options and excludes evidence absent from the reviewed source guard', () => {
  const { state, root } = fixture();
  root.request.options = { large: 'x'.repeat(5_000) };
  root.result = { candidateOptions: [undefined, 'x'.repeat(3_000), { option: { origin: 'shared_index' },
    targetId: 'two', detail: 'x'.repeat(3_000) }, { id: 'no-origin', detail: 'x'.repeat(3_000) }], documents: { one: {
    options: [{ id: 'first', origin: 'source_heading' }], candidateOptions: { other: 'checked' },
  }, ignored: [], absent: null } } as typeof root.result;
  const source = root.sources[0];
  state.proposals[0].evidence = [
    { source, start: 0, end: 5, quote: 'Atlas' },
    { source: { ...source, canvasId: 'restricted' }, start: 0, end: 6, quote: 'Secret' },
    { source, start: 0, end: 2_049, quote: 'x'.repeat(2_049) },
  ];
  const detail = decisionInspection(state, root.id, 'profile')!;
  expect(detail.options).toMatchObject({ truncated: true });
  expect(detail.candidateOptions).toEqual(expect.arrayContaining([
    {}, { truncated: true, bytes: expect.any(Number) },
    expect.objectContaining({ truncated: true, targetId: 'two', origin: 'shared_index' }),
    expect.objectContaining({ truncated: true, id: 'no-origin' }),
    expect.objectContaining({ blockId: 'one', kind: 'candidateOptions' }),
  ]));
  expect(detail.proposals[0]).toMatchObject({ evidence: [{ quote: 'Atlas' }], evidenceTruncated: true });
});
