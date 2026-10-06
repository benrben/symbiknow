import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import type { JevEvaluator } from './actions/context.js';
import { automationPrincipal } from './authorization.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string; let blockId: string;
let evaluate: JevEvaluator;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-automatic-guards-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Automatic recovery' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' })).id;
  evaluate = async () => ({ result: {}, proposals: [] });
  runtime = new JevRuntime(store, { startTimer: false, evaluate: (context, request) => evaluate(context, request) });
  await runtime.idle();
});
afterEach(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });

it('preserves a durable completed job if a late provider failure arrives from an older runner', async () => {
  evaluate = async () => {
    const files = new JevWorkspaceFiles(root);
    await files.serial(workspaceId, async () => {
      const state = await files.read(workspaceId);
      state.jobs.find(job => job.state === 'running')!.state = 'completed';
      await files.write(workspaceId, state);
    });
    throw new Error('Late response from interrupted provider work');
  };
  const job = await runtime.run(workspaceId, { action: 'label', canvasId, blockIds: [blockId] }, owner);
  await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed' });
  expect((await runtime.read(workspaceId, owner)).receipts).toEqual([]);
});

it('dismisses an invalid automatic label while retaining an explicit failure and original source bytes', async () => {
  runtime.useTransport({ apiKey: 'native-policy-fixture' });
  evaluate = async (context, request) => {
    const source = context.documents.find(document => document.block.id === blockId)!;
    return { result: {}, proposals: [{ action: request.action, title: 'Unsupported label length', explanation: 'Exact source',
      sources: [source.snapshot], evidence: [{ source: source.snapshot, start: 0, end: 7, quote: '# Atlas' }], confidence: 0.99,
      mutation: { kind: 'document', canvasId, blockId, patch: { tags: ['A'.repeat(81)] } } }] };
  };
  const job = await runtime.run(workspaceId, { action: 'label', canvasId, blockIds: [blockId] }, automationPrincipal);
  await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed', result: { automaticFailures: [{ reason: expect.stringContaining('40 characters') }] } });
  expect(state.proposals.find(item => item.jobId === job.id)).toMatchObject({ state: 'dismissed', automaticHoldReason: expect.stringContaining('40 characters') });
  expect((await store.getCanvasBlock(canvasId, blockId)).tags).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source');
});

it('rejects revised source bytes even when an evaluator returns an unsupported content proposal', async () => {
  evaluate = async (context, request) => {
    const source = context.documents.find(document => document.block.id === blockId)!;
    return { result: {}, proposals: [{ action: request.action, title: 'Unexpected source edit', explanation: 'Unsupported automatic source edit',
      sources: [source.snapshot], evidence: [{ source: source.snapshot, start: 0, end: 7, quote: '# Atlas' }],
      mutation: { kind: 'content', canvasId, blockId, content: '# Proposed source', expectedContentHash: source.snapshot.contentHash, draftId: 'unexpected-draft' } }] };
  };
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId] }, owner);
  await runtime.idle();
  const proposal = (await runtime.read(workspaceId, owner)).proposals.find(item => item.jobId === job.id)!;
  expect(proposal.mutation.kind).toBe('content');
  const revised = { ...proposal.mutation, content: '# Revised source' } as Extract<typeof proposal.mutation, { kind: 'content' }>;
  await expect(runtime.revise(workspaceId, proposal.id, revised, owner)).rejects.toMatchObject({ status: 409, message: 'Revised source bytes require a new staged review' });
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source');
});

it('does not recursively schedule its own source saves', async () => {
  runtime.useTransport({ apiKey: 'native-policy-fixture' });
  const source = await store.createBlock(canvasId, { title: 'Automatic source', content: '# Automatic source' }, automationPrincipal.id);
  await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual([]);
  expect((await store.getCanvasBlock(canvasId, source.id)).content).toBe('# Automatic source');
});
