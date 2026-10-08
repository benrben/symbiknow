import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { JevWorkspaceState } from '../../shared/jev-types.js';
import type { WorkspaceSummary } from '../../shared/types.js';
import { atomicJson } from '../storage-files.js';
import type { StoredBlock, StoredCanvas } from '../storage-shapes.js';
import { ApiError } from '../errors.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';
import { JevFollowupQueue, JEV_ORGANIZATION_VERSION } from './followups.js';
import { enqueueJevJobs } from './runtime-queue-batch.js';
import { processingPolicyKey } from './runtime-guards.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { JevRuntimeMaintenance } from './runtime-maintenance.js';
import { enqueueJevJob, type StoredJevJob } from './runtime-queue.js';
import type { JevFollowupAdmission } from './runtime-followup-admission.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';
import { queueBoundaryCopies } from './queue-boundary-copy.test.fixture.js';

type GuardFixture = QueueBoundaryFixture & { maintenance: JevRuntimeMaintenance; followups: JevFollowupQueue; admitted: StoredJevJob };
type Mutate = (native: GuardFixture, state: JevWorkspaceState, job: StoredJevJob) => void | Promise<void>;
type Row = { label: string; mutate: Mutate; publicCheck?: boolean };
const fixtures: QueueBoundaryFixture[] = [];
let copies: Awaited<ReturnType<typeof queueBoundaryCopies>>;
let baseline: GuardFixture;
beforeAll(async () => { baseline = await fixture(); fixtures.pop(); copies = await queueBoundaryCopies(baseline); });
afterAll(async () => { await copies.close(); });
afterEach(async () => { for (const native of fixtures.splice(0)) await native.close(); });

async function fixture(batch = false): Promise<GuardFixture> {
  const native = copies ? await copies.fixture() : await queueBoundaryFixture(); fixtures.push(native);
  const enqueue = (id: string, request: StoredJevJob['request'], admission?: JevFollowupAdmission) =>
    enqueueJevJob(native.store, native.files, native.executor, id, request, automationPrincipal, admission);
  const followups = new JevFollowupQueue(native.store, native.files, enqueue);
  const maintenance = new JevRuntimeMaintenance(native.store, native.files, native.executor, followups, enqueue, native.running, async () => true, batch
    ? (id, requests) => enqueueJevJobs(native.store, native.files, native.executor, id, requests, automationPrincipal) : undefined);
  if (copies) return { ...native, maintenance, followups, admitted: structuredClone(baseline.admitted) };
  const primary = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const state = await native.files.read(native.workspaceId);
  state.profiles[`${native.canvasId}:${primary.id}`] = { source: { ...sourceSnapshot(native.workspaceId, native.canvasId, primary) },
    questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: .7 };
  await native.files.write(native.workspaceId, state);
  // Seed the real durable checkpoint for a previously organized source. Full six-action execution is proved by the public tick regression.
  await followups.resume(native.workspaceId, { action: 'profile', canvasId: native.canvasId, blockIds: [primary.id] }, [], 'prior-checked-organization');
  const admitted = await native.admit({ action: 'profile', canvasId: native.otherCanvasId,
    blockIds: [native.secondary.id], idempotencyKey: sourceOperation(native.workspaceId, native.otherCanvasId, native.secondary, state) }, automationPrincipal);
  // Genuine manual input changes make the existing successful organization context stale.
  await native.store.updateBlock(native.canvasId, primary.id, { quality: { score: .37, at: '2026-10-06T00:00:00Z' } }, 'Browser');
  return { ...native, maintenance, followups, admitted };
}
function sourceOperation(workspaceId: string, canvasId: string, block: QueueBoundaryFixture['primary'], state: JevWorkspaceState): string {
  const source = sourceSnapshot(workspaceId, canvasId, block);
  const policy = createHash('sha256').update(processingPolicyKey(state)).digest('hex').slice(0, 12);
  return `source:${source.canvasId}:${source.blockId}:${source.incarnation}:${source.sourceGeneration}:${JEV_QUESTION_VERSION}:${JEV_ORGANIZATION_VERSION}:${policy}`;
}
async function isolateSavedCandidate(native: GuardFixture): Promise<void> {
  // Remove independently eligible new profiling from this public check; the previous assertion exercises the actual persisted-candidate guard.
  try { await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return; throw error; }
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { processingExcluded: true }, 'Browser');
}
async function rewriteSecondary(native: GuardFixture, mutate: (block: StoredBlock) => void): Promise<void> {
  const file = path.join(native.root, 'canvases', `${native.otherCanvasId}.json`);
  const canvas = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
  mutate(canvas.blocks.find(block => block.id === native.secondary.id)!);
  await atomicJson(file, canvas);
}
function guarded(native: GuardFixture) {
  // Cached candidates can outlive a canonical source change after recovery; exercise the actual boundary without replacing any guard or I/O.
  return native.maintenance as unknown as { hasFreshProfileBacklog(workspace: WorkspaceSummary, state: JevWorkspaceState): Promise<boolean> };
}
async function savedCase(native: GuardFixture, mutate: Mutate) {
  const state = await native.files.read(native.workspaceId); const job = state.jobs.find(item => item.id === native.admitted.id) as StoredJevJob;
  await mutate(native, state, job); await native.files.write(native.workspaceId, state);
  return new JevWorkspaceFiles(native.root).read(native.workspaceId);
}
function roots(state: JevWorkspaceState, native: GuardFixture) {
  return state.jobs.filter(job => job.request.action === 'label' && job.request.canvasId === native.canvasId
    && job.request.blockIds?.includes(native.primary.id));
}
const notFresh: Row[] = [
  { label: 'ordinary automatic file work', mutate: (_native, _state, job) => { job.request.action = 'file'; } },
  { label: 'explicit profile query', mutate: (_native, _state, job) => { job.request.query = 'Inspect Atlas requirements'; } },
  { label: 'explicit profile options', mutate: (_native, _state, job) => { job.request.options = {}; } },
  { label: 'canvas-wide selection', mutate: (_native, _state, job) => { delete job.request.blockIds; } },
  { label: 'empty selection', mutate: (_native, _state, job) => { job.request.blockIds = []; } },
  { label: 'trusted user profile', mutate: (_native, _state, job) => { job.principal = boundaryOwner; job.authorizationFingerprint = principalFingerprint(boundaryOwner); } },
  { label: 'legacy missing principal', publicCheck: false, mutate: (_native, _state, job) => { delete (job as Partial<StoredJevJob>).principal; } },
  { label: 'same-id user impersonation', mutate: (_native, _state, job) => { job.principal = { ...automationPrincipal, kind: 'user' }; } },
  { label: 'scoped automatic authorization', mutate: (native, _state, job) => { job.principal = { ...automationPrincipal, allowedCanvasIds: [native.otherCanvasId] }; job.authorizationFingerprint = principalFingerprint(job.principal); } },
  { label: 'mismatched saved authorization', mutate: (_native, _state, job) => { job.authorizationFingerprint = 'revoked-or-stale'; } },
  { label: 'mismatched processing policy', mutate: (_native, state) => { state.settings.confidenceThresholds!.file = .85; } },
  { label: 'completed profile work', mutate: (_native, _state, job) => { job.state = 'completed'; } },
  { label: 'cancelled profile work', mutate: (_native, _state, job) => { job.state = 'cancelled'; } },
  { label: 'failed profile work', mutate: (_native, _state, job) => { job.state = 'failed'; job.updatedAt = '2020-01-01T00:00:00Z'; } },
  { label: 'duplicate guarded sources', mutate: (_native, _state, job) => { job.sources.push({ ...job.sources[0] }); } },
  { label: 'empty source guards', mutate: (_native, _state, job) => { job.sources = []; } },
  { label: 'selection larger than source guards', mutate: (native, _state, job) => { job.request.blockIds!.push(native.primary.id); } },
  { label: 'other-workspace guard', mutate: (_native, _state, job) => { job.sources[0].workspaceId = 'unrelated-workspace'; } },
  { label: 'other-canvas guard', mutate: (native, _state, job) => { job.sources[0].canvasId = native.canvasId; } },
  { label: 'unselected guarded block', mutate: (native, _state, job) => { job.request.blockIds = [native.primary.id]; } },
  { label: 'removed workspace canvas', mutate: async native => { await native.store.deleteCanvas(native.otherCanvasId); } },
  { label: 'deleted source behind a cached candidate', mutate: async native => { await native.store.deleteBlock(native.otherCanvasId, native.secondary.id, 'Browser'); } },
  { label: 'archived source behind a cached candidate', mutate: async native => { await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { archived: true }, 'Browser'); } },
  { label: 'processing-excluded source', mutate: async native => { await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { processingExcluded: true }, 'Browser'); } },
  { label: 'legacy unstamped source', mutate: async native => { await rewriteSecondary(native, block => { delete block.incarnation; }); } },
  { label: 'changed source incarnation', mutate: async native => { await rewriteSecondary(native, block => { block.incarnation = 'replacement-incarnation'; }); } },
  { label: 'changed source generation', mutate: async native => { await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { title: 'A revised source title' }, 'Browser'); } },
  { label: 'changed content behind its original guard', mutate: async native => { await writeFile(path.join(native.root, native.secondary.file), '# Changed rollback source\nNew native source facts.'); } },
  { label: 'an already current profile', mutate: (native, state, job) => { state.profiles[`${native.otherCanvasId}:${native.secondary.id}`] = {
    source: { ...job.sources[0] }, questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: .7 }; } },
];

it.each(notFresh)('rejects an ineligible persisted backlog candidate for $label', async row => {
  const native = await fixture(); const before = await savedCase(native, row.mutate);
  const target = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  expect(await guarded(native).hasFreshProfileBacklog(await native.workspace(), before)).toBe(false);
  expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
  expect(await native.store.getCanvasBlock(native.canvasId, native.primary.id)).toEqual(target);
  if (row.publicCheck === false) return; // A malformed legacy principal remains an original queue-recovery error, never a freshness grant.
  await isolateSavedCandidate(native);
  await native.maintenance.reconcile(await native.workspace());
  const queued = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(roots(queued, native)).toHaveLength(1);
  expect(roots(queued, native)[0]).toMatchObject({ state: 'queued', sources: [sourceSnapshot(native.workspaceId, native.canvasId, target)] });
  expect(queued.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey)
    .toBe(before.profiles[`${native.canvasId}:${native.primary.id}`].organizationContextKey);
});

const fresh: Row[] = [
  { label: 'unchanged initial understanding', mutate: () => undefined },
  { label: 'metadata-only source revision', mutate: async native => { await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { tags: ['Manual correction'] }, 'Browser'); } },
  { label: 'obsolete profile question version', mutate: (native, state, job) => { state.profiles[`${native.otherCanvasId}:${native.secondary.id}`] = {
    source: { ...job.sources[0] }, questionVersion: 'obsolete-question-version', profileConfidenceThreshold: .7 }; } },
  { label: 'obsolete profile confidence cutoff', mutate: (native, state, job) => { state.profiles[`${native.otherCanvasId}:${native.secondary.id}`] = {
    source: { ...job.sources[0] }, questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: .99 }; } },
];
it.each(fresh)('defers only the new repeat root during $label without changing its existing checkpoint', async row => {
  const native = await fixture(); const before = await savedCase(native, row.mutate);
  expect(await guarded(native).hasFreshProfileBacklog(await native.workspace(), before)).toBe(true);
  await native.maintenance.reconcile(await native.workspace());
  const queued = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(roots(queued, native)).toEqual([]);
  expect(queued.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(before.profiles[`${native.canvasId}:${native.primary.id}`]);
});

it.each([
  { label: 'missing checkpoint', value: undefined }, { label: 'non-string checkpoint', value: 42 },
  { label: 'malformed checkpoint', value: 'unverified-context-key' },
])('does not defer first organization after a $label', async ({ value }) => {
  const native = await fixture(); const before = await native.files.read(native.workspaceId);
  const profile = before.profiles[`${native.canvasId}:${native.primary.id}`];
  if (value === undefined) delete profile.organizationContextKey; else profile.organizationContextKey = value;
  await native.files.write(native.workspaceId, before);
  await native.maintenance.reconcile(await native.workspace());
  const queued = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(roots(queued, native)).toHaveLength(1);
  expect(roots(queued, native)[0]).toMatchObject({ state: 'queued' });
  expect(queued.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(profile);
});

it.each([false, true])('preserves failed organization retry/cooldown with a fresh backlog (cooldown=%s)', async cooldown => {
  const native = await fixture(); const state = await native.files.read(native.workspaceId);
  const context = native.followups as unknown as { context(id: string, state: JevWorkspaceState): Promise<{ key: string }> };
  const currentKey = (await context.context(native.workspaceId, state)).key;
  const profile = state.profiles[`${native.canvasId}:${native.primary.id}`]; delete profile.organizationContextKey;
  profile.organizationFailedContextKey = currentKey;
  profile.organizationRetryAt = new Date(Date.now() + (cooldown ? 60_000 : -60_000)).toISOString();
  await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  const queued = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(roots(queued, native)).toHaveLength(cooldown ? 0 : 1);
  expect(queued.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(profile);
  if (!cooldown) expect(roots(queued, native)[0].request.idempotencyKey).toContain(':retry:');
});

it('does not treat contradictory success and failure markers as successful organization', async () => {
  const native = await fixture(); const state = await native.files.read(native.workspaceId);
  state.profiles[`${native.canvasId}:${native.primary.id}`].organizationFailedContextKey = 'f'.repeat(64);
  await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  const queued = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(roots(queued, native)).toHaveLength(1);
  expect(queued.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(state.profiles[`${native.canvasId}:${native.primary.id}`]);
});

it('keeps an already admitted source chain unchanged during the fresh backlog', async () => {
  const native = await fixture();
  await native.followups.queue(native.workspaceId, { action: 'profile', canvasId: native.canvasId,
    blockIds: [native.primary.id], idempotencyKey: 'already-admitted-organization' });
  const before = await native.files.read(native.workspaceId); const admittedRoot = roots(before, native)[0];
  await native.maintenance.reconcile(await native.workspace());
  const queued = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(roots(queued, native)).toEqual([admittedRoot]);
  expect(queued.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(before.profiles[`${native.canvasId}:${native.primary.id}`]);
});

it('ignores a canonical404 for a source deleted after its candidate snapshot, without advancing the persisted checkpoint', async () => {
  const native = await fixture(); const before = await native.files.read(native.workspaceId);
  await native.store.deleteBlock(native.otherCanvasId, native.secondary.id, 'Browser');
  expect(await guarded(native).hasFreshProfileBacklog(await native.workspace(), before)).toBe(false);
  expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
});
it('propagates a non404 nativeApiError from a malformed cached source selector, without changing state', async () => {
  const native = await fixture(); const before = await savedCase(native, (_fixture, _state, job) => {
    job.request.blockIds = ['../invalid']; job.sources[0].blockId = '../invalid';
  });
  await expect(guarded(native).hasFreshProfileBacklog(await native.workspace(), before))
    .rejects.toMatchObject({ status: 400, message: 'Invalid block ID' });
  expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
});
it('propagates a real canonical document read failure rather than treating it as an absent or fresh source', async () => {
  const native = await fixture(); const before = await native.files.read(native.workspaceId);
  const file = path.join(native.root, native.secondary.file); const backup = `${file}.before`;
  await rename(file, backup); await mkdir(file);
  try {
    await expect(guarded(native).hasFreshProfileBacklog(await native.workspace(), before)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
  } finally { await rm(file, { recursive: true }); await rename(backup, file); }
});
it('propagates malformed canonical JSON and preserves the actual cached-candidate ledger', async () => {
  const native = await fixture(); const before = await native.files.read(native.workspaceId);
  const file = path.join(native.root, 'canvases', `${native.otherCanvasId}.json`); const original = await readFile(file, 'utf8');
  await writeFile(file, '{malformed canonical canvas');
  try {
    await expect(guarded(native).hasFreshProfileBacklog(await native.workspace(), before)).rejects.toBeInstanceOf(SyntaxError);
    expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
  } finally { await writeFile(file, original); }
});

const replacementRows: Array<{ label: string; state: StoredJevJob['state']; ageMs: number; profile?: 'current' | 'cutoff' | 'questions'; deferred: boolean }> = [
  { label: 'an eligible failed initial profile retry', state: 'failed', ageMs: 61_000, deferred: true },
  { label: 'a failed profile still in cooldown', state: 'failed', ageMs: 0, deferred: false },
  { label: 'a cancelled initial profile replacement', state: 'cancelled', ageMs: 0, deferred: true },
  { label: 'a completed profile with an obsolete confidence cutoff', state: 'completed', ageMs: 0, profile: 'cutoff', deferred: true },
  { label: 'a completed profile with obsolete questions', state: 'completed', ageMs: 0, profile: 'questions', deferred: true },
  { label: 'a completed current profile requiring only its first organization', state: 'completed', ageMs: 0, profile: 'current', deferred: false },
];
it.each(replacementRows.flatMap(row => [false, true].map(batch => ({ ...row, batch }))))
('plans $label before old successful rechecks (batch=$batch)', async row => {
  const native = await fixture(row.batch);
  const before = await savedCase(native, (native, state, job) => {
    job.state = row.state; job.updatedAt = new Date(Date.now() - row.ageMs).toISOString();
    if (row.profile) state.profiles[`${native.otherCanvasId}:${native.secondary.id}`] = {
      source: { ...job.sources[0] }, questionVersion: row.profile === 'questions' ? 'previous-questions' : JEV_QUESTION_VERSION,
      profileConfidenceThreshold: row.profile === 'cutoff' ? .99 : .7, profileEvaluationId: 'previous-native-profile-evaluation',
    };
  });
  expect(before.jobs.every(job => !['queued', 'running'].includes(job.state))).toBe(true);
  expect(await guarded(native).hasFreshProfileBacklog(await native.workspace(), before)).toBe(false);
  await native.maintenance.reconcile(await native.workspace());
  const saved = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(roots(saved, native)).toHaveLength(row.deferred ? 0 : 1);
  expect(saved.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(before.profiles[`${native.canvasId}:${native.primary.id}`]);
  const fresh = saved.jobs.filter(job => job.state === 'queued' && job.request.action === 'profile');
  expect(fresh).toHaveLength(row.deferred ? 1 : 0);
  if (row.deferred) {
    expect(fresh[0].sources).toEqual([sourceSnapshot(native.workspaceId, native.otherCanvasId, native.secondary)]);
    expect(fresh[0].id).not.toBe(native.admitted.id);
  }
  if (row.profile === 'cutoff') expect(fresh[0].request.idempotencyKey).toContain(':retry:profile-cutoff:');
});

it('preserves the native capacity boundary when emitting deferred completed-source requests after a pass with no fresh profiles', async () => {
  const native = await fixture(); await isolateSavedCandidate(native);
  const held = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] }, automationPrincipal);
  const before = await native.files.read(native.workspaceId);
  before.jobs = Array.from({ length: 200 }, (_, index) => ({ ...held, id: `capacity-holder-${index}` }));
  await native.files.write(native.workspaceId, before);
  await native.maintenance.reconcile(await native.workspace());
  expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
});

it('rethrows a checked native operation-key conflict when emitting a completed-source recheck', async () => {
  const native = await fixture(); await isolateSavedCandidate(native);
  let before = await native.files.read(native.workspaceId);
  before.jobs.find(job => job.id === native.admitted.id)!.state = 'cancelled';
  await native.files.write(native.workspaceId, before);
  const context = native.followups as unknown as { context(id: string, state: JevWorkspaceState): Promise<{ key: string }> };
  const key = (await context.context(native.workspaceId, before)).key;
  const sourceKey = sourceOperation(native.workspaceId, native.canvasId, native.primary, before);
  await native.admit({ action: 'label', canvasId: native.canvasId, blockIds: [native.primary.id],
    query: 'A different explicitly requested operation', idempotencyKey: `${sourceKey}:${key}:label` }, automationPrincipal);
  before = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  await expect(native.maintenance.reconcile(await native.workspace()))
    .rejects.toMatchObject({ status: 409, message: 'Operation key was already used with different arguments' });
  expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
});

it('rethrows an actual nonApiError ledger-read failure during completed-source recheck admission', async () => {
  const native = await fixture(); await isolateSavedCandidate(native);
  const before = await native.files.read(native.workspaceId);
  before.jobs.find(job => job.id === native.admitted.id)!.state = 'cancelled';
  await native.files.write(native.workspaceId, before);
  const file = native.files.file(native.workspaceId); const backup = `${file}.before-recheck`;
  const enqueue = async (id: string, request: StoredJevJob['request'], admission?: JevFollowupAdmission) => {
    // Move the actual canonical ledger at the final admission boundary, then invoke the real enqueue/read path.
    await rename(file, backup); await mkdir(file);
    return enqueueJevJob(native.store, native.files, native.executor, id, request, automationPrincipal, admission);
  };
  const followups = new JevFollowupQueue(native.store, native.files, enqueue);
  const maintenance = new JevRuntimeMaintenance(native.store, native.files, native.executor, followups, enqueue, native.running);
  try { await expect(maintenance.reconcile(await native.workspace())).rejects.toMatchObject({ code: 'EISDIR' }); }
  finally { await rm(file, { recursive: true }); await rename(backup, file); }
  expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(before);
});

it.each([false, true])('does not claim fresh backlog when the real profile-cutoff operation is already terminal (batch=%s)', async batch => {
  const native = await fixture(batch);
  const state = await native.files.read(native.workspaceId);
  const original = state.jobs.find(job => job.id === native.admitted.id)!;
  original.state = 'completed';
  const profileEvaluationId = 'previous-native-cutoff-evaluation';
  state.profiles[`${native.otherCanvasId}:${native.secondary.id}`] = { source: { ...original.sources[0] },
    questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: .99, profileEvaluationId };
  await native.files.write(native.workspaceId, state);
  const cutoff = createHash('sha256').update(profileEvaluationId).digest('hex').slice(0, 12);
  const previous = await native.admit({ ...original.request,
    idempotencyKey: `${original.request.idempotencyKey}:retry:profile-cutoff:${cutoff}` }, automationPrincipal);
  const terminal = await native.files.read(native.workspaceId);
  terminal.jobs.find(job => job.id === previous.id)!.state = 'completed';
  await native.files.write(native.workspaceId, terminal);
  await native.maintenance.reconcile(await native.workspace());
  const saved = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(saved.jobs.filter(job => job.state === 'queued' && job.request.action === 'profile')).toEqual([]);
  expect(roots(saved, native)).toHaveLength(1);
  expect(saved.jobs.filter(job => job.request.action === 'profile').sort((a, b) => a.id.localeCompare(b.id))).toEqual(terminal.jobs.filter(job => job.request.action === 'profile').sort((a, b) => a.id.localeCompare(b.id)));
  expect(saved.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(terminal.profiles[`${native.canvasId}:${native.primary.id}`]);
});

it('commits only the available fresh-profile prefix before stopping a full batch ahead of completed-source rechecks', async () => {
  const native = await fixture(true);
  const created = await native.store.createBlock(native.canvasId, {
    title: 'Another initial source', content: '# New initial requirements\nPreserve the checked rollout and source evidence.', x: 400, y: 50,
  }, automationPrincipal.id);
  const held = await native.admit({ action: 'file', canvasId: native.canvasId, blockIds: [native.primary.id] }, automationPrincipal);
  const before = await native.files.read(native.workspaceId);
  const failed = before.jobs.find(job => job.id === native.admitted.id)!;
  failed.state = 'failed'; failed.updatedAt = new Date(Date.now() - 61_000).toISOString();
  const occupants = Array.from({ length: 199 }, (_, index) => ({ ...held, id: `prefix-holder-${index}` }));
  before.jobs = [failed, ...occupants];
  await native.files.write(native.workspaceId, before);
  await native.maintenance.reconcile(await native.workspace());
  const saved = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(saved.jobs.filter(job => ['queued', 'running'].includes(job.state))).toHaveLength(200);
  expect(saved.jobs.filter(job => job.id.startsWith('prefix-holder-'))).toEqual(occupants);
  const admitted = saved.jobs.filter(job => job.state === 'queued' && job.request.action === 'profile');
  expect(admitted).toHaveLength(1);
  expect(admitted[0]).toMatchObject({ attempts: 0, sources: [sourceSnapshot(native.workspaceId, native.canvasId, created)],
    request: { action: 'profile', canvasId: native.canvasId, blockIds: [created.id] } });
  expect(saved.jobs.find(job => job.id === failed.id)).toEqual(failed);
  expect(roots(saved, native).filter(job => (job as StoredJevJob).followupKey)).toEqual([]);
  expect(saved.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(before.profiles[`${native.canvasId}:${native.primary.id}`]);
  const canonical = await native.store.getCanvasBlock(native.canvasId, created.id);
  expect({ content: canonical.content, x: canonical.x, y: canonical.y }).toEqual({ content: created.content, x: created.x, y: created.y });
});

it.each([undefined, 42, ''])('does not defer first organization for a partial checkpoint without a checked organization key (%s)', async value => {
  const native = await fixture(); const before = await native.files.read(native.workspaceId);
  const profile = before.profiles[`${native.canvasId}:${native.primary.id}`];
  if (value === undefined) delete profile.organizationKey; else profile.organizationKey = value;
  await native.files.write(native.workspaceId, before);
  await native.maintenance.reconcile(await native.workspace());
  const saved = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(roots(saved, native)).toHaveLength(1);
  expect(roots(saved, native)[0]).toMatchObject({ state: 'queued' });
  expect(saved.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(profile);
});
