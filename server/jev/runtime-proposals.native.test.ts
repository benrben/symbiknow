import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevEvaluation, JevJob, JevMutation, JevPrincipal, JevProposal, JevReceipt } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';
import { JevProposalExecutor, proposalKey } from './proposals.js';
import { recordJevCandidates } from './runtime-proposals.js';
import { sourceSnapshot } from './stamps.js';
import type { JevEvaluationContext } from './actions/context.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let files: JevWorkspaceFiles; let runtime: JevRuntime | undefined;
let workspaceId: string; let canvasId: string; let blockId: string; let calls: number;
function evaluate(context: JevEvaluationContext): Promise<JevEvaluation> {
  calls += 1;
  context.apiKey = 'native-label-policy';
  const document = context.documents.find(item => item.block.id === blockId)!;
  return Promise.resolve({ result: {}, proposals: [{ action: 'label', title: 'Label Atlas', explanation: 'Exact supported source topic',
    evidence: [{ source: document.snapshot, start: 0, end: document.block.content.length, quote: document.block.content }],
    sources: [document.snapshot], confidence: 0.99,
    mutation: { kind: 'document', canvasId, blockId, patch: { tags: ['Atlas'] } } }] });
}
beforeEach(async () => {
  calls = 0; runtime = undefined; root = await mkdtemp(path.join(tmpdir(), 'reflex-proposal-native-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Proposal persistence' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nAtlas release documentation.' })).id;
  files = new JevWorkspaceFiles(root);
});
afterEach(async () => { await runtime?.shutdown(); await rm(root, { recursive: true, force: true }); });
async function record() {
  const state = await files.read(workspaceId);
  const block = await store.getCanvasBlock(canvasId, blockId);
  const document = { canvasId, block, snapshot: sourceSnapshot(workspaceId, canvasId, block) };
  const context: JevEvaluationContext = { workspaceId, documents: [document], canvases: [{ id: canvasId, name: 'Sources' }],
    tasks: [], vocabulary: [], settings: state.settings };
  const now = new Date().toISOString();
  const job: JevJob = { id: randomUUID(), request: { action: 'label', canvasId, blockIds: [blockId] }, state: 'completed',
    createdAt: now, updatedAt: now, sources: [document.snapshot], proposalIds: [] };
  state.jobs.push(job);
  recordJevCandidates(state, job, await evaluate(context), context);
  await files.write(workspaceId, state);
  return files.read(workspaceId);
}
it('upserts one semantic label across repeated decisions, reload and source revisions while retaining checked Undo', async () => {
  const first = await record(); const original = first.proposals[0];
  const second = await record();
  expect(second.proposals.filter(item => item.state === 'pending')).toHaveLength(1);
  expect(second.proposals[0].id).toBe(original.id);
  files = new JevWorkspaceFiles(root);
  expect((await record()).proposals.filter(item => item.state === 'pending')).toHaveLength(1);
  await store.updateBlock(canvasId, blockId, { title: 'Atlas revised' });
  const revised = await record();
  expect(revised.proposals.find(item => item.id === original.id)?.state).toBe('stale');
  const pending = revised.proposals.find(item => item.state === 'pending')!;
  const executor = new JevProposalExecutor(store, files);
  const receipt = await files.serial(workspaceId, () => executor.applyInside(workspaceId, pending.id, owner));
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).tags).toEqual(['Atlas']);
  await files.serial(workspaceId, () => executor.undoInside(workspaceId, receipt.id, owner));
  expect((await store.getCanvasBlock(canvasId, blockId)).tags ?? []).toEqual([]);
});
it('keeps a suppressed semantic label suppressed across repeated decisions without a canonical write', async () => {
  const first = await record(); const pending = first.proposals[0];
  pending.state = 'suppressed'; first.suppressions.push(proposalKey(pending)); await files.write(workspaceId, first);
  const repeated = await record();
  expect(repeated.proposals).toHaveLength(1); expect(repeated.proposals[0].state).toBe('suppressed');
  expect((await store.getCanvasBlock(canvasId, blockId)).tags ?? []).toEqual([]);
});

it('refuses saved task proposals, revisions, and receipt Undo after Tasks removal', async () => {
  runtime = new JevRuntime(store, { startTimer: false });
  await runtime.idle();
  await expect(runtime.apply(workspaceId, 'missing-proposal', owner)).rejects.toMatchObject({ status: 404 });
  const state = await files.read(workspaceId);
  const mutations: JevMutation[] = [
    { kind: 'task_create', canvasId, task: { title: 'Old work', detail: 'Retired proposal' } },
    { kind: 'task_update', canvasId, taskId: 'old-task', expectedUpdatedAt: '2026-10-01', patch: { status: 'done' } },
    { kind: 'task_delete', canvasId, taskId: 'old-task', expectedUpdatedAt: '2026-10-01' },
  ];
  for (const [index, mutation] of mutations.entries()) {
    state.proposals.push({ id: `old-task-proposal-${index}`, jobId: 'historical-job', action: 'label',
      title: 'Old task change', explanation: 'Saved before Tasks removal', evidence: [], sources: [],
      mutation, state: 'pending', createdAt: '2026-10-01T00:00:00Z' } as JevProposal);
  }
  state.proposals.push({ id: 'retired-action-proposal', jobId: 'historical-job', action: 'assign_owner',
    title: 'Old task assignment', explanation: 'Saved before Tasks removal', evidence: [], sources: [],
    mutation: mutations[1], state: 'pending', createdAt: '2026-10-01T00:00:00Z' } as JevProposal);
  state.receipts.push({ id: 'old-task-receipt', proposalId: 'old-task-applied', action: 'label', actor: 'owner',
    createdAt: '2026-10-01T00:00:00Z', before: mutations[0], after: mutations[0], sourcesAfter: [], state: 'applied' } as JevReceipt);
  await files.write(workspaceId, state);
  const recovered = await files.read(workspaceId);
  expect(recovered.proposals.filter(proposal => proposal.state === 'pending')).toHaveLength(3);
  expect(recovered.proposals.find(proposal => proposal.id === 'retired-action-proposal')?.state).toBe('dismissed');
  for (const [index, mutation] of mutations.entries()) {
    await expect(runtime.revise(workspaceId, `old-task-proposal-${index}`, mutation, owner))
      .rejects.toMatchObject({ status: 410, message: 'Tasks are no longer available' });
    await expect(runtime.apply(workspaceId, `old-task-proposal-${index}`, owner))
      .rejects.toMatchObject({ status: 410, message: 'Tasks are no longer available' });
  }
  await expect(runtime.undo(workspaceId, 'old-task-receipt', owner))
    .rejects.toMatchObject({ status: 410, message: 'Tasks are no longer available' });
  expect(await store.listTasks(canvasId)).toEqual([]);
  expect((await files.read(workspaceId)).proposals.filter(proposal => proposal.state === 'pending')).toHaveLength(3);
});
it('returns the completed idempotent label job after restart without a second inference or duplicate writes', async () => {
  const request = { action: 'label' as const, canvasId, blockIds: [blockId], idempotencyKey: 'label-atlas-once' };
  runtime = new JevRuntime(store, { evaluate, startTimer: false });
  const first = await runtime.run(workspaceId, request, owner); await runtime.idle();
  await runtime.shutdown(); runtime = new JevRuntime(new CanvasStore(root), { evaluate, startTimer: false });
  expect((await runtime.run(workspaceId, request, owner)).id).toBe(first.id); await runtime.idle();
  expect(calls).toBe(1);
  expect((await runtime.read(workspaceId, owner)).receipts).toHaveLength(1);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).tags).toEqual(['Atlas']);
});

it.each([undefined, 0.91])('stamps the workspace profile cutoff %s on custom derived evaluations', async cutoff => {
  const state = await files.read(workspaceId);
  state.settings.confidenceThresholds = cutoff === undefined ? undefined : { profile: cutoff };
  const block = await store.getCanvasBlock(canvasId, blockId);
  const document = { canvasId, block, snapshot: sourceSnapshot(workspaceId, canvasId, block) };
  const context: JevEvaluationContext = { workspaceId, documents: [document], canvases: [{ id: canvasId, name: 'Sources' }],
    tasks: [], vocabulary: [], settings: state.settings };
  const now = new Date().toISOString();
  const job: JevJob = { id: randomUUID(), request: { action: 'profile', canvasId, blockIds: [blockId] }, state: 'completed',
    createdAt: now, updatedAt: now, sources: [document.snapshot], proposalIds: [] };
  const result: JevEvaluation = { result: {}, proposals: [{ action: 'profile', title: 'Checked profile', explanation: 'Derived source facts',
    evidence: [], sources: [document.snapshot], mutation: { kind: 'derived', blockId, values: { role: 'unknown', profileConfidenceThreshold: -1 } } }] };
  recordJevCandidates(state, job, result, context);
  const mutation = state.proposals[0].mutation;
  expect(mutation.kind === 'derived' && mutation.values).toMatchObject({ role: 'unknown', profileConfidenceThreshold: cutoff ?? 0.7, profileEvaluationId: job.id,
    scopedCanvasIds: [canvasId], scopedSources: [document.snapshot] });
});
