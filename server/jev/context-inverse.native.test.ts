import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevActionRequest, JevMutation, JevPrincipal, JevSourceSnapshot } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { evaluationContext } from './context.js';
import { readJevDraft, stageJevDraft } from './drafts.js';
import { authorizeReceipt, checkReceiptInverse, checkReceiptState, inverseOwnership, inverseSources, versionInverse } from './proposal-inverse.js';
import type { StoredJevReceipt } from './proposals.js';
import { sourceSnapshot } from './stamps.js';
import { emptyJevWorkspace } from './workspace.js';

const owner: JevPrincipal = { id: 'reviewer', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let workspaceId: string; let canvasId: string; let blockId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-context-inverse-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Scoped review' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Documents' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Saved source', content: '# Source\nReview the source.' })).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function snapshot() { return sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, blockId)); }
async function commit(mutation: JevMutation, sources: JevSourceSnapshot[] = []): Promise<StoredJevReceipt> {
  const id = randomUUID();
  const saved = await store.jevExecutor.execute(mutation, sources, id, owner.id, true,
    async prepared => { await writeFile(path.join(root, `${id}.json`), JSON.stringify(prepared)); });
  const receipt: StoredJevReceipt = { id, proposalId: randomUUID(), action: 'profile', createdAt: new Date().toISOString(), actor: owner.id,
    before: saved.before, after: saved.after, sourcesAfter: saved.sourcesAfter, preparedArtifacts: saved.artifacts,
    ownershipBefore: saved.ownershipBefore, state: 'applied' };
  const file = path.join(root, `${id}.receipt.json`);
  await writeFile(file, JSON.stringify(receipt));
  return JSON.parse(await readFile(file, 'utf8')) as StoredJevReceipt;
}
async function context(request: Partial<JevActionRequest> = {}, principal = owner, state = emptyJevWorkspace()) {
  return evaluationContext(store, workspaceId, state, { action: 'profile', canvasId, ...request }, principal, new AbortController().signal);
}

it('refuses unavailable and explicitly excluded sources instead of broadening the context', async () => {
  await expect(evaluationContext(store, 'missing-workspace', emptyJevWorkspace(), { action: 'profile', canvasId }, owner, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  const otherWorkspace = (await store.createWorkspace({ name: 'Other workspace' })).id;
  const other = (await store.createCanvas(otherWorkspace, { name: 'Other scope' })).id;
  await expect(context({ canvasId: other })).rejects.toMatchObject({ status: 404 });
  await store.updateBlock(canvasId, blockId, { processingExcluded: true });
  await expect(context({ blockIds: [blockId] })).rejects.toMatchObject({ status: 404 });
  expect((await context()).documents).toEqual([]);
});

it('filters cross-canvas links, vocabulary members, and saved change activity through the caller scope', async () => {
  const hidden = (await store.createCanvas(workspaceId, { name: 'Private canvas' })).id;
  const hiddenBlock = await store.createBlock(hidden, { title: 'Private source', content: '# Private' });
  await store.updateBlock(canvasId, blockId, { crossLinks: [{ canvasId: hidden, blockId: hiddenBlock.id }] });
  const receipt = await commit({ kind: 'document', canvasId, blockId, patch: { headline: 'Review the source.' } }, [await snapshot()]);
  const taskReceipt = await commit({ kind: 'task_create', canvasId, task: { title: 'Review source', detail: 'Review the source.', blockIds: [blockId] } }, [await snapshot()]);
  const state = emptyJevWorkspace(); state.receipts = [receipt, taskReceipt, { ...receipt, id: 'private-change', sourcesAfter: [sourceSnapshot(workspaceId, hidden, hiddenBlock)] }];
  state.vocabulary = [{ id: 'private-topic', kind: 'group', name: 'Private topic', definition: 'Private source topic', state: 'active', version: 1, aliases: [], members: [{ canvasId: hidden, blockId: hiddenBlock.id }] }];
  const scoped = await context({}, { ...owner, allowedCanvasIds: [canvasId] }, state);
  expect(scoped.documents[0].block.crossLinks).toEqual([]);
  expect(scoped.vocabulary).toEqual([]);
  expect(scoped.activity?.map(item => item.summary)).toEqual(['Applied profile: headline', 'Applied profile']);
  expect(scoped.tasks?.map(item => item.task.title)).toEqual(['Review source']);
  await expect(context({}, { ...owner, allowedCanvasIds: [] })).rejects.toMatchObject({ status: 404 });
});

it('keeps historic and caller-provided draft bytes outside retained automatic action context', async () => {
  const input = { id: 'held-edit', baseContent: '# Source\nReview the source.', proposedContent: '# Source\nReviewed source.', instruction: 'Review the source' };
  const staged = await stageJevDraft(root, await snapshot(), input, owner.id);
  const untrusted: NonNullable<JevActionRequest['options']>[] = [{ draftId: input.id }, { draftId: 'different' }, { draft: [] },
    { draft: { ...input, instruction: 12 } }, { draft: input }];
  for (const options of untrusted) {
    const retained = await context({ action: 'file', blockIds: [blockId], options });
    expect(retained.draft).toBeUndefined();
    expect(retained.documents[0].block.content).toBe(input.baseContent);
  }
  expect(await readJevDraft(root, canvasId, blockId)).toEqual(staged);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe(input.baseContent);
});

it('rejects a later document correction, a later pin, a deleted source, and an out-of-scope receipt', async () => {
  const receipt = await commit({ kind: 'document', canvasId, blockId, patch: { headline: 'Review the source.' } }, [await snapshot()]);
  await checkReceiptInverse(store, receipt);
  await store.updateBlock(canvasId, blockId, { headline: 'Human correction' });
  await expect(checkReceiptInverse(store, receipt)).rejects.toMatchObject({ status: 409, message: 'A later correction prevents this Undo' });
  await store.updateBlock(canvasId, blockId, { headline: 'Review the source.' });
  await expect(checkReceiptInverse(store, receipt)).rejects.toMatchObject({ status: 409, message: 'A later pin prevents this Undo' });
  expect(() => authorizeReceipt(receipt, { ...owner, allowedCanvasIds: [] })).toThrowError(expect.objectContaining({ status: 404 }));
  await store.deleteBlock(canvasId, blockId);
  await expect(checkReceiptInverse(store, receipt)).rejects.toMatchObject({ status: 409, message: 'Document no longer exists' });
  await expect(inverseSources(store, workspaceId, receipt)).rejects.toMatchObject({ status: 409 });
});

it('protects task corrections and supports the inverse after an unchanged canonical task write', async () => {
  const receipt = await commit({ kind: 'task_create', canvasId, task: { title: 'Review source', detail: 'Review the source.', blockIds: [blockId] } }, [await snapshot()]);
  await checkReceiptInverse(store, receipt);
  const task = (await store.listTasks(canvasId))[0];
  const updated = await commit({ kind: 'task_update', canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt, expectedRevision: task.revision, patch: { status: 'in_progress' } });
  await expect(checkReceiptInverse(store, receipt)).rejects.toMatchObject({ status: 409 });
  await checkReceiptInverse(store, updated);
  const current = (await store.listTasks(canvasId))[0];
  const deleted = await commit({ kind: 'task_delete', canvasId, taskId: current.id, expectedUpdatedAt: current.updatedAt, expectedRevision: current.revision });
  await checkReceiptInverse(store, deleted);
  expect(await new CanvasStore(root).listTasks(canvasId)).toEqual([]);
});

it('keeps unrelated ownership corrections while restoring managed local and cross-canvas edge ownership', async () => {
  const local = await store.createBlock(canvasId, { title: 'Local', content: '# Local' });
  const other = (await store.createCanvas(workspaceId, { name: 'Related' })).id;
  const cross = await store.createBlock(other, { title: 'Related', content: '# Related' });
  await store.updateBlock(canvasId, blockId, { tags: ['original'], links: [local.id], crossLinks: [{ canvasId: other, blockId: cross.id }] });
  await store.updateBlock(canvasId, blockId, { tags: [], links: [], crossLinks: [] });
  const receipt = await commit({ kind: 'document', canvasId, blockId, patch: { tags: ['generated'], links: [local.id], crossLinks: [{ canvasId: other, blockId: cross.id }], linkTypes: { [local.id]: 'implements' } } }, [await snapshot()]);
  await store.updateBlock(canvasId, blockId, { purpose: 'Manual purpose' });
  const current = (await store.getCanvasBlock(canvasId, blockId)).jevOwnership!;
  const restored = inverseOwnership(current, receipt.ownershipBefore, receipt.after)!;
  expect(restored.pins).toContain('purpose');
  expect(restored.removedLabels).toEqual(['original']);
  expect(restored.removedLinks).toEqual([local.id, `${other}:${cross.id}`]);
  expect(inverseOwnership(undefined, receipt.ownershipBefore, receipt.after)).toEqual(receipt.ownershipBefore);
  expect(inverseOwnership(current, undefined, receipt.after)).toBeUndefined();
  expect(inverseOwnership(current, receipt.ownershipBefore, { kind: 'derived', values: {} })).toEqual(receipt.ownershipBefore);
  const purposeOnly = inverseOwnership(current, receipt.ownershipBefore, { kind: 'document', canvasId, blockId, patch: { purpose: 'Old purpose' } })!;
  expect(purposeOnly.removedLabels).toEqual(current.removedLabels);
  expect(purposeOnly.removedLinks).toEqual(current.removedLinks);
});

it('checks vocabulary version changes and paused or already-undone receipts without altering saved sources', async () => {
  const receipt = await commit({ kind: 'document', canvasId, blockId, patch: { headline: 'Review the source.' } }, [await snapshot()]);
  const state = emptyJevWorkspace();
  state.settings.paused = true;
  expect(() => checkReceiptState(state, receipt)).toThrowError(expect.objectContaining({ status: 409 }));
  state.settings.paused = false; checkReceiptState(state, { ...receipt, state: 'undone' });
  checkReceiptState(state, receipt);
  const term = { id: 'group-review', kind: 'group' as const, name: 'Review', definition: 'Reviewed sources', state: 'active' as const, version: 1, aliases: [], members: [] };
  const vocabularyReceipt = { ...receipt, after: { kind: 'vocabulary' as const, operation: 'define' as const, term } };
  expect(() => checkReceiptState(state, vocabularyReceipt)).toThrowError(expect.objectContaining({ status: 409 }));
  state.vocabulary = [term]; checkReceiptState(state, vocabularyReceipt);
  const inverse: Extract<JevMutation, { kind: 'vocabulary' }> = { kind: 'vocabulary', operation: 'restore', term };
  versionInverse(state, inverse); expect(inverse.term.version).toBe(2);
  state.vocabulary = []; versionInverse(state, inverse); expect(inverse.term.version).toBe(1);
  checkReceiptState(state, { ...vocabularyReceipt, after: { kind: 'vocabulary', operation: 'remove', term } });
  versionInverse(state, { kind: 'vocabulary', operation: 'remove', term }); versionInverse(state, receipt.before);
  expect((await inverseSources(store, workspaceId, receipt))[0].blockId).toBe(blockId);
  await store.updateBlock(canvasId, blockId, { content: '# Source changed' });
  await expect(inverseSources(store, workspaceId, receipt)).rejects.toMatchObject({ status: 409 });
});

it('reads a legacy receipt without preparation artifacts and restores absent nullable metadata', async () => {
  const receipt = await commit({ kind: 'document', canvasId, blockId, patch: { tags: null } }, [await snapshot()]);
  delete receipt.preparedArtifacts;
  const file = path.join(root, 'legacy-receipt.json'); await writeFile(file, JSON.stringify(receipt));
  await checkReceiptInverse(store, JSON.parse(await readFile(file, 'utf8')) as StoredJevReceipt);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).tags).toBeUndefined();
});

it('checks canonical move artifacts and scoped source snapshots after document work follows the move', async () => {
  const target = (await store.createCanvas(workspaceId, { name: 'Destination' })).id;
  await store.createTask(canvasId, { title: 'Review moving source', blockIds: [blockId] }, owner.id);
  const receipt = await commit({ kind: 'move', canvasId, blockId, targetCanvasId: target }, [await snapshot()]);
  await checkReceiptInverse(store, receipt);
  expect((await new CanvasStore(root).listTasks(target))[0].blockIds).toEqual([blockId]);
  expect(receipt.sourcesAfter[0].canvasId).toBe(target);
  expect((await inverseSources(store, workspaceId, receipt))[0].canvasId).toBe(target);
});

it('checks canonical empty-edge semantics while still refusing a later real connection or ownership correction', async () => {
  const related = await store.createBlock(canvasId, { title: 'Related release', content: '# Related release' });
  const destination = (await store.createCanvas(workspaceId, { name: 'Connected release' })).id;
  const cross = await store.createBlock(destination, { title: 'Cross release', content: '# Cross release' });
  await store.updateBlock(canvasId, blockId, { links: [related.id], crossLinks: [{ canvasId: destination, blockId: cross.id }] });
  await store.jevExecutor.setOwnership(canvasId, blockId, { pins: [] });
  const receipt = await commit({ kind: 'document', canvasId, blockId, patch: { links: [], linkTypes: {}, crossLinks: [] } }, [await snapshot()]);
  await checkReceiptInverse(new CanvasStore(root), receipt);
  const saved = await new CanvasStore(root).getCanvasBlock(canvasId, blockId);
  expect(saved.links).toEqual([]); expect(saved.crossLinks).toBeUndefined(); expect(saved.linkTypes).toBeUndefined();
  await store.updateBlock(canvasId, blockId, { links: [related.id] });
  await expect(checkReceiptInverse(store, receipt)).rejects.toMatchObject({ status: 409, message: 'A later correction prevents this Undo' });
  await store.updateBlock(canvasId, blockId, { links: [] });
  await expect(checkReceiptInverse(store, receipt)).rejects.toMatchObject({ status: 409, message: 'A later pin prevents this Undo' });
});
