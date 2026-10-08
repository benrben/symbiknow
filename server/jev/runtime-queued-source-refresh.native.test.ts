import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { JevAction, JevCurrentAction, JevProposal } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../jev.js';
import { evaluateJevAction } from './actions.js';
import { evaluationContext } from './context.js';
import { automationPrincipal } from './authorization.js';
import { boundaryOwner, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { queueBoundaryCopies } from './queue-boundary-copy.test.fixture.js';
import { JevProposalExecutor } from './proposals.js';
import type { StoredJevJob } from './runtime-queue.js';
import { validateJevEvaluation } from './runtime-guards.js';
import { currentQueuedSources, queuedSourceRefreshEligible } from './runtime-queued-source-refresh.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

let native: QueueBoundaryFixture;
let copies: Awaited<ReturnType<typeof queueBoundaryCopies>>;
let queued: StoredJevJob;
let provider: Server; let origin: string; let requests: Array<{ state: unknown; questions: Record<string, JevQuestion> }>;
function answer(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .99 };
  if (question.type === 'score') return { type: 'score', score: 3, confidence: .99,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 3 ? 1 : 0])) };
  const selected = Object.keys(question.criteria).find(key => key === 'p1') ?? Object.keys(question.criteria)[0];
  return { type: 'choice', choice: selected, confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) };
}
beforeAll(async () => {
  copies = await queueBoundaryCopies();
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { state: unknown; questions: Record<string, JevQuestion> }; requests.push(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(question)])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Queued source provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  await copies.close();
});
beforeEach(async () => {
  requests = [];
  native = await copies.fixture();
  queued = await native.admit({ action: 'profile', canvasId: native.canvasId,
    blockIds: [native.primary.id], idempotencyKey: `queued-profile-${randomUUID()}` }, automationPrincipal);
});
afterEach(async () => { await native.close(); });

async function automaticMetadata(patch: Partial<CanvasBlock>, action: JevCurrentAction) {
  const document = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const source = sourceSnapshot(native.workspaceId, native.canvasId, document);
  const proposal: JevProposal = { id: randomUUID(), jobId: `automatic-${randomUUID()}`, action, title: 'Use checked Atlas evidence',
    explanation: 'Current exact source support.', state: 'pending', confidence: .99,
    createdAt: new Date().toISOString(), sources: [source], evidence: [{ source, start: 0, end: 7, quote: '# Atlas' }],
    mutation: { kind: 'document', canvasId: native.canvasId, blockId: document.id, patch } };
  const state = await native.files.read(native.workspaceId); state.proposals.push(proposal); await native.files.write(native.workspaceId, state);
  await native.files.serial(native.workspaceId, () => native.executor.applyInside(native.workspaceId, proposal.id, automationPrincipal, true));
}

it('refreshes a still-queued automatic profile source after two actual checked metadata commits and restart', async () => {
  await automaticMetadata({ group: 'custom:atlas' }, 'file'); await automaticMetadata({ tags: ['Atlas'] }, 'label');
  const store = new CanvasStore(native.root); const files = new JevWorkspaceFiles(native.root);
  const original = (await files.read(native.workspaceId)).jobs.find(job => job.id === queued.id) as StoredJevJob;
  await expect(store.jevExecutor.checkSources(original.sources)).rejects.toMatchObject({ status: 409 });
  const before = JSON.stringify(original); const refreshed = await currentQueuedSources(store, native.workspaceId, original);
  const current = await store.getCanvasBlock(native.canvasId, native.primary.id);
  expect(refreshed).toEqual([sourceSnapshot(native.workspaceId, native.canvasId, current)]);
  expect(queuedSourceRefreshEligible(original)).toBe(true);
  expect(refreshed[0]).toMatchObject({ incarnation: queued.sources[0].incarnation, sourceGeneration: queued.sources[0].sourceGeneration,
    contentHash: queued.sources[0].contentHash, metadataRevision: queued.sources[0].metadataRevision + 2 });
  await expect(store.jevExecutor.checkSources(refreshed)).resolves.toBeUndefined();
  expect(JSON.stringify(original)).toBe(before); expect(current.content).toBe(native.primary.content);
});

it('evaluates refreshed source-local questions through the real SDK and durably saves their exact current evidence', async () => {
  await automaticMetadata({ group: 'custom:atlas' }, 'file'); await automaticMetadata({ tags: ['Atlas'] }, 'label');
  const store = new CanvasStore(native.root); const files = new JevWorkspaceFiles(native.root);
  const state = await files.read(native.workspaceId);
  const job = state.jobs.find(item => item.id === queued.id) as StoredJevJob;
  job.sources = await currentQueuedSources(store, native.workspaceId, job);
  job.state = 'running'; await files.write(native.workspaceId, state);
  await store.jevExecutor.checkSources(job.sources);
  const context = await evaluationContext(store, native.workspaceId, state, job.request, automationPrincipal, new AbortController().signal);
  context.apiKey = 'native-queued-source-provider';
  context.decider = (key, input, questions, _fetcher, options) => decideWithJev(key, input, questions,
    (_url, init) => fetch(origin, init), options);
  const evaluated = await evaluateJevAction(context, job.request);
  validateJevEvaluation(evaluated, context, job.request, automationPrincipal);
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0].questions)).toEqual(expect.arrayContaining([
    'role', 'keyPassage',
  ]));
  expect(evaluated.proposals).toHaveLength(1);
  expect(evaluated.proposals[0].sources).toEqual(job.sources);
  expect(evaluated.proposals[0].evidence).toHaveLength(1);
  expect(evaluated.proposals[0].evidence.every(passage => passage.source.metadataRevision === queued.sources[0].metadataRevision + 2)).toBe(true);
  const candidate: JevProposal = { ...evaluated.proposals[0], id: randomUUID(), jobId: job.id, state: 'pending', createdAt: new Date().toISOString() };
  state.proposals.push(candidate); await files.write(native.workspaceId, state);
  await files.serial(native.workspaceId, () => new JevProposalExecutor(store, files).applyInside(native.workspaceId, candidate.id, automationPrincipal, true));
  const readback = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(readback.profiles[`${native.canvasId}:${native.primary.id}`]).toMatchObject({ source: job.sources[0], role: 'overview', roleConfidence: .99 });
  expect(readback.receipts.find(receipt => receipt.proposalId === candidate.id)?.sourcesAfter).toEqual(job.sources);
  expect((await new CanvasStore(native.root).getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it.each(['profile', 'label'] as const)('refreshes only the supported simple automatic %s request before it starts', async action => {
  queued.request.action = action; await automaticMetadata({ tags: ['Atlas'] }, 'label');
  expect(queuedSourceRefreshEligible(queued)).toBe(true);
  expect((await currentQueuedSources(native.store, native.workspaceId, queued))[0].metadataRevision).toBe(queued.sources[0].metadataRevision + 1);
});

const eligibilityBarriers: Record<string, (job: StoredJevJob) => void> = {
  'running evaluation': job => { job.state = 'running'; },
  'cancelled evaluation': job => { job.state = 'cancelled'; },
  'completed evaluation': job => { job.state = 'completed'; },
  'failed evaluation': job => { job.state = 'failed'; },
  'scope-exclusive filing': job => { job.request.action = 'file'; },
  'workspace recall': job => { job.request.action = 'recall'; },
  'retired action': job => { job.request.action = 'set_headline' as JevAction; },
  'explicit query': job => { job.request.query = ''; },
  'explicit options': job => { job.request.options = {}; },
  'whole-canvas request': job => { delete job.request.blockIds; },
  'empty source selection': job => { job.request.blockIds = []; },
  'manual owner job': job => { job.principal = boundaryOwner; },
  'token job': job => { job.principal = { ...automationPrincipal, kind: 'token' }; },
  'different automatic identity': job => { job.principal = { ...automationPrincipal, id: 'other-automation' }; },
  'read-only automatic principal': job => { job.principal = { ...automationPrincipal, access: 'read' }; },
  'restricted automatic principal': job => { job.principal = { ...automationPrincipal, allowedCanvasIds: [] }; },
  'missing stored principal': job => { job.principal = undefined as never; },
};
it.each(Object.entries(eligibilityBarriers))('preserves original snapshots for a %s', async (_name, change) => {
  await automaticMetadata({ tags: ['Atlas'] }, 'label'); change(queued);
  expect(queuedSourceRefreshEligible(queued)).toBe(false);
  expect(await currentQueuedSources(native.store, native.workspaceId, queued)).toBe(queued.sources);
  await expect(native.store.jevExecutor.checkSources(queued.sources)).rejects.toMatchObject({ status: 409 });
  expect(requests).toEqual([]);
});

const scopeBarriers: Record<string, (job: StoredJevJob) => void> = {
  'missing selected guard': job => { job.sources = []; },
  'duplicate guard': job => { job.sources.push(structuredClone(job.sources[0])); },
  'extra selected identity': job => { job.request.blockIds!.push('not-guarded'); },
  'unselected guarded identity': job => { job.sources[0].blockId = 'not-selected'; },
  'foreign guarded workspace': job => { job.sources[0].workspaceId = 'another-workspace'; },
  'foreign guarded canvas': job => { job.sources[0].canvasId = 'another-canvas'; },
};
it.each(Object.entries(scopeBarriers))('keeps all original snapshots at a %s scope barrier', async (_name, change) => {
  await automaticMetadata({ tags: ['Atlas'] }, 'label'); change(queued);
  expect(queuedSourceRefreshEligible(queued)).toBe(true);
  expect(await currentQueuedSources(native.store, native.workspaceId, queued)).toBe(queued.sources);
  expect(requests).toEqual([]);
});

it('keeps a canvas outside the requested workspace and a missing workspace unrefreshed', async () => {
  const workspaceId = (await native.store.createWorkspace({ name: 'Other tenant' })).id;
  queued.sources[0].workspaceId = workspaceId;
  expect(await currentQueuedSources(native.store, workspaceId, queued)).toBe(queued.sources);
  queued.sources[0].workspaceId = 'missing-workspace';
  expect(await currentQueuedSources(native.store, 'missing-workspace', queued)).toBe(queued.sources);
});

it.each(['content', 'title'] as const)('preserves the original conflict after a real source %s edit', async field => {
  await native.store.updateBlock(native.canvasId, native.primary.id, { [field]: field === 'content' ? '# Changed Atlas requirements' : 'Revised release' }, 'Browser');
  expect(await currentQueuedSources(native.store, native.workspaceId, queued)).toBe(queued.sources);
  await expect(native.store.jevExecutor.checkSources(queued.sources)).rejects.toMatchObject({ status: 409 });
});

it('keeps external source byte changes guarded even when no generation stamp was written', async () => {
  await writeFile(path.join(native.root, native.primary.file), '# Externally revised Atlas requirements\n');
  expect(await currentQueuedSources(new CanvasStore(native.root), native.workspaceId, queued)).toBe(queued.sources);
  await expect(native.store.jevExecutor.checkSources(queued.sources)).rejects.toMatchObject({ status: 409 });
});

it('keeps a new source incarnation guarded even when identity, bytes and generation match', async () => {
  const file = path.join(native.root, 'canvases', `${native.canvasId}.json`);
  const canvas = JSON.parse(await readFile(file, 'utf8'));
  canvas.blocks.find((block: CanvasBlock) => block.id === native.primary.id).incarnation = randomUUID();
  await atomicJson(file, canvas);
  expect(await currentQueuedSources(new CanvasStore(native.root), native.workspaceId, queued)).toBe(queued.sources);
  await expect(native.store.jevExecutor.checkSources(queued.sources)).rejects.toMatchObject({ status: 409 });
});

it('returns the entire original guard set when one selected source changed', async () => {
  const other = await native.store.createBlock(native.canvasId, { title: 'Atlas acceptance', content: '# Atlas acceptance\nKeep release evidence.' });
  queued.request.blockIds!.push(other.id); queued.sources.push(sourceSnapshot(native.workspaceId, native.canvasId, other));
  await automaticMetadata({ tags: ['Atlas'] }, 'label');
  await native.store.updateBlock(native.canvasId, other.id, { content: '# New acceptance requirements' }, 'Browser');
  expect(await currentQueuedSources(native.store, native.workspaceId, queued)).toBe(queued.sources);
  await expect(native.store.jevExecutor.checkSources(queued.sources)).rejects.toMatchObject({ status: 409 });
});

it('keeps missing and moved source guards for the existing canonical failure', async () => {
  await native.store.moveBlockToCanvas(native.canvasId, native.primary.id, native.otherCanvasId, 'Browser');
  expect(await currentQueuedSources(native.store, native.workspaceId, queued)).toBe(queued.sources);
  await expect(native.store.jevExecutor.checkSources(queued.sources)).rejects.toMatchObject({ status: 404 });
});

it('propagates an unexpected native file failure instead of treating it as a metadata refresh', async () => {
  await rm(path.join(native.root, native.primary.file));
  await expect(currentQueuedSources(native.store, native.workspaceId, queued)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('propagates invalid native source stamps instead of manufacturing an identity', async () => {
  const file = path.join(native.root, 'canvases', `${native.canvasId}.json`); const canvas = JSON.parse(await readFile(file, 'utf8'));
  delete canvas.blocks.find((block: CanvasBlock) => block.id === native.primary.id).incarnation; await atomicJson(file, canvas);
  await expect(currentQueuedSources(new CanvasStore(native.root), native.workspaceId, queued)).rejects.toMatchObject({ status: 409 });
});

it('retains exact source guards after evaluation has started and metadata changes again', async () => {
  await automaticMetadata({ tags: ['Atlas'] }, 'label');
  queued.sources = await currentQueuedSources(native.store, native.workspaceId, queued); queued.state = 'running';
  const evaluatedSources = structuredClone(queued.sources);
  await automaticMetadata({ group: 'custom:atlas' }, 'file');
  expect(await currentQueuedSources(native.store, native.workspaceId, queued)).toBe(queued.sources);
  expect(queued.sources).toEqual(evaluatedSources);
  await expect(native.store.jevExecutor.checkSources(evaluatedSources)).rejects.toMatchObject({ status: 409 });
});
