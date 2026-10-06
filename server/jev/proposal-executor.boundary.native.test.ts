import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevMutation, JevPrincipal, JevProposal, JevVocabularyTerm } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { automationPrincipal } from './authorization.js';
import { JevProposalExecutor, type PreparedJevMutation } from './proposals.js';
import { JevWorkspaceFiles } from './workspace.js';
import { sourceSnapshot } from './stamps.js';
import { ApiError } from '../errors.js';

const owner: JevPrincipal = { id: 'reviewer', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let files: JevWorkspaceFiles; let executor: JevProposalExecutor;
let workspaceId: string; let canvasId: string; let blockId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-proposal-executor-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Canonical review' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' })).id;
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async (context, request) => {
    const document = context.documents.find(item => item.block.id === blockId)!;
    return { result: {}, proposals: [{ action: request.action, title: 'File supported source', explanation: 'Exact local evidence', confidence: 0.99,
      sources: [document.snapshot], evidence: [{ source: document.snapshot, start: 0, end: 7, quote: '# Atlas' }],
      mutation: { kind: 'document', canvasId, blockId, patch: { group: 'custom:atlas' } } }] };
  } });
  await runtime.configure(workspaceId, { modes: { file: 'auto' } as never }, owner);
  files = new JevWorkspaceFiles(root); executor = new JevProposalExecutor(store, files);
});
afterEach(async () => { runtime.close(); await runtime.idle(); await rm(root, { recursive: true, force: true }); });
async function pending() {
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId] }, owner); await runtime.idle();
  return (await runtime.read(workspaceId, owner)).proposals.find(item => item.jobId === job.id)!;
}
async function recordProposal(mutation: JevMutation): Promise<JevProposal> {
  const proposal = await pending(); const state = await files.read(workspaceId); state.proposals.find(item => item.id === proposal.id)!.mutation = mutation;
  await files.write(workspaceId, state); return { ...proposal, mutation };
}
async function prepareLegacy(proposal: JevProposal, id: string, retainProposal = true) {
  await store.jevExecutor.execute(proposal.mutation, proposal.sources, id, owner.id, true, async plan => {
    const state = await files.read(workspaceId); if (!retainProposal) state.proposals = state.proposals.filter(item => item.id !== proposal.id);
    const record: PreparedJevMutation = { id, proposal, before: plan.before, after: plan.after, artifacts: plan.artifacts, ownershipBefore: plan.ownershipBefore };
    state.prepared.push(record); await files.write(workspaceId, state);
  });
}
it('checks missing, dismissed, and paused proposals, and treats an already-applied preflight as idempotent', async () => {
  const proposal = await pending();
  expect((await executor.precheckInside(workspaceId, proposal.id, owner)).id).toBe(proposal.id);
  await expect(executor.precheckInside(workspaceId, 'missing', owner)).rejects.toMatchObject({ status: 404 });
  await runtime.dismiss(workspaceId, proposal.id, owner);
  await expect(runtime.apply(workspaceId, proposal.id, owner)).rejects.toMatchObject({ status: 409 });
  await expect(runtime.undo(workspaceId, 'missing', owner)).rejects.toMatchObject({ status: 404 });
  await store.updateBlock(canvasId, blockId, { content: '# Atlas fresh source' }, owner.id);
  const fresh = await pending(); await runtime.configure(workspaceId, { paused: true }, owner);
  await expect(executor.precheckInside(workspaceId, fresh.id, owner)).rejects.toMatchObject({ status: 409, message: 'Symbi Reflex is paused' });
  await runtime.configure(workspaceId, { paused: false }, owner);
  const receipt = await runtime.apply(workspaceId, fresh.id, owner);
  expect((await executor.precheckInside(workspaceId, fresh.id, owner)).receiptId).toBe(receipt.id);
  await runtime.undo(workspaceId, receipt.id, owner);
  expect((await runtime.undo(workspaceId, receipt.id, owner)).id).toBe(receipt.id);
});
it('refuses token self-approval even at the trusted automatic executor boundary', async () => {
  const credential = await store.createMcpToken('Scoped agent', 'propose', { allowedCanvasIds: [canvasId], tools: ['jev_propose'] });
  const principal: JevPrincipal = { ...(await store.mcpTokenIdentity(credential.token))!, kind: 'token' };
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId] }, principal); await runtime.idle();
  const proposal = (await runtime.read(workspaceId, owner)).proposals.find(item => item.jobId === job.id)!;
  await expect(executor.applyInside(workspaceId, proposal.id, principal, true)).rejects.toMatchObject({ status: 403, message: 'An agent cannot approve its own proposal' });
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
it('preflights a child definition against an explicit projected parent, then checks actual definitions before committing', async () => {
  const parent: JevVocabularyTerm = { id: 'atlas-parent', kind: 'group', groupKey: 'custom:atlas', name: 'Atlas', definition: 'Atlas sources', aliases: [], state: 'active', version: 1, members: [] };
  const child = { ...parent, id: 'atlas-child', groupKey: 'custom:atlas/planning', parentId: parent.id, name: 'Planning' };
  const proposal = await recordProposal({ kind: 'vocabulary', operation: 'define', term: child });
  await expect(executor.precheckInside(workspaceId, proposal.id, owner)).rejects.toMatchObject({ status: 409 });
  expect((await executor.precheckInside(workspaceId, proposal.id, owner, { vocabulary: [parent] })).id).toBe(proposal.id);
  await expect(executor.applyInside(workspaceId, proposal.id, owner)).rejects.toMatchObject({ status: 409 });
  const state = await files.read(workspaceId); const parentProposal = { ...proposal, id: 'native-parent', mutation: { kind: 'vocabulary' as const, operation: 'define' as const, term: parent } };
  state.proposals.push(parentProposal); await files.write(workspaceId, state);
  await executor.applyInside(workspaceId, parentProposal.id, owner); await executor.applyInside(workspaceId, proposal.id, owner);
  expect((await files.read(workspaceId)).vocabulary.map(term => term.id)).toEqual([parent.id, child.id]);
});
it('recovers the actual move artifacts with the new destination source and legacy actor defaults', async () => {
  const targetCanvasId = (await store.createCanvas(workspaceId, { name: 'Destination' })).id;
  const proposal = await recordProposal({ kind: 'move', canvasId, blockId, targetCanvasId });
  await prepareLegacy(proposal, 'native-move-recovery', false); await executor.recoverInside(workspaceId);
  const state = await files.read(workspaceId); const receipt = state.receipts[0];
  expect(receipt.actor).toBe('workspace-automation'); expect(receipt.sourcesAfter[0].canvasId).toBe(targetCanvasId);
  expect((await new CanvasStore(root).getCanvasBlock(targetCanvasId, blockId)).content).toBe('# Atlas source');
  expect(state.prepared).toEqual([]); await executor.recoverInside(workspaceId);
  expect((await files.read(workspaceId)).receipts).toHaveLength(1);
});
it('recovers an unrelated saved task when its original evidence source was later removed', async () => {
  const proposal = await recordProposal({ kind: 'task_create', canvasId, task: { id: 'native-recovered-task', title: 'Independent task', detail: '', blockIds: [] } });
  await prepareLegacy(proposal, 'native-task-recovery'); await store.deleteBlock(canvasId, blockId);
  await runtime.idle();
  await executor.recoverInside(workspaceId);
  const recovered = await files.read(workspaceId);
  expect(recovered.prepared).toEqual([]);
  expect(recovered.receipts).toHaveLength(1);
  expect(recovered.receipts[0].sourcesAfter).toEqual([]);
  expect((await new CanvasStore(root).listTasks(canvasId))[0].title).toBe('Independent task');
});
it('rejects a legacy prepared record lacking canonical artifacts before inventing a commit', async () => {
  const proposal = await pending(); const state = await files.read(workspaceId);
  state.prepared.push({ id: 'legacy-incomplete', proposal, before: proposal.mutation, after: proposal.mutation });
  await files.write(workspaceId, state);
  await expect(executor.recoverInside(workspaceId)).rejects.toMatchObject({ status: 503, message: 'Symbi Reflex recovery metadata is incomplete' });
  expect((await files.read(workspaceId)).receipts).toEqual([]);
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
it('commits a derived analysis without owner approval while keeping the canonical document untouched', async () => {
  const proposal = await recordProposal({ kind: 'derived', blockId, values: { role: 'note' } });
  const receipt = await executor.applyInside(workspaceId, proposal.id, automationPrincipal, true);
  expect(receipt.after.kind).toBe('derived'); expect(receipt.automatic).toBe(true);
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
  expect(sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, blockId))).toEqual(proposal.sources[0]);
});
it('keeps an interrupted Undo journal recoverable when its original receipt is missing', async () => {
  const receipt = await runtime.apply(workspaceId, (await pending()).id, owner);
  const execute = store.jevExecutor.execute.bind(store.jevExecutor);
  store.jevExecutor.execute = (mutation, sources, id, actor, managed, prepare, ownership, undo) =>
    execute(mutation, sources, id, actor, managed, async plan => { await prepare(plan); throw new ApiError(503, 'Interrupted checked Undo'); }, ownership, undo);
  await expect(executor.undoInside(workspaceId, receipt.id, owner)).rejects.toMatchObject({ status: 503 });
  store.jevExecutor.execute = execute;
  const state = await files.read(workspaceId); state.receipts = state.receipts.filter(item => item.id !== receipt.id); await files.write(workspaceId, state);
  await expect(executor.recoverInside(workspaceId)).rejects.toMatchObject({ status: 503, message: 'Symbi Reflex Undo recovery requires its original receipt' });
  expect((await files.read(workspaceId)).prepared).toHaveLength(1);
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBe('custom:atlas');
  const repaired = await files.read(workspaceId); repaired.receipts.push(receipt); await files.write(workspaceId, repaired);
  await executor.recoverInside(workspaceId);
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
