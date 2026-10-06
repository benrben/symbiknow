import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasTask } from '../../shared/types.js';
import type { JevMutation, JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import type { JevArtifact, JevCanonicalPreparation } from '../storage-jev-executor.js';
import { JevProposalExecutor, type PreparedJevMutation, type StoredJevReceipt } from './proposals.js';
import { checkReceiptInverse, inverseSources } from './proposal-inverse.js';
import { JevRuntime } from './runtime.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'reviewer', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let files: JevWorkspaceFiles;
let workspaceId: string; let canvasId: string; let targetId: string; let blockId: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-move-undo-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Checked move review' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Research' })).id;
  targetId = (await store.createCanvas(workspaceId, { name: 'Delivery' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Release work', content: '# Release\nKeep the exact source bytes.' })).id;
  runtime = new JevRuntime(store, { startTimer: false }); await runtime.idle(); files = new JevWorkspaceFiles(root);
});
afterEach(async () => { runtime.close(); await runtime.idle(); await rm(root, { recursive: true, force: true }); });

async function proposal(mutation: JevMutation): Promise<JevProposal> {
  const canvas = await store.getCanvas(mutation.kind === 'move' ? mutation.canvasId : canvasId, true);
  const source = sourceSnapshot(workspaceId, canvas.id, canvas.blocks.find(block => block.id === blockId)!);
  const pending: JevProposal = { id: randomUUID(), jobId: 'reviewed-move', action: 'suggest_home_canvas',
    title: 'Move release work to Delivery', explanation: 'Delivery owns the release work.', state: 'pending',
    createdAt: new Date().toISOString(), evidence: [{ source, start: 0, end: 9, quote: '# Release' }], sources: [source], mutation };
  const state = await files.read(workspaceId); state.proposals.push(pending); await files.write(workspaceId, state); return pending;
}
async function move(): Promise<StoredJevReceipt> {
  const pending = await proposal({ kind: 'move', canvasId, targetCanvasId: targetId, blockId });
  const receipt = await runtime.apply(workspaceId, pending.id, owner);
  return (await files.read(workspaceId)).receipts.find(item => item.id === receipt.id) as StoredJevReceipt;
}
function logicalTask(task: CanvasTask) {
  return Object.fromEntries(Object.entries(task).filter(([field]) => !['updatedAt', 'updatedBy', 'revision', 'jevMutationId'].includes(field)));
}
async function boards() {
  return Promise.all([canvasId, targetId].map(id => readFile(path.join(root, 'tasks', `${id}.json`), 'utf8')));
}
async function canonicalInverse(receipt: StoredJevReceipt, artifacts: JevArtifact[] | undefined = receipt.preparedArtifacts,
  prepare: (value: JevCanonicalPreparation) => Promise<void> = async value => {
    await writeFile(path.join(root, 'inverse.json'), JSON.stringify(value));
  }) {
  return store.jevExecutor.execute(receipt.before, await inverseSources(store, workspaceId, receipt), 'checked-inverse', owner.id, false,
    prepare, undefined, true, artifacts);
}

it('restores original work identities, comments and attachments after reload, preserving unrelated board edits', async () => {
  const prerequisite = await store.createTask(canvasId, { title: 'Prepare release', blockIds: [] }, 'author');
  const original = await store.createTask(canvasId, { title: 'Ship release', detail: 'Publish after review.', blockIds: [blockId],
    status: 'in_progress', assignee: 'developer', reviewer: 'reviewer', priority: 'high', dueDate: '2026-10-04',
    dependsOnTaskIds: [prerequisite.id], acceptanceCriteria: [{ id: 'release-evidence', text: 'Release notes checked' }] }, 'author');
  await store.commentTask(canvasId, original.id, 'Keep this review history.', 'author');
  const before = (await store.listTasks(canvasId)).find(task => task.id === original.id)!;
  const receipt = await move(); const detached = (await store.listTasks(canvasId)).find(task => task.id === original.id)!;
  const movedBoards = await boards();
  expect((await runtime.apply(workspaceId, receipt.proposalId, owner)).id).toBe(receipt.id);
  expect(await boards()).toEqual(movedBoards);
  const copied = (await store.listTasks(targetId))[0]; expect(copied.id).not.toBe(original.id);
  const changedPrerequisite = await store.updateTask(canvasId, prerequisite.id, { status: 'done' }, 'author');
  const unrelated = await store.createTask(targetId, { title: 'Other delivery', blockIds: [] }, 'author');
  await runtime.undo(workspaceId, receipt.id, owner);
  const reloaded = new CanvasStore(root); const restored = (await reloaded.listTasks(canvasId)).find(task => task.id === original.id)!;
  expect(logicalTask(restored)).toEqual(logicalTask(before));
  expect(restored.revision).toBe(detached.revision! + 1); expect(Date.parse(restored.updatedAt)).toBeGreaterThan(Date.parse(detached.updatedAt));
  expect(restored.jevMutationId).toBeTruthy(); expect(restored.updatedBy).toBe(owner.id);
  expect((await reloaded.listTasks(canvasId)).find(task => task.id === prerequisite.id)).toEqual(changedPrerequisite);
  expect(await reloaded.listTasks(targetId)).toEqual([unrelated]);
  expect((await reloaded.getCanvasBlock(canvasId, blockId)).content).toBe('# Release\nKeep the exact source bytes.');
  expect((await files.read(workspaceId)).receipts.find(item => item.id === receipt.id)?.state).toBe('undone');
});

it.each(['original', 'copy'] as const)('refuses a later revision of the %s task before the move or either board changes', async which => {
  const task = await store.createTask(canvasId, { title: 'Release review', blockIds: [blockId] }, owner.id);
  const receipt = await move(); const id = which === 'original' ? task.id : (await store.listTasks(targetId))[0].id;
  const changedCanvas = which === 'original' ? canvasId : targetId;
  await store.commentTask(changedCanvas, id, 'A human corrected this work.', 'author');
  const savedBoards = await boards(); const saved = await store.getCanvasBlock(targetId, blockId);
  await expect(runtime.undo(workspaceId, receipt.id, owner)).rejects.toMatchObject({ status: 409, message: 'Work changed after this action; Undo is unavailable' });
  expect(await boards()).toEqual(savedBoards); expect(await store.getCanvasBlock(targetId, blockId)).toEqual(saved);
  expect((await files.read(workspaceId)).receipts.find(item => item.id === receipt.id)?.state).toBe('applied');
});

it('refuses Undo when later work depends on the generated destination copy', async () => {
  await store.createTask(canvasId, { title: 'Release review', blockIds: [blockId] }, owner.id);
  const receipt = await move(); const copy = (await store.listTasks(targetId))[0];
  await store.createTask(targetId, { title: 'Publish after release review', dependsOnTaskIds: [copy.id] }, 'author');
  const saved = await boards();
  await expect(runtime.undo(workspaceId, receipt.id, owner)).rejects.toMatchObject({ status: 409, message: 'Other work now depends on a moved task; Undo is unavailable' });
  expect(await boards()).toEqual(saved); expect((await store.getCanvasBlock(targetId, blockId)).content).toContain('exact source bytes');
});

it('rechecks moved task revisions inside the serialized canonical inverse after an earlier preflight', async () => {
  await store.createTask(canvasId, { title: 'Release review', blockIds: [blockId] }, owner.id);
  const receipt = await move(); await checkReceiptInverse(store, receipt);
  const copy = (await store.listTasks(targetId))[0]; await store.updateTask(targetId, copy.id, { status: 'done' }, 'author');
  const saved = await boards();
  await expect(canonicalInverse(receipt)).rejects.toMatchObject({ status: 409 });
  expect(await boards()).toEqual(saved); await expect(readFile(path.join(root, 'inverse.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await store.getCanvasBlock(targetId, blockId)).content).toContain('exact source bytes');
});

it('refuses incomplete historical move work journals instead of inventing new copied identities', async () => {
  await store.createTask(canvasId, { title: 'Release review', blockIds: [blockId] }, owner.id);
  const receipt = await move(); const saved = await boards();
  await expect(canonicalInverse(receipt, [])).rejects.toMatchObject({ status: 409, message: 'Saved move work is incomplete; Undo is unavailable' });
  const legacy = { ...receipt }; delete legacy.preparedArtifacts;
  await expect(canonicalInverse(legacy)).rejects.toMatchObject({ status: 409 });
  expect(await boards()).toEqual(saved);
});

it('recovers a durably prepared inverse after a partial canonical write without duplicating restored work', async () => {
  const original = await store.createTask(canvasId, { title: 'Release review', blockIds: [blockId] }, owner.id);
  const receipt = await move(); const sources = await inverseSources(store, workspaceId, receipt);
  const inverse: JevProposal = { ...(await proposal(receipt.before)), sources };
  const state = await files.read(workspaceId); state.proposals.find(item => item.id === inverse.id)!.sources = sources; await files.write(workspaceId, state);
  await expect(canonicalInverse(receipt, receipt.preparedArtifacts, async plan => {
    const saved = await files.read(workspaceId);
    saved.prepared.push({ id: 'checked-inverse', proposal: inverse, before: plan.before, after: plan.after, actor: owner.id,
      automatic: false, artifacts: plan.artifacts, undoReceiptId: receipt.id } as PreparedJevMutation);
    await files.write(workspaceId, saved);
    const source = plan.artifacts.find(item => item.kind === 'tasks' && item.id === canvasId)!;
    await writeFile(path.join(root, 'tasks', `${canvasId}.json`), JSON.stringify(source.after));
    throw new Error('The process stopped after its first canonical artifact write');
  })).rejects.toThrow('The process stopped');
  const executor = new JevProposalExecutor(new CanvasStore(root), files); await executor.recoverInside(workspaceId); await executor.recoverInside(workspaceId);
  expect((await new CanvasStore(root).listTasks(canvasId)).map(task => [task.id, task.blockIds])).toEqual([[original.id, [blockId]]]);
  expect(await new CanvasStore(root).listTasks(targetId)).toEqual([]);
  const recovered = await files.read(workspaceId); expect(recovered.prepared).toEqual([]);
  expect(recovered.receipts.filter(item => item.id === 'checked-inverse')).toHaveLength(1);
  expect(recovered.receipts.find(item => item.id === receipt.id)?.state).toBe('undone');
});

it('can check and reverse its own inverse without rewinding a regenerated task clock', async () => {
  await store.createTask(canvasId, { title: 'Release review', blockIds: [blockId] }, owner.id);
  const receipt = await move(); const copy = (await store.listTasks(targetId))[0];
  const inverse = await runtime.undo(workspaceId, receipt.id, owner);
  await runtime.undo(workspaceId, inverse.id, owner);
  const restoredCopy = (await store.listTasks(targetId))[0]; expect(restoredCopy.id).toBe(copy.id);
  expect(logicalTask(restoredCopy)).toEqual(logicalTask(copy)); expect(restoredCopy.revision).toBe(copy.revision! + 1);
  expect((await store.getCanvasBlock(targetId, blockId)).content).toContain('exact source bytes');
});

it('advances a historical attached task without a revision counter when its checked journal matches', async () => {
  const task = await store.createTask(canvasId, { title: 'Release review', blockIds: [blockId] }, owner.id);
  const receipt = await move();
  const artifact = receipt.preparedArtifacts!.find((item): item is Extract<JevArtifact, { kind: 'tasks' }> => item.kind === 'tasks' && item.id === canvasId)!;
  delete artifact.after.find(item => item.id === task.id)!.revision;
  await writeFile(path.join(root, 'tasks', `${canvasId}.json`), JSON.stringify(artifact.after));
  await canonicalInverse(receipt);
  expect((await new CanvasStore(root).listTasks(canvasId))[0]).toMatchObject({ id: task.id, revision: 1, blockIds: [blockId], jevMutationId: 'checked-inverse' });
});

it('refuses to regenerate a checked copy when intervening unrelated work has filled the destination board', async () => {
  await store.createTask(canvasId, { title: 'Release review', blockIds: [blockId] }, owner.id);
  const receipt = await move(); const inverse = await runtime.undo(workspaceId, receipt.id, owner);
  const unrelated = await store.createTask(targetId, { title: 'Unrelated delivery', blockIds: [] }, 'author');
  const full = Array.from({ length: 500 }, () => ({ ...unrelated, id: randomUUID() }));
  await writeFile(path.join(root, 'tasks', `${targetId}.json`), JSON.stringify(full));
  const saved = await boards();
  await expect(runtime.undo(workspaceId, inverse.id, owner)).rejects.toMatchObject({ status: 409, message: 'Task board limit prevents this Undo' });
  expect(await boards()).toEqual(saved); expect((await store.getCanvasBlock(canvasId, blockId)).content).toContain('exact source bytes');
});
