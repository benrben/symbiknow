import { createHash } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from '../storage.js';
import { automationPrincipal } from './authorization.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import { evaluationContext } from './context.js';
import { JEV_ORGANIZATION_VERSION } from './followups.js';
import { queueBoundaryCopies } from './queue-boundary-copy.test.fixture.js';
import type { QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { initializeDocumentPlan, type DocumentJob } from './runtime-document.js';
import { snapshotDocumentContext } from './runtime-document-context.js';
import { resumeDocument } from './runtime-maintenance.js';
import { processingPolicyKey } from './runtime-guards.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

let copies: Awaited<ReturnType<typeof queueBoundaryCopies>>;
let native: QueueBoundaryFixture;
beforeAll(async () => { copies = await queueBoundaryCopies(); });
beforeEach(async () => { native = await copies.fixture(); });
afterEach(async () => { await native.close(); });
afterAll(async () => { await copies.close(); });

async function deferred(canvasId = native.canvasId, blockId = native.primary.id): Promise<DocumentJob> {
  const initial = await native.files.read(native.workspaceId);
  const source = sourceSnapshot(native.workspaceId, canvasId, await native.store.getCanvasBlock(canvasId, blockId));
  const policy = createHash('sha256').update(processingPolicyKey(initial)).digest('hex').slice(0, 12);
  const key = `source:${canvasId}:${blockId}:${source.incarnation}:${source.sourceGeneration}:${JEV_QUESTION_VERSION}:${JEV_ORGANIZATION_VERSION}:${policy}`;
  const admitted = await native.admit({ action: 'profile', canvasId, blockIds: [blockId], idempotencyKey: key }, automationPrincipal);
  const state = await native.files.read(native.workspaceId);
  const job = state.jobs.find(item => item.id === admitted.id) as DocumentJob;
  initializeDocumentPlan(job);
  const context = await evaluationContext(native.store, native.workspaceId, state, job.request, automationPrincipal, new AbortController().signal);
  job.documentPlan!.contextProof = snapshotDocumentContext(context);
  job.state = 'failed'; job.attempts = 2; job.error = 'Provider temporarily unavailable';
  job.documentPlan!.retryAt = new Date(Date.now() - 1).toISOString();
  await native.files.write(native.workspaceId, state);
  return job;
}

it('resumes a legacy deferred plan through ordinary maintenance with its guarded proof and intent intact', async () => {
  const job = await deferred();
  const plan = structuredClone(job.documentPlan!); delete plan.retryAt;
  await native.maintenance.reconcile(await native.workspace());
  const durable = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const resumed = durable.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(resumed).toMatchObject({ state: 'queued', attempts: 0, request: job.request, sources: job.sources });
  expect(resumed.error).toBeUndefined();
  expect(resumed.documentPlan).toEqual(plan);
  expect(resumed.documentContextRetry).toBeUndefined();
  expect((await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('persists a rejected legacy retry after an owner changes its selected metadata without overwriting that correction', async () => {
  const job = await deferred();
  await native.store.updateBlock(native.canvasId, native.primary.id, { headline: 'Owner correction' }, 'Owner');
  await native.maintenance.reconcile(await native.workspace());
  const durable = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const stopped = durable.jobs.find(item => item.id === job.id) as DocumentJob;
  expect(stopped.state).toBe('failed');
  expect(stopped.documentPlan!.retryAt).toBeUndefined();
  expect(stopped.documentPlan!.contextProof).toEqual(job.documentPlan!.contextProof);
  expect((await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id)).headline).toBe('Owner correction');
});

it('defers an existing guarded source intent until its persisted cooldown is due without admitting duplicate profiling', async () => {
  const job = await deferred();
  const state = await native.files.read(native.workspaceId);
  const waiting = state.jobs.find(item => item.id === job.id) as DocumentJob;
  waiting.documentPlan!.retryAt = new Date(Date.now() + 60_000).toISOString();
  await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  const durable = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const matching = durable.jobs.filter(item => item.request.action === 'profile' && item.request.blockIds?.includes(native.primary.id));
  expect(matching).toEqual([waiting]);
  expect((matching[0] as DocumentJob).documentPlan!.retryAt).toBe(waiting.documentPlan!.retryAt);
});

it('records a successful resume before a second due root is rejected by the fresh-intent request guard', async () => {
  const first = await deferred();
  const second = await deferred(native.otherCanvasId, native.secondary.id);
  const state = await native.files.read(native.workspaceId);
  const guarded = state.jobs.find(item => item.id === second.id) as DocumentJob;
  guarded.request.options = { explicitReview: true };
  guarded.documentContextRetry = { lineageId: second.id, attempts: 3, retryAt: guarded.documentPlan!.retryAt };
  await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  const durable = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(durable.jobs.find(item => item.id === first.id)?.state).toBe('queued');
  const unchanged = durable.jobs.find(item => item.id === second.id) as DocumentJob;
  expect(unchanged).toMatchObject({ state: 'failed', documentContextRetry: guarded.documentContextRetry });
  expect(unchanged.documentPlan!.retryAt).toBe(guarded.documentPlan!.retryAt);
  expect(unchanged.documentContextRetry!.replacementJobId).toBeUndefined();
});

it('leaves a sole ineligible due root unchanged rather than persisting an unreviewed replacement', async () => {
  const job = await deferred();
  const state = await native.files.read(native.workspaceId);
  const guarded = state.jobs.find(item => item.id === job.id) as DocumentJob;
  guarded.request.options = { explicitReview: true };
  guarded.documentContextRetry = { lineageId: job.id, attempts: 3, retryAt: guarded.documentPlan!.retryAt };
  await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  const durable = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(durable.jobs.find(item => item.id === job.id)).toEqual(guarded);
});

it('clears a missing-source retry at the real native guard boundary without resuming its obsolete intent', async () => {
  const job = await deferred();
  await native.store.deleteBlock(native.canvasId, native.primary.id, 'Owner');
  expect(await resumeDocument(native.store, native.workspaceId, job)).toBe(true);
  expect(job.state).toBe('failed');
  expect(job.documentPlan!.retryAt).toBeUndefined();
});

it('propagates an invalid native scope error and keeps its deferred marker for inspection', async () => {
  const job = await deferred();
  job.sources[0].canvasId = '../invalid-scope';
  await expect(resumeDocument(native.store, native.workspaceId, job)).rejects.toMatchObject({ status: 400, message: 'Invalid canvas ID' });
  expect(job.state).toBe('failed');
  expect(job.documentPlan!.retryAt).toBeDefined();
});

it('propagates unexpected native read failures without clearing the guarded deferred intent', async () => {
  const job = await deferred();
  const canvasFile = path.join(native.root, 'canvases', `${native.canvasId}.json`);
  const backup = canvasFile + '.backup';
  await rename(canvasFile, backup); await mkdir(canvasFile);
  try {
    await expect(resumeDocument(new CanvasStore(native.root), native.workspaceId, job)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(job.state).toBe('failed');
    expect(job.documentPlan!.retryAt).toBeDefined();
  } finally { await rm(canvasFile, { recursive: true }); await rename(backup, canvasFile); }
});
