import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevMutation, JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { evaluationContext } from './context.js';
import { eligibleAutomatic, automaticHoldReason } from './eligibility.js';
import { sourceSnapshot } from './stamps.js';
import { emptyJevWorkspace } from './workspace.js';

let root: string; let store: CanvasStore; let workspaceId: string; let sourceId: string; let targetId: string;
let preparationNumber = 0;
const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-native-move-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Move contracts' })).id;
  sourceId = (await store.createCanvas(workspaceId, { name: 'Source' })).id;
  targetId = (await store.createCanvas(workspaceId, { name: 'Destination' })).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function execute(mutation: JevMutation, id: string) {
  return store.jevExecutor.execute(mutation, [], id, 'Symbi Reflex', true,
    async prepared => { await writeFile(path.join(root, `preparation-${preparationNumber++}.json`), JSON.stringify(prepared)); });
}

it('treats typed links as the same managed field and retains an explicit relation pin', async () => {
  const from = await store.createBlock(sourceId, { title: 'Specification', content: '# Specification\nImplementation follows this contract.' });
  const to = await store.createBlock(sourceId, { title: 'Implementation', content: '# Implementation' });
  const state = emptyJevWorkspace(); state.settings.externalProcessing = true; state.settings.modes.link = 'auto';
  const request = { action: 'link' as const, canvasId: sourceId, blockIds: [from.id] };
  let context = await evaluationContext(store, workspaceId, state, request, owner, new AbortController().signal);
  const source = context.documents.find(item => item.block.id === from.id)!.snapshot;
  const proposal: JevProposal = { id: 'checked-link', jobId: 'link-job', action: 'link', title: 'Connect implementation',
    explanation: 'Exact implementation contract', state: 'pending', createdAt: new Date().toISOString(), confidence: 0.99,
    sources: [source], evidence: [{ source, start: 0, end: 15, quote: '# Specification' }],
    mutation: { kind: 'document', canvasId: sourceId, blockId: from.id, patch: { links: [to.id], linkTypes: { [to.id]: 'implements' } } } };
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
  await execute(proposal.mutation, 'typed-link');
  expect((await new CanvasStore(root).getCanvasBlock(sourceId, from.id)).linkTypes).toEqual({ [to.id]: 'implements' });
  await store.updateBlock(sourceId, from.id, { linkTypes: { [to.id]: 'prerequisite' } });
  context = await evaluationContext(store, workspaceId, state, request, owner, new AbortController().signal);
  expect(automaticHoldReason(state, proposal, context)).toBe('A field is pinned or managed manually');
});

it('retargets durable removed-edge corrections and managed references when their document moves', async () => {
  const moved = await store.createBlock(sourceId, { title: 'Moved specification', content: '# Specification' });
  const sourcePeer = await store.createBlock(sourceId, { title: 'Source peer', content: '# Source peer' });
  const targetPeer = await store.createBlock(targetId, { title: 'Target peer', content: '# Target peer' });
  const thirdId = (await store.createCanvas(workspaceId, { name: 'Third' })).id;
  const thirdPeer = await store.createBlock(thirdId, { title: 'Third peer', content: '# Third peer' });
  await store.updateBlock(sourceId, moved.id, { links: [sourcePeer.id], crossLinks: [{ canvasId: targetId, blockId: targetPeer.id }] });
  await store.updateBlock(sourceId, moved.id, { links: [], crossLinks: [] });
  await execute({ kind: 'document', canvasId: sourceId, blockId: sourcePeer.id, patch: { links: [moved.id] } }, 'managed-edge');
  await store.updateBlock(sourceId, sourcePeer.id, { links: [] });
  await execute({ kind: 'document', canvasId: sourceId, blockId: sourcePeer.id, patch: {} }, 'preserved-marker');
  for (const [canvasId, peer] of [[targetId, targetPeer], [thirdId, thirdPeer]] as const) {
    await store.updateBlock(canvasId, peer.id, { crossLinks: [{ canvasId: sourceId, blockId: moved.id }] });
    await store.updateBlock(canvasId, peer.id, { crossLinks: [] });
  }
  const before = await store.getCanvasBlock(sourceId, moved.id);
  const peerBefore = await store.getCanvasBlock(sourceId, sourcePeer.id);
  await store.moveBlockToCanvas(sourceId, moved.id, targetId);
  const restarted = new CanvasStore(root);
  const saved = await restarted.getCanvasBlock(targetId, moved.id);
  expect(saved.jevOwnership?.removedLinks).toEqual([`${sourceId}:${sourcePeer.id}`, targetPeer.id]);
  expect(saved.jevOwnership?.pins).toEqual(before.jevOwnership?.pins);
  expect(saved.sourceGeneration).toBe(before.sourceGeneration);
  expect(saved.metadataRevision).toBe(before.metadataRevision! + 1);
  expect(saved.content).toBe(before.content);
  const peer = await restarted.getCanvasBlock(sourceId, sourcePeer.id);
  expect(peer.jevOwnership?.removedLinks).toEqual([`${targetId}:${moved.id}`]);
  expect(peer.jevOwnership?.managed).toContain(`link:${targetId}:${moved.id}`);
  expect(peer.jevMutationId).toBe('preserved-marker');
  expect(peer.metadataRevision).toBe(peerBefore.metadataRevision! + 1);
  expect((await restarted.getCanvasBlock(targetId, targetPeer.id)).jevOwnership?.removedLinks).toEqual([moved.id]);
  expect((await restarted.getCanvasBlock(thirdId, thirdPeer.id)).jevOwnership?.removedLinks).toEqual([`${targetId}:${moved.id}`]);
});

it('moves an unstamped legacy document and initializes its canonical source identity', async () => {
  const source = await store.createBlock(sourceId, { title: 'Legacy source', content: '# Legacy source' });
  const file = path.join(root, 'canvases', `${sourceId}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  for (const field of ['incarnation', 'sourceGeneration', 'metadataRevision', 'jevOwnership']) delete saved.blocks[0][field];
  await writeFile(file, JSON.stringify(saved));
  await store.moveBlockToCanvas(sourceId, source.id, targetId);
  const moved = await new CanvasStore(root).getCanvasBlock(targetId, source.id);
  expect(moved.incarnation).toBeTruthy(); expect(moved.sourceGeneration).toBe(1);
  expect(sourceSnapshot(workspaceId, targetId, moved).canvasId).toBe(targetId);
  expect(moved.jevOwnership?.managed).toContain('links'); expect(moved.content).toBe(source.content);
});
