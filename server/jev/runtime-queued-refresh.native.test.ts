import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { JevCurrentAction, JevProposal } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import { CanvasStore } from '../storage.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { resolveSharedQuestionSources } from './actions/question-state-pool.test.helpers.js';
import { JevRuntime } from './runtime.js';
import { processingPolicyKey } from './runtime-guards.js';
import type { StoredJevJob } from './runtime-queue.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

type ProviderBody = { state: { document: { id: string; title: string; passages: Array<{ id: string; text: string }> } };
  questions: Record<string, JevQuestion> };
let native: QueueBoundaryFixture; let runtime: JevRuntime; let provider: Server; let origin: string;
let requests: ProviderBody[]; let emptyCanvasId: string;
function answer(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .99 };
  if (question.type === 'score') return { type: 'score', score: 3, confidence: .99,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 3 ? 1 : 0])) };
  const selected = Object.keys(question.criteria).find(key => key === 'p1') ?? Object.keys(question.criteria)[0];
  return { type: 'choice', choice: selected, confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) };
}
beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as ProviderBody; requests.push(body);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({
      answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(question)])),
    }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native queued runtime provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); });
beforeEach(async () => {
  requests = []; native = await queueBoundaryFixture();
  const state = await native.files.read(native.workspaceId);
  state.vocabulary.push({ id: 'reviewed', kind: 'label', name: 'Reviewed', definition: 'Checked release evidence',
    aliases: [], members: [], state: 'active', version: 1 });
  await native.files.write(native.workspaceId, state);
  emptyCanvasId = (await native.store.createCanvas(native.workspaceId, { name: 'Empty wake-up canvas' })).id;
  runtime = new JevRuntime(native.store, { apiKey: '', startTimer: false, documentExecution: false }); await runtime.idle();
});
afterEach(async () => { await runtime.shutdown(); provider.closeAllConnections(); await native.close(); });

async function automaticMetadata(patch: Partial<CanvasBlock>, action: JevCurrentAction) {
  const document = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const source = sourceSnapshot(native.workspaceId, native.canvasId, document);
  const proposal: JevProposal = { id: randomUUID(), jobId: `automatic-${randomUUID()}`, action, title: 'Checked rollout metadata',
    explanation: 'Exact source support.', state: 'pending', confidence: .99, createdAt: new Date().toISOString(),
    sources: [source], evidence: [{ source, start: 0, end: 7, quote: '# Atlas' }],
    mutation: { kind: 'document', canvasId: native.canvasId, blockId: document.id, patch } };
  const state = await native.files.read(native.workspaceId); state.proposals.push(proposal); await native.files.write(native.workspaceId, state);
  await native.files.serial(native.workspaceId, () => native.executor.applyInside(native.workspaceId, proposal.id, automationPrincipal, true));
}
async function prepareQueued(automatic = true): Promise<StoredJevJob> {
  const job = await native.admit({ action: 'label', canvasId: native.canvasId, blockIds: [native.primary.id] },
    automatic ? automationPrincipal : boundaryOwner);
  await automaticMetadata({ group: 'custom:atlas' }, 'file'); await automaticMetadata({ tags: ['Atlas'] }, 'label');
  return job;
}
async function wakeQueuedWorker() {
  runtime.useTransport({ apiKey: 'native-queued-runtime-provider', fetcher: (_url, init) => fetch(origin, init) });
  // An empty retained label request wakes the worker without asking provider questions.
  await runtime.run(native.workspaceId, { action: 'label', canvasId: emptyCanvasId, blockIds: [] }, boundaryOwner);
  await runtime.idle();
}

it('persists the refreshed automatic job vector and uses it for real SDK evidence, proposals and durable receipts', async () => {
  const queued = await prepareQueued(); const original = structuredClone(queued.sources);
  await expect(native.store.jevExecutor.checkSources(original)).rejects.toMatchObject({ status: 409 });
  const expected = sourceSnapshot(native.workspaceId, native.canvasId, await native.store.getCanvasBlock(native.canvasId, native.primary.id));
  await wakeQueuedWorker();
  const state = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const completed = state.jobs.find(job => job.id === queued.id)!;
  const after = sourceSnapshot(native.workspaceId, native.canvasId, await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id));
  expect(completed, JSON.stringify(completed)).toMatchObject({ state: 'completed', attempts: 1, sources: [expected] });
  expect(completed.error).toBeUndefined(); expect(completed.sources[0].metadataRevision).toBe(original[0].metadataRevision + 2);
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0].questions).map(id => id.replace(/^(?:\d+__)+/, ''))).toEqual(expect.arrayContaining([
    'label_0', 'evidence_0',
  ]));
  const shared = requests[0].state as unknown as { questionSets: Record<string, unknown>[]; sourceStates: unknown };
  expect(shared.questionSets.map(set => resolveSharedQuestionSources(set, shared.sourceStates)))
    .toEqual(expect.arrayContaining([expect.objectContaining({ document: expect.objectContaining({ id: native.primary.id, title: native.primary.title }) })]));
  const proposal = state.proposals.find(item => item.jobId === queued.id)!;
  expect(proposal).toMatchObject({ action: 'label', state: 'applied', sources: [expected] });
  expect(proposal.evidence).toHaveLength(2); expect(proposal.evidence.every(passage => passage.source.metadataRevision === expected.metadataRevision)).toBe(true);
  expect(state.receipts.find(receipt => receipt.proposalId === proposal.id)).toMatchObject({ automatic: true, state: 'applied', sourcesAfter: [after] });
  expect(after.metadataRevision).toBe(expected.metadataRevision + 1);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).tags).toEqual(['Atlas', 'Reviewed']);
  expect((await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
  expect(queued.sources).toEqual(original);
});

it('keeps a queued manual label request stale without any provider call or automatic result', async () => {
  const queued = await prepareQueued(false); const before = await native.files.read(native.workspaceId);
  await wakeQueuedWorker(); const state = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(state.jobs.find(job => job.id === queued.id)).toMatchObject({ state: 'failed', sources: queued.sources,
    error: 'The source changed since Symbi Reflex reviewed it' });
  expect(requests).toEqual([]); expect(state.receipts).toEqual(before.receipts);
  expect(state.proposals.filter(proposal => proposal.jobId === queued.id)).toEqual([]);
  expect(state.profiles).toEqual(before.profiles);
});

it.each(['cancel', 'policy'] as const)('honors a queued %s before the provider or any refreshed automatic writes', async reason => {
  const queued = await prepareQueued(); const before = await native.files.read(native.workspaceId);
  if (reason === 'cancel') await runtime.cancel(native.workspaceId, queued.id, boundaryOwner);
  else await runtime.configure(native.workspaceId, { confidenceThresholds: { label: .85 } }, boundaryOwner);
  await wakeQueuedWorker(); const state = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(state.jobs.find(job => job.id === queued.id)).toMatchObject({ state: 'cancelled', sources: queued.sources });
  expect(requests).toEqual([]); expect(state.receipts).toEqual(before.receipts); expect(state.profiles).toEqual(before.profiles);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('rejects an externally changed processing policy at admission with the original message and source vector', async () => {
  const queued = await prepareQueued(); const before = await native.files.read(native.workspaceId);
  before.settings.confidenceThresholds!.label = .85; await native.files.write(native.workspaceId, before);
  await wakeQueuedWorker(); const state = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(state.jobs.find(job => job.id === queued.id)).toMatchObject({ state: 'failed', sources: queued.sources, error: 'The processing policy changed' });
  expect(requests).toEqual([]); expect(state.receipts).toEqual(before.receipts); expect(state.profiles).toEqual(before.profiles);
});

it('rejects a persisted automatic authorization mismatch before refreshing sources or recording an attempt', async () => {
  const queued = await prepareQueued();
  const changed = await native.files.read(native.workspaceId);
  const persisted = changed.jobs.find(job => job.id === queued.id) as StoredJevJob;
  persisted.authorizationFingerprint = principalFingerprint({ ...automationPrincipal, access: 'read' });
  await native.files.write(native.workspaceId, changed);
  const before = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const originalDocument = await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id);
  await wakeQueuedWorker();
  const after = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(after.jobs.find(job => job.id === queued.id)).toMatchObject({ state: 'failed', attempts: 0,
    sources: queued.sources, authorizationFingerprint: persisted.authorizationFingerprint,
    error: 'The authorization changed while the action was queued' });
  expect(after.receipts).toEqual(before.receipts); expect(after.profiles).toEqual(before.profiles);
  expect(after.proposals).toEqual(before.proposals);
  expect(await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id)).toEqual(originalDocument);
  expect(requests).toEqual([]);
});

it('refuses a persisted paused job even when its admitted policy key matches, before refreshing sources or recording an attempt', async () => {
  const queued = await prepareQueued();
  const paused = await native.files.read(native.workspaceId); paused.settings.paused = true;
  const persisted = paused.jobs.find(job => job.id === queued.id) as StoredJevJob;
  // Persisted records or cached candidates must still obey the explicit pause, even when their policy hash agrees.
  persisted.settingsKey = processingPolicyKey(paused); await native.files.write(native.workspaceId, paused);
  const before = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const originalDocument = await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id);
  const current = sourceSnapshot(native.workspaceId, native.canvasId, originalDocument);
  expect(persisted.sources).toEqual(queued.sources); expect(current.metadataRevision).toBe(queued.sources[0].metadataRevision + 2);
  expect(processingPolicyKey(before)).toBe(persisted.settingsKey);
  runtime.useTransport({ apiKey: 'native-queued-runtime-provider', fetcher: (_url, init) => fetch(origin, init) });
  const admission = runtime as unknown as {
    takeJob(workspaceId: string, jobId: string, controller: AbortController): Promise<StoredJevJob | undefined>;
  };
  await expect(admission.takeJob(native.workspaceId, queued.id, new AbortController()))
    .rejects.toMatchObject({ status: 409, message: 'The processing policy changed' });
  const after = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(after.revision).toBe(before.revision);
  expect(after.jobs.find(job => job.id === queued.id)).toEqual(before.jobs.find(job => job.id === queued.id));
  expect(after.jobs.find(job => job.id === queued.id)).toMatchObject({ state: 'queued', attempts: 0, sources: queued.sources });
  expect(after).toEqual(before);
  expect(await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id)).toEqual(originalDocument);
  expect(requests).toEqual([]);
});
