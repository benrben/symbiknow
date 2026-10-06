import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import type { JevArtifact, JevCanonicalPreparation } from '../storage-jev-executor.js';
import { automationPrincipal } from './authorization.js';
import { JevProposalExecutor, type PreparedJevMutation, type StoredJevReceipt } from './proposals.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'native-owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const content = '# Atlas API\r\n\r\nKeep the exact source bytes: café & <code>/api</code>.\r\n';
let root: string; let store: CanvasStore; let files: JevWorkspaceFiles;
let workspaceId: string; let canvasId: string; let block: CanvasBlock; let unrelated: CanvasBlock;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-artifact-codec-native-'));
  store = new CanvasStore(root); await store.init(); files = new JevWorkspaceFiles(root);
  workspaceId = (await store.createWorkspace({ name: 'Native artifact proof' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'API sources' })).id;
  block = await store.createBlock(canvasId, { title: 'Atlas API', content, x: 91, y: 147 });
  block = await store.updateBlock(canvasId, block.id, { tags: ['manual reference'] }, 'Browser');
  unrelated = await store.createBlock(canvasId, { title: 'Unrelated operations', content: '# Operations\nKeep this independent source.', x: 630, y: 220 });
  unrelated = await store.getCanvasBlock(canvasId, unrelated.id);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function pendingFiling(): Promise<JevProposal> {
  const source = sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, block.id));
  const proposal: JevProposal = { id: randomUUID(), jobId: 'automatic-native-filing', action: 'file',
    title: 'File the Atlas API source', explanation: 'The source describes the Atlas API.', confidence: 0.99,
    state: 'pending', createdAt: new Date().toISOString(), sources: [source],
    evidence: [{ source, start: 0, end: 11, quote: '# Atlas API' }],
    mutation: { kind: 'document', canvasId, blockId: block.id, patch: { group: 'custom:atlas-api' } } };
  const state = await files.read(workspaceId); state.proposals.push(proposal); await files.write(workspaceId, state);
  return proposal;
}

function canvasArtifact(artifacts: JevArtifact[]): Extract<JevArtifact, { kind: 'canvas' }> {
  const artifact = artifacts.find((item): item is Extract<JevArtifact, { kind: 'canvas' }> => item.kind === 'canvas');
  if (!artifact) throw new Error('The real metadata mutation must prepare its native canvas proof');
  return artifact;
}

async function automaticFiling(): Promise<StoredJevReceipt> {
  const proposal = await pendingFiling(); const executor = new JevProposalExecutor(store, files);
  return files.serial(workspaceId, () => executor.applyInside(workspaceId, proposal.id, automationPrincipal, true));
}

async function sourceBytes(): Promise<Buffer[]> {
  return Promise.all([block, unrelated].map(document => readFile(path.join(root, document.file))));
}

async function assertEncodedProof(location: 'receipts' | 'prepared') {
  const encoded = JSON.parse(await readFile(files.file(workspaceId), 'utf8'));
  expect(encoded).toMatchObject({ codec: 'jev-source-vectors', version: 2 });
  const artifactField = location === 'receipts' ? 'preparedArtifacts' : 'artifacts';
  const proof = encoded.state[location][0][artifactField][0];
  expect(proof).toMatchObject({ kind: 'canvas', id: canvasId, before: { blocks: [] }, after: { blocks: [] } });
  expect(encoded.blockReferences.map((reference: { path: Array<string | number> }) => reference.path)).toEqual([
    [location, 0, artifactField, 0, 'before', 'blocks'], [location, 0, artifactField, 0, 'after', 'blocks'],
  ]);
  expect(encoded.blocks.filter((document: { id: string }) => document.id === unrelated.id)).toHaveLength(1);
  expect(encoded.blocks.filter((document: { id: string }) => document.id === block.id)).toHaveLength(2);
  expect(encoded.blockVectors).toHaveLength(2);
  expect(encoded.sources).toHaveLength(location === 'receipts' ? 2 : 1);
  expect((await stat(files.file(workspaceId))).mode & 0o777).toBe(0o600);
}

it('roundtrips an automatic native metadata receipt and keeps exact source bytes and a later manual position through checked Undo', async () => {
  const bytes = await sourceBytes(); const committed = await automaticFiling();
  const artifact = canvasArtifact(committed.preparedArtifacts!);
  expect(committed).toMatchObject({ automatic: true, actor: automationPrincipal.id, state: 'applied' });
  expect(artifact.before.blocks.find(document => document.id === block.id)).toMatchObject({ tags: ['manual reference'], x: 91, y: 147 });
  expect(artifact.after.blocks.find(document => document.id === block.id)).toMatchObject({ group: 'custom:atlas-api', jevMutationId: committed.id });
  await assertEncodedProof('receipts');

  const restarted = new CanvasStore(root); const restoredFiles = new JevWorkspaceFiles(root);
  const restored = await restoredFiles.read(workspaceId);
  expect(restored.receipts[0]).toEqual(JSON.parse(JSON.stringify(committed)));
  const progress = await restoredFiles.readProgress(workspaceId);
  expect(JSON.stringify(progress)).not.toContain('preparedArtifacts');
  const moved = await restarted.updateBlock(canvasId, block.id, { x: 404, y: 505 }, 'Browser');
  const undo = await restoredFiles.serial(workspaceId, () => new JevProposalExecutor(restarted, restoredFiles).undoInside(workspaceId, committed.id, owner));
  const readback = await new CanvasStore(root).getCanvasBlock(canvasId, block.id);
  expect(readback.group).toBeUndefined();
  expect(readback).toMatchObject({ content, tags: ['manual reference'], x: 404, y: 505,
    incarnation: block.incarnation, sourceGeneration: block.sourceGeneration, contentHash: block.contentHash });
  expect(readback.metadataRevision).toBeGreaterThan(moved.metadataRevision!);
  expect(readback.jevOwnership?.pins).toContain('tags');
  expect(readback.jevOwnership?.pins).not.toContain('group');
  expect(await new CanvasStore(root).getCanvasBlock(canvasId, unrelated.id)).toEqual(unrelated);
  expect(await sourceBytes()).toEqual(bytes);
  expect(undo).toMatchObject({ automatic: false, actor: owner.id, state: 'applied' });
  expect((await restoredFiles.read(workspaceId)).receipts.find(receipt => receipt.id === committed.id)?.state).toBe('undone');
});

it('restores independent native proof values on first access and persists later nested edits without changing the canvas or source bytes', async () => {
  const bytes = await sourceBytes(); const committed = await automaticFiling();
  const currentCanvas = await readFile(path.join(root, 'canvases', `${canvasId}.json`), 'utf8');
  const restoredFiles = new JevWorkspaceFiles(root); const state = await restoredFiles.read(workspaceId);
  const proof = canvasArtifact((state.receipts[0] as StoredJevReceipt).preparedArtifacts!);
  expect(Object.getOwnPropertyDescriptor(proof.before, 'blocks')).toMatchObject({ get: expect.any(Function), enumerable: true });
  const before = proof.before.blocks; const after = proof.after.blocks;
  expect(before).toEqual(canvasArtifact(committed.preparedArtifacts!).before.blocks);
  expect(after).toEqual(canvasArtifact(committed.preparedArtifacts!).after.blocks);
  expect(proof.before.blocks).toBe(before); expect(proof.after.blocks).toBe(after); expect(before).not.toBe(after);
  const beforeOther = before.find(document => document.id === unrelated.id)!;
  const afterOther = after.find(document => document.id === unrelated.id)!;
  expect(beforeOther).toEqual(afterOther); expect(beforeOther).not.toBe(afterOther);
  expect(beforeOther.jevOwnership).not.toBe(afterOther.jevOwnership);
  expect(beforeOther.jevOwnership!.removedLabels).not.toBe(afterOther.jevOwnership!.removedLabels);
  beforeOther.links.push(block.id); beforeOther.jevOwnership!.removedLabels.push('previous category');
  expect(afterOther.links).toEqual([]); expect(afterOther.jevOwnership!.removedLabels).toEqual([]);
  const expectedBefore = JSON.stringify(proof.before); const expectedAfter = JSON.stringify(proof.after);
  await restoredFiles.write(workspaceId, state);
  const readback = await new JevWorkspaceFiles(root).read(workspaceId);
  const persisted = canvasArtifact((readback.receipts[0] as StoredJevReceipt).preparedArtifacts!);
  expect(JSON.stringify(persisted.before)).toBe(expectedBefore); expect(JSON.stringify(persisted.after)).toBe(expectedAfter);
  expect(await readFile(path.join(root, 'canvases', `${canvasId}.json`), 'utf8')).toBe(currentCanvas);
  expect(await sourceBytes()).toEqual(bytes);
});

it('persists a direct native proof blocks replacement while preserving the independent unread after proof', async () => {
  const bytes = await sourceBytes(); const committed = await automaticFiling();
  const original = canvasArtifact(committed.preparedArtifacts!);
  const restoredFiles = new JevWorkspaceFiles(root); const state = await restoredFiles.read(workspaceId);
  const proof = canvasArtifact((state.receipts[0] as StoredJevReceipt).preparedArtifacts!);
  expect(Object.getOwnPropertyDescriptor(proof.before, 'blocks')).toMatchObject({ get: expect.any(Function), enumerable: true });
  const replacement = structuredClone(original.before.blocks).reverse();
  replacement.find(document => document.id === unrelated.id)!.links = [block.id];
  proof.before.blocks = replacement;
  expect(proof.before.blocks).toBe(replacement);
  await restoredFiles.write(workspaceId, state);
  const readback = await new JevWorkspaceFiles(root).read(workspaceId);
  const persisted = canvasArtifact((readback.receipts[0] as StoredJevReceipt).preparedArtifacts!);
  expect(persisted.before.blocks).toEqual(replacement); expect(persisted.after).toEqual(original.after);
  expect(persisted.after.blocks.find(document => document.id === unrelated.id)!.links).toEqual([]);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, block.id))).toMatchObject({ content, x: 91, y: 147, group: 'custom:atlas-api' });
  expect(await sourceBytes()).toEqual(bytes);
});

it.each(['before', 'after'] as const)('restores exact pooled prepared artifacts after restart when the native canvas is at its %s proof', async boundary => {
  const bytes = await sourceBytes(); const proposal = await pendingFiling(); const mutationId = randomUUID();
  let plan: JevCanonicalPreparation | undefined;
  await expect(store.jevExecutor.execute(proposal.mutation, proposal.sources, mutationId, automationPrincipal.id, true, async prepared => {
    plan = structuredClone(prepared);
    const state = await files.read(workspaceId);
    state.prepared.push({ id: mutationId, proposal, before: prepared.before, after: prepared.after, actor: automationPrincipal.id,
      automatic: true, artifacts: prepared.artifacts, ownershipBefore: prepared.ownershipBefore } as PreparedJevMutation);
    await files.write(workspaceId, state);
    if (boundary === 'after') await writeFile(path.join(root, 'canvases', `${canvasId}.json`), JSON.stringify(canvasArtifact(prepared.artifacts).after, null, 2));
    throw new Error('Stopped after durable preparation');
  })).rejects.toThrow('Stopped after durable preparation');
  await assertEncodedProof('prepared');
  const restoredFiles = new JevWorkspaceFiles(root); const prepared = (await restoredFiles.read(workspaceId)).prepared[0] as PreparedJevMutation;
  expect(prepared.artifacts).toEqual(plan!.artifacts);
  expect(prepared.before).toEqual(plan!.before); expect(prepared.after).toEqual(plan!.after);
  const artifact = canvasArtifact(plan!.artifacts);
  expect(JSON.parse(await readFile(path.join(root, 'canvases', `${canvasId}.json`), 'utf8'))).toEqual(artifact[boundary]);

  const restarted = new CanvasStore(root); const executor = new JevProposalExecutor(restarted, restoredFiles);
  await restoredFiles.serial(workspaceId, () => executor.recoverInside(workspaceId));
  await restoredFiles.serial(workspaceId, () => executor.recoverInside(workspaceId));
  expect(await readFile(path.join(root, 'canvases', `${canvasId}.json`), 'utf8')).toBe(JSON.stringify(artifact.after, null, 2));
  const recovered = await restoredFiles.read(workspaceId);
  expect(recovered.prepared).toEqual([]); expect(recovered.receipts).toHaveLength(1);
  expect(recovered.receipts[0]).toMatchObject({ id: mutationId, proposalId: proposal.id, automatic: true, actor: automationPrincipal.id, state: 'applied' });
  expect((recovered.receipts[0] as StoredJevReceipt).preparedArtifacts).toEqual(plan!.artifacts);
  expect(recovered.proposals.find(item => item.id === proposal.id)).toMatchObject({ state: 'applied', receiptId: mutationId });
  expect(await new CanvasStore(root).getCanvasBlock(canvasId, block.id)).toMatchObject({ content, tags: ['manual reference'], x: 91, y: 147, group: 'custom:atlas-api' });
  expect(await sourceBytes()).toEqual(bytes);
  await restoredFiles.serial(workspaceId, () => executor.undoInside(workspaceId, mutationId, owner));
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, block.id)).group).toBeUndefined();
  expect(await sourceBytes()).toEqual(bytes);
});
