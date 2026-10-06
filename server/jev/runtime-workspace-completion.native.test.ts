import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JevEvaluation, JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { ApiError } from '../errors.js';
import { JevProposalExecutor } from './proposals.js';
import { automationPrincipal } from './authorization.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let files: JevWorkspaceFiles;
let workspaceId: string; let canvasId: string; let blockId: string;
let release: () => void; let entered: Promise<void>; let evaluation: JevEvaluation;
const observed: Array<{ state: string; receipts: number; values: unknown }> = [];

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', ''); observed.length = 0;
  root = await mkdtemp(path.join(tmpdir(), 'jev-workspace-completion-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Workspace completion' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Source' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Evidence', content: '# Evidence\nExact retained evidence.' })).id;
  files = new JevWorkspaceFiles(root);
  let start!: () => void; entered = new Promise<void>(resolve => { start = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  runtime = new JevRuntime(store, { apiKey: '', startTimer: false, evaluate: async (context, request) => {
    const source = context.documents.find(document => document.block.id === blockId)!.snapshot;
    evaluation = { result: { status: 'reviewed' }, proposals: ['first', 'second'].map((name, index) => ({
      action: request.action, title: name, explanation: 'Preserve separate receipts in one durable completion',
      sources: [source], evidence: [], mutation: { kind: 'derived', canvasId, blockId, values: { [`value${index}`]: name } },
    })) };
    start(); await hold; return evaluation;
  } });
  await runtime.idle();
  const write = JevWorkspaceFiles.prototype.write;
  vi.spyOn(JevWorkspaceFiles.prototype, 'write').mockImplementation(async function (this: JevWorkspaceFiles, id, state) {
    await write.call(this, id, state);
    if (this.file(id) !== files.file(workspaceId)) return;
    const persisted = await new JevWorkspaceFiles(root).read(id);
    const job = persisted.jobs.find(item => item.request.idempotencyKey === 'workspace-complete');
    if (job?.result) observed.push({ state: job.state, receipts: persisted.receipts.length, values: persisted.profiles[`${canvasId}:${blockId}`] });
  });
});
afterEach(async () => { release(); await runtime.shutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function reviewedJob(principal = owner) {
  const job = await runtime.run(workspaceId, { action: 'link', canvasId, blockIds: [blockId], idempotencyKey: 'workspace-complete' }, principal);
  await entered; return job;
}

it('publishes both separate guarded derived receipts and the completed job in one durable checkpoint', async () => {
  const job = await reviewedJob(); release(); await runtime.idle();
  expect(observed).toEqual([{ state: 'completed', receipts: 2, values: expect.objectContaining({ value0: 'first', value1: 'second' }) }]);
  const state = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed', result: evaluation.result, proposalIds: expect.any(Array) });
  expect(state.receipts.map(receipt => receipt.proposalId)).toEqual(state.jobs.find(item => item.id === job.id)!.proposalIds);
  expect(state.receipts.every(receipt => receipt.automatic === true && receipt.actor === automationPrincipal.id)).toBe(true);
  expect(state.proposals.every(proposal => proposal.state === 'applied')).toBe(true);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Evidence\nExact retained evidence.');
});

it('retains no obsolete derived effects when the source changes before completion', async () => {
  const job = await reviewedJob(); await store.updateBlock(canvasId, blockId, { content: '# Human edit' }, 'Browser');
  release(); await runtime.idle();
  const state = await files.read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed' });
  expect(state.receipts).toEqual([]); expect(state.profiles[`${canvasId}:${blockId}`]).toBeUndefined(); expect(observed).toEqual([]);
});

it.each([400, 409])('retains an explicit %s candidate hold and the successful sibling in the same checkpoint', async status => {
  const apply = JevProposalExecutor.prototype.applyWorkspaceInside; let attempts = 0;
  vi.spyOn(JevProposalExecutor.prototype, 'applyWorkspaceInside').mockImplementation(async function (this: JevProposalExecutor, ...args) {
    if (++attempts === 2) throw new ApiError(status, 'Native checked candidate rejection');
    return apply.call(this, ...args);
  });
  const job = await reviewedJob(); release(); await runtime.idle();
  const state = await files.read(workspaceId); const completed = state.jobs.find(item => item.id === job.id)!;
  expect(completed).toMatchObject({ state: 'completed', result: { automaticFailures: [{ proposalId: completed.proposalIds[1], reason: 'Native checked candidate rejection' }] } });
  expect(state.receipts).toHaveLength(1);
  expect(state.proposals[1]).toMatchObject({ state: status === 409 ? 'stale' : 'pending', automaticHoldReason: 'Native checked candidate rejection' });
  expect(state.profiles[`${canvasId}:${blockId}`]).toMatchObject({ value0: 'first' });
  expect(state.profiles[`${canvasId}:${blockId}`].value1).toBeUndefined(); expect(observed.map(value => value.state)).toEqual(['completed']);
});

it('fails without publishing a successful sibling when a later nonrecoverable guard rejects completion', async () => {
  const apply = JevProposalExecutor.prototype.applyWorkspaceInside; let attempts = 0;
  vi.spyOn(JevProposalExecutor.prototype, 'applyWorkspaceInside').mockImplementation(async function (this: JevProposalExecutor, ...args) {
    if (++attempts === 2) throw new ApiError(403, 'Native revoked approval');
    return apply.call(this, ...args);
  });
  const job = await reviewedJob(); release(); await runtime.idle();
  const state = await files.read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed', error: 'Native revoked approval' });
  expect(state.receipts).toEqual([]); expect(state.proposals).toEqual([]); expect(state.profiles).toEqual({}); expect(observed).toEqual([]);
});

it('rechecks source bytes after in-memory receipts and discards the whole obsolete checkpoint', async () => {
  const apply = JevProposalExecutor.prototype.applyWorkspaceInside; let attempts = 0;
  vi.spyOn(JevProposalExecutor.prototype, 'applyWorkspaceInside').mockImplementation(async function (this: JevProposalExecutor, ...args) {
    const receipt = await apply.call(this, ...args);
    if (++attempts === 2) await store.updateBlock(canvasId, blockId, { content: '# Human final edit' }, 'Browser');
    return receipt;
  });
  const job = await reviewedJob(); release(); await runtime.idle();
  const state = await files.read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed', error: 'The source changed since Symbi Reflex reviewed it' });
  expect(state.receipts).toEqual([]); expect(state.profiles).toEqual({}); expect(observed).toEqual([]);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Human final edit');
});

it('preserves a concurrent durable workspace replacement instead of overwriting it with staged receipts', async () => {
  const apply = JevProposalExecutor.prototype.applyWorkspaceInside; let replaced = false;
  vi.spyOn(JevProposalExecutor.prototype, 'applyWorkspaceInside').mockImplementation(async function (this: JevProposalExecutor, ...args) {
    const receipt = await apply.call(this, ...args);
    if (!replaced) {
      replaced = true; const current = await files.read(workspaceId); current.profiles.human = { role: 'human-retained' };
      await files.write(workspaceId, current);
    }
    return receipt;
  });
  const job = await reviewedJob(); release(); await runtime.idle();
  const state = await files.read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed', error: 'The workspace checkpoint changed during completion' });
  expect(state.receipts).toEqual([]); expect(state.proposals).toEqual([]); expect(state.profiles).toEqual({ human: { role: 'human-retained' } });
});

it.each([owner, automationPrincipal])('retains the provider hold for vocabulary without applying it for $kind', async principal => {
  const job = await reviewedJob(principal);
  evaluation.proposals = [{ ...evaluation.proposals[0], mutation: { kind: 'vocabulary', operation: 'define', term: {
    id: 'label-native', kind: 'label', name: 'Native label', definition: 'Source-grounded label', aliases: [],
    state: 'active', version: 1, members: [{ canvasId, blockId }],
  } } }];
  release(); await runtime.idle();
  const state = await files.read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed' });
  expect(state.proposals[0]).toMatchObject({ state: principal.kind === 'automation' ? 'dismissed' : 'pending',
    automaticHoldReason: 'A configured processing provider is required' });
  expect(state.vocabulary).toEqual([]); expect(state.receipts).toEqual([]); expect(observed.map(value => value.state)).toEqual(['completed']);
});

it('preserves dismissal of a rejected automatic derived candidate', async () => {
  vi.spyOn(JevProposalExecutor.prototype, 'applyWorkspaceInside').mockRejectedValue(new ApiError(400, 'Native automatic guard'));
  const job = await reviewedJob(automationPrincipal); release(); await runtime.idle();
  const state = await files.read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed', result: { automaticFailures: expect.any(Array) } });
  expect(state.proposals.every(proposal => proposal.state === 'dismissed')).toBe(true); expect(state.receipts).toEqual([]);
});

it('discards staged sibling receipts when cancellation arrives during workspace completion', async () => {
  const apply = JevProposalExecutor.prototype.applyWorkspaceInside;
  vi.spyOn(JevProposalExecutor.prototype, 'applyWorkspaceInside').mockImplementation(async function (this: JevProposalExecutor, ...args) {
    const receipt = await apply.call(this, ...args); runtime.close(); return receipt;
  });
  const job = await reviewedJob(); release(); await runtime.idle();
  const state = await files.read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed', error: 'The action was cancelled or its policy changed' });
  expect(state.receipts).toEqual([]); expect(state.proposals).toEqual([]); expect(state.profiles).toEqual({}); expect(observed).toEqual([]);
});
