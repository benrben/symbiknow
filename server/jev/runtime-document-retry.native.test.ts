import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { CanvasStore } from '../storage.js';
import { automationPrincipal } from './authorization.js';
import { evaluationContext } from './context.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { initializeDocumentPlan, type DocumentJob } from './runtime-document.js';
import { snapshotDocumentContext } from './runtime-document-context.js';
import { admitDocumentContextRetry, scheduleDocumentContextRetry } from './runtime-document-retry.js';
import { recordJevFailure } from './runtime-failure.js';
import { JevWorkspaceFiles } from './workspace.js';

const conflict = () => new ApiError(409, 'The document context changed during automatic processing');
const signal = () => new AbortController().signal;
const instant = new Date('2026-10-07T12:00:00Z');
let f: QueueBoundaryFixture;
let state: JevWorkspaceState;
let job: DocumentJob;

beforeEach(async () => {
  f = await queueBoundaryFixture();
  const admitted = await f.admit({ action: 'profile', canvasId: f.canvasId, blockIds: [f.primary.id], idempotencyKey: 'source:launch' }, automationPrincipal);
  state = await f.files.read(f.workspaceId);
  job = state.jobs.find(item => item.id === admitted.id) as DocumentJob;
  initializeDocumentPlan(job);
  job.state = 'running';
  await f.files.write(f.workspaceId, state);
});
afterEach(async () => { await f.close(); });

function schedule(target = job, now?: Date) {
  return scheduleDocumentContextRetry({ job: target, state, error: conflict(), signal: signal(), now });
}
function admit(target = job, now?: Date, store = f.store) {
  return admitDocumentContextRetry({ job: target, state, workspaceId: f.workspaceId, store, now });
}
function candidate(id: string, owner = job): JevProposal {
  return { id, jobId: owner.id, action: 'profile', title: 'Checked launch headline', explanation: 'Exact checked source', confidence: .99,
    sources: structuredClone(owner.sources), evidence: [{ source: owner.sources[0], start: 0, end: 7, quote: '# Atlas' }],
    mutation: { kind: 'document', canvasId: f.canvasId, blockId: f.primary.id, patch: { headline: 'Checked launch guidance.' } },
    state: 'pending', createdAt: instant.toISOString() };
}

it('admits a fresh guarded root and persists its lineage without reusing the failed proof, candidate IDs, or prefix', async () => {
  const oldContext = await evaluationContext(f.store, f.workspaceId, state, job.request, automationPrincipal, signal());
  const proof = snapshotDocumentContext(oldContext);
  job.documentPlan!.contextProof = proof;
  job.documentPlan!.completedActions = ['profile', 'label'];
  const active = { ...job, documentPlan: undefined, id: `${job.id}:link`, request: { ...job.request, action: 'link' as const }, proposalIds: ['active-candidate'] };
  job.documentPlan!.activeJob = active;
  job.proposalIds = ['root-candidate', 'old-applied'];
  const applied = { ...candidate('old-applied'), state: 'applied' as const };
  state.proposals.push(candidate('root-candidate'), candidate('active-candidate', active), applied, candidate('unrelated'));
  const incoming = await f.store.createBlock(f.otherCanvasId, { title: 'Launch blocker', content: '# Launch blocker\nThe gateway security approval is still pending.' });
  expect(schedule(job, instant)).toBe(250);
  const replacement = (await admit())!;
  expect(replacement).toMatchObject({ state: 'queued', proposalIds: [], documentContextRetry: { lineageId: job.id, attempts: 1 } });
  expect(replacement.id).not.toBe(job.id);
  expect((replacement as DocumentJob).documentPlan).toBeUndefined();
  expect(replacement.contextSources!.some(source => source.blockId === incoming.id)).toBe(true);
  expect(job.documentPlan!.contextProof).toEqual(proof);
  expect(job.documentPlan!.completedActions).toEqual(['profile', 'label']);
  expect(state.proposals.map(proposal => proposal.state)).toEqual(['stale', 'stale', 'applied', 'pending']);
  expect(await admit()).toBe(replacement);
  expect(state.jobs.filter(item => item.id === replacement.id)).toHaveLength(1);
  await f.files.write(f.workspaceId, state);
  const durable = await new JevWorkspaceFiles(f.root).read(f.workspaceId);
  expect(durable.jobs.find(item => item.id === job.id)?.documentContextRetry).toEqual({ lineageId: job.id, attempts: 1, replacementJobId: replacement.id });
  expect(durable.jobs.find(item => item.id === replacement.id)?.documentContextRetry).toEqual({ lineageId: job.id, attempts: 1 });
});

it('bounds immediate backoff to two fresh roots, persists cooldown, and resumes a new root when it becomes due', async () => {
  delete job.request.idempotencyKey;
  expect(schedule(job, instant)).toBe(250);
  const second = (await admit(job, instant))! as DocumentJob;
  initializeDocumentPlan(second);
  second.state = 'running';
  expect(schedule(second, instant)).toBe(500);
  const third = (await admit(second, instant))! as DocumentJob;
  initializeDocumentPlan(third);
  third.state = 'running';
  expect(schedule(third, instant)).toBe(60_000);
  expect(await admit(third, new Date(instant.getTime() + 59_999))).toBeUndefined();
  await f.files.write(f.workspaceId, state);
  state = await new JevWorkspaceFiles(f.root).read(f.workspaceId);
  const pending = state.jobs.find(item => item.id === third.id) as DocumentJob;
  const fourth = (await admit(pending, new Date(instant.getTime() + 60_000)))!;
  expect(fourth.id).not.toBe(third.id);
  expect(fourth.request.idempotencyKey).toContain(':retry:context:');
  expect(fourth.documentContextRetry).toEqual({ lineageId: job.id, attempts: 3 });
  expect((fourth as DocumentJob).documentPlan).toBeUndefined();
  expect(pending.documentPlan!.retryAt).toBeUndefined();
  expect(pending.state).toBe('failed');
});

it('rejects unrelated errors, cancelled work, missing plans, and non-automatic intents without creating a retry', () => {
  for (const error of [new Error('Disconnected'), new ApiError(503, 'Provider unavailable'), new ApiError(409, 'The document changed during automatic processing')]) {
    expect(scheduleDocumentContextRetry({ state, job, error, signal: signal() })).toBeUndefined();
  }
  const cancelled = new AbortController(); cancelled.abort();
  expect(scheduleDocumentContextRetry({ state, job, error: conflict(), signal: cancelled.signal })).toBeUndefined();
  const noPlan = structuredClone(job); delete noPlan.documentPlan;
  expect(schedule(noPlan)).toBeUndefined();
  const manual = structuredClone(job); manual.principal = boundaryOwner;
  expect(schedule(manual)).toBeUndefined();
  expect(job.documentContextRetry).toBeUndefined();
});

it('does not admit nonfailed roots, missing markers or plans, disabled automation, or a lost replacement', async () => {
  expect(await admit()).toBeUndefined();
  job.state = 'failed';
  expect(await admit()).toBeUndefined();
  job.documentContextRetry = { lineageId: job.id, attempts: 1 };
  expect(await admit()).toBeUndefined();
  schedule();
  const noPlan = structuredClone(job); delete noPlan.documentPlan;
  expect(await admit(noPlan)).toBeUndefined();
  state.settings.modes.file = 'suggest';
  expect(await admit()).toBeUndefined();
  job.documentContextRetry!.replacementJobId = 'removed-historical-root';
  expect(await admit()).toBeUndefined();
  expect(state.jobs).toHaveLength(1);
});

it.each(['content', 'manual metadata', 'delete'] as const)('preserves the stale-source guard for a later %s change', async change => {
  schedule();
  if (change === 'delete') await f.store.deleteBlock(f.canvasId, f.primary.id);
  else await f.store.updateBlock(f.canvasId, f.primary.id, change === 'content' ? { content: '# Changed launch source' } : { headline: 'Owner correction' }, 'Owner');
  expect(await admit()).toBeUndefined();
  expect(job.state).toBe('failed');
  expect(job.documentContextRetry!.retryAt).toBeUndefined();
  expect(job.documentPlan!.retryAt).toBeUndefined();
  expect(state.jobs).toHaveLength(1);
  if (change === 'manual metadata') expect((await f.store.getCanvasBlock(f.canvasId, f.primary.id)).headline).toBe('Owner correction');
});

it('rejects a changed processing policy rather than silently reauthorizing the historical intent', async () => {
  schedule();
  state.settings.people = [{ id: 'owner', name: 'Owner', role: 'Release lead' }];
  expect(await admit()).toBeUndefined();
  expect(job.documentContextRetry!.retryAt).toBeUndefined();
  expect(state.jobs).toHaveLength(1);
});

it('advances the selected-source guard only through its own already applied canonical prefix receipt', async () => {
  const applied = candidate('applied-prefix');
  const active: DocumentJob = { ...job, documentPlan: undefined, proposalIds: [applied.id] };
  job.documentPlan!.activeJob = active;
  state.proposals.push(applied);
  await f.files.write(f.workspaceId, state);
  const receipt = await f.files.serial(f.workspaceId, () => f.executor.applyInside(f.workspaceId, applied.id, automationPrincipal, true));
  state = await f.files.read(f.workspaceId);
  job = state.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(schedule()).toBe(250);
  const replacement = (await admit())!;
  expect(replacement.sources).toEqual(receipt.sourcesAfter);
  expect(state.receipts).toHaveLength(1);
  expect(state.receipts[0]).toEqual(receipt);
  expect(state.proposals[0].state).toBe('applied');
  expect((replacement as DocumentJob).documentPlan).toBeUndefined();
  expect((await f.store.getCanvasBlock(f.canvasId, f.primary.id)).headline).toBe('Checked launch guidance.');
});

it('retains durable retry intent and propagates unexpected native storage errors', async () => {
  schedule();
  await writeFile(path.join(f.root, 'canvases', `${f.canvasId}.json`), '{ malformed json');
  await expect(admit(job, undefined, new CanvasStore(f.root))).rejects.toBeInstanceOf(SyntaxError);
  expect(job.documentContextRetry!.retryAt).toBeDefined();
  expect(state.jobs).toHaveLength(1);
});

it('propagates workspace recovery failures and leaves the cooldown marker recoverable', async () => {
  schedule();
  const active: DocumentJob = { ...job, documentPlan: undefined, proposalIds: [] };
  job.documentPlan!.activeJob = active;
  await writeFile(f.files.file(f.workspaceId), '{ recovery required');
  await expect(admit()).rejects.toMatchObject({ status: 503 });
  expect(job.documentContextRetry!.retryAt).toBeDefined();
  expect(state.jobs).toHaveLength(1);
});

it('persists third-conflict cooldown through the real failure recorder and admits a fresh root through native maintenance', async () => {
  job.documentContextRetry = { lineageId: job.id, attempts: 2 };
  await f.files.write(f.workspaceId, state);
  expect(await recordJevFailure(f.files, f.store, f.workspaceId, job.id, conflict(), signal())).toBe(0);
  state = await f.files.read(f.workspaceId);
  const failed = state.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(failed.documentContextRetry).toMatchObject({ lineageId: job.id, attempts: 3 });
  expect(Date.parse(failed.documentContextRetry!.retryAt!) - Date.now()).toBeGreaterThan(59_000);
  failed.documentContextRetry!.retryAt = new Date(Date.now() - 1).toISOString();
  failed.documentPlan!.retryAt = failed.documentContextRetry!.retryAt;
  await f.files.write(f.workspaceId, state);
  await f.maintenance.reconcile(await f.workspace());
  const durable = await new JevWorkspaceFiles(f.root).read(f.workspaceId);
  const old = durable.jobs.find(item => item.id === job.id) as DocumentJob;
  const fresh = durable.jobs.find(item => item.id === old.documentContextRetry!.replacementJobId) as DocumentJob;
  expect(fresh).toMatchObject({ state: 'queued', documentContextRetry: { lineageId: job.id, attempts: 3 } });
  expect(fresh.documentPlan).toBeUndefined();
  expect(old.state).toBe('failed');
});

it('persists cleared retry markers during maintenance when an owner has corrected the selected source', async () => {
  schedule();
  job.documentContextRetry!.attempts = 3;
  job.documentContextRetry!.retryAt = new Date(Date.now() - 1).toISOString();
  job.documentPlan!.retryAt = job.documentContextRetry!.retryAt;
  await f.files.write(f.workspaceId, state);
  await f.store.updateBlock(f.canvasId, f.primary.id, { headline: 'Owner correction remains authoritative.' }, 'Owner');
  await f.maintenance.reconcile(await f.workspace());
  const durable = await new JevWorkspaceFiles(f.root).read(f.workspaceId);
  const historical = durable.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(historical.documentContextRetry!.retryAt).toBeUndefined();
  expect(historical.documentContextRetry!.replacementJobId).toBeUndefined();
  expect(historical.documentPlan!.retryAt).toBeUndefined();
  expect((await f.store.getCanvasBlock(f.canvasId, f.primary.id)).headline).toBe('Owner correction remains authoritative.');
});
