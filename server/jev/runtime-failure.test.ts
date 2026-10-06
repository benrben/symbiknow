import { expect, it } from 'vitest';
import type { JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { jevRemoteError } from '../jev-provider-error.js';
import type { CanvasStore } from '../storage.js';
import { providerUnavailable, recordJevFailure } from './runtime-failure.js';
import type { DocumentJob } from './runtime-document.js';
import type { StoredJevJob } from './runtime-queue.js';
import { emptyJevWorkspace, type JevWorkspaceFiles } from './workspace.js';

function fixture(attempts = 1, document = false) {
  let state = emptyJevWorkspace();
  const job: DocumentJob = { id: 'offline-job', request: { action: 'profile', canvasId: 'offline-canvas' }, state: 'running',
    principal: { id: 'owner', kind: 'user', access: 'write' }, authorizationFingerprint: 'offline', settingsKey: 'offline',
    attempts, sources: [], proposalIds: [], createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z',
    ...(document ? { documentPlan: { version: 2 as const, originalSources: [], completedActions: [],
      claimPreparedAt: '2026-10-06T00:00:00Z', queueWaitMs: 0 } } : {}) };
  state.jobs.push(job);
  const files = { serial: async (_workspaceId: string, operation: () => Promise<number>) => operation(),
    read: async () => structuredClone(state), write: async (_workspaceId: string, next: JevWorkspaceState) => { state = structuredClone(next); } } as unknown as JevWorkspaceFiles;
  const run = (error: unknown, signal = new AbortController().signal) => recordJevFailure(files, {} as CanvasStore,
    'offline-workspace', job.id, error, signal);
  return { run, job: () => state.jobs[0] as StoredJevJob & DocumentJob, state: () => state };
}

it('retries bounded transient and exact checkpoint failures while retaining a queued job', async () => {
  const transient = fixture();
  expect(await transient.run(new ApiError(429, 'Offline rate limit'))).toBe(250);
  expect(transient.job()).toMatchObject({ state: 'queued', error: 'Offline rate limit', attempts: 1 });
  const checkpoint = fixture(2, true);
  expect(await checkpoint.run(new ApiError(409, 'The workspace checkpoint changed during completion'))).toBe(500);
  expect(checkpoint.job().state).toBe('queued');
  const exhausted = fixture(3, true);
  expect(await exhausted.run(new ApiError(409, 'The workspace checkpoint changed during completion'))).toBe(0);
  expect(exhausted.job().state).toBe('failed');
  expect(exhausted.job().documentPlan?.retryAt).toBeUndefined();
});

it('marks billing and nonretryable failures without scheduling a paid retry', async () => {
  const billing = fixture(1, true);
  const error = jevRemoteError(402, 'Offline billing fixture');
  expect(providerUnavailable(error)).toBe(true);
  expect(await billing.run(error)).toBe(0);
  expect(billing.job()).toMatchObject({ state: 'failed', error: 'Offline billing fixture' });
  expect(billing.job().documentPlan?.retryAt).toBeUndefined();
  const ordinary = fixture(1, true);
  expect(await ordinary.run(new ApiError(400, 'Invalid checked result'))).toBe(0);
  expect(ordinary.job().documentPlan?.retryAt).toBeUndefined();
  expect(providerUnavailable(new Error('Offline provider failed'))).toBe(false);
});

it.each([
  ['execution_timeout', 'Automatic document execution timed out'],
  ['shutdown', 'Automatic document processing was interrupted by shutdown'],
  ['cancelled', 'Automatic document processing was cancelled before completion'],
])('persists an interrupted document after %s with a bounded retry marker', async (reason, message) => {
  const current = fixture(1, true); const controller = new AbortController(); controller.abort(reason);
  expect(await current.run(new Error('Offline interruption'), controller.signal)).toBe(0);
  expect(current.job()).toMatchObject({ state: 'failed', error: message });
  expect(Date.parse(current.job().documentPlan!.retryAt!)).toBeGreaterThan(Date.now());
});

it('defers an exhausted transient document failure and preserves completed or cancelled jobs', async () => {
  const current = fixture(2, true);
  expect(await current.run(new ApiError(503, 'Offline unavailable'))).toBe(0);
  expect(current.job()).toMatchObject({ state: 'failed', error: 'Offline unavailable' });
  expect(current.job().documentPlan?.retryAt).toBeDefined();
  const completed = fixture(); completed.job().state = 'completed';
  expect(await completed.run(new ApiError(503, 'Offline unavailable'))).toBe(0);
  expect(completed.job().state).toBe('completed');
  const cancelled = fixture(); cancelled.job().state = 'cancelled';
  expect(await cancelled.run(new ApiError(503, 'Offline unavailable'))).toBe(0);
  expect(cancelled.job().state).toBe('cancelled');
});
