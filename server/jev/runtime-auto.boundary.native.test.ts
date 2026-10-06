import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import type { JevEvaluator } from './actions/context.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string; let blocks: CanvasBlock[]; let evaluate: JevEvaluator;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-auto-boundary-')); store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Auto failures' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  blocks = [];
  for (const [index, content] of ['# ' + 'A'.repeat(81), '# Atlas source', '# Reviewed source', '# Delivery source'].entries()) {
    blocks.push(await store.createBlock(canvasId, { title: `Source ${index}`, content }));
  }
  evaluate = async (context, request) => ({ result: {}, proposals: context.documents.map(document => ({
    action: request.action, title: 'Extractive source headline', explanation: 'Exact source-backed passage', confidence: 0.99,
    sources: [document.snapshot], evidence: [{ source: document.snapshot, start: 0, end: document.block.content.length, quote: document.block.content }],
    mutation: { kind: 'document', canvasId, blockId: document.block.id, patch: { tags: [document.block.content] } } })) });
  runtime = new JevRuntime(store, { startTimer: false, evaluate: (context, request) => evaluate(context, request) });
  await runtime.configure(workspaceId, { externalProcessing: true, modes: { label: 'auto' } as never }, owner);
  await runtime.idle(); runtime.useTransport({ apiKey: 'native-provider-policy' });
});
afterEach(async () => { runtime.close(); await runtime.idle().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
it('records an invalid label and later human source conflict while applying independent eligible siblings', async () => {
  const execute = store.jevExecutor.execute.bind(store.jevExecutor); let corrected = false;
  store.jevExecutor.execute = async (...args) => {
    const saved = await execute(...args);
    if (!corrected && args[0].kind === 'document' && args[0].blockId === blocks[1].id) {
      corrected = true; await store.updateBlock(canvasId, blocks[2].id, { tags: ['manual correction'] }, 'Browser');
    }
    return saved;
  };
  const job = await runtime.run(workspaceId, { action: 'label', canvasId }, owner); await runtime.idle();
  const state = await runtime.read(workspaceId, owner); const finished = state.jobs.find(item => item.id === job.id)!;
  expect(finished.state).toBe('completed'); expect(finished.result?.automaticFailures).toHaveLength(2);
  const invalid = state.proposals.find(item => item.mutation.kind === 'document' && item.mutation.blockId === blocks[0].id)!;
  expect(invalid).toMatchObject({ state: 'pending', automaticHoldReason: 'tags must be an array of at most 20 nonempty labels, each at most 40 characters' });
  const stale = state.proposals.find(item => item.mutation.kind === 'document' && item.mutation.blockId === blocks[2].id)!;
  expect(stale).toMatchObject({ state: 'stale', automaticHoldReason: 'The source changed since Symbi Reflex reviewed it' });
  const canvas = await new CanvasStore(root).getCanvas(canvasId, true);
  expect(canvas.blocks.find(block => block.id === blocks[1].id)?.tags).toEqual(['# Atlas source']);
  expect(canvas.blocks.find(block => block.id === blocks[3].id)?.tags).toEqual(['# Delivery source']);
  expect(canvas.blocks.find(block => block.id === blocks[2].id)?.tags).toEqual(['manual correction']);
  expect(canvas.blocks.map(block => block.content)).toEqual(blocks.map(block => block.content));
  expect(state.receipts.filter(receipt => receipt.automatic)).toHaveLength(2);
});
it('keeps a canonical write failure out of completed activity and recovers its genuine preparation later', async () => {
  evaluate = async (context, request) => {
    const document = context.documents.find(item => item.block.id === blocks[1].id)!;
    return { result: {}, proposals: [{ action: request.action, title: 'Set source headline', explanation: 'Exact source', confidence: 0.99,
      sources: [document.snapshot], evidence: [{ source: document.snapshot, start: 0, end: 7, quote: '# Atlas' }],
      mutation: { kind: 'document', canvasId, blockId: blocks[1].id, patch: { tags: ['# Atlas'] } } }] };
  };
  const file = path.join(root, 'canvases', `${canvasId}.json`); const execute = store.jevExecutor.execute.bind(store.jevExecutor);
  store.jevExecutor.execute = (mutation, sources, id, actor, managed, prepare, ownership, undo) =>
    execute(mutation, sources, id, actor, managed, async plan => { await prepare(plan); await rename(file, file + '.before'); await mkdir(file); }, ownership, undo);
  const job = await runtime.run(workspaceId, { action: 'label', canvasId, blockIds: [blocks[1].id] }, owner); await runtime.idle();
  const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
  expect(state.jobs.find(item => item.id === job.id)?.state).toBe('failed'); expect(state.receipts).toEqual([]); expect(state.prepared).toHaveLength(1);
  await rm(file, { recursive: true }); await rename(file + '.before', file); store.jevExecutor.execute = execute;
  expect((await store.getCanvasBlock(canvasId, blocks[1].id)).tags).toBeUndefined();
  await runtime.reconcile(workspaceId);
  expect((await store.getCanvasBlock(canvasId, blocks[1].id)).tags).toEqual(['# Atlas']);
  expect((await files.read(workspaceId)).prepared).toEqual([]);
  expect((await files.read(workspaceId)).receipts).toHaveLength(1);
});
it('propagates a checked recovery error instead of silently completing the Auto job', async () => {
  evaluate = async (context, request) => {
    const document = context.documents.find(item => item.block.id === blocks[1].id)!;
    return { result: {}, proposals: [{ action: request.action, title: 'Set exact headline', explanation: 'Exact source', confidence: 0.99,
      sources: [document.snapshot], evidence: [{ source: document.snapshot, start: 0, end: 7, quote: '# Atlas' }],
      mutation: { kind: 'document', canvasId, blockId: blocks[1].id, patch: { tags: ['# Atlas'] } } }] };
  };
  const execute = store.jevExecutor.execute.bind(store.jevExecutor);
  store.jevExecutor.execute = (mutation, sources, id, actor, managed, prepare, ownership, undo) =>
    execute(mutation, sources, id, actor, managed, async plan => { await prepare(plan); plan.artifacts[0].id = '../invalid-prepared-target'; }, ownership, undo);
  const job = await runtime.run(workspaceId, { action: 'label', canvasId, blockIds: [blocks[1].id] }, owner); await runtime.idle();
  store.jevExecutor.execute = execute;
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed', error: 'Invalid recovery artifact' });
  expect((await store.getCanvasBlock(canvasId, blocks[1].id)).tags).toBeUndefined();
});
