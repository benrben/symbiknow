import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevMutation, JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { atomicJson, StorageFiles } from '../storage-files.js';
import type { StoredCanvas } from '../storage-shapes.js';
import type { StoredJevReceipt } from './proposals.js';
import { preflightCausalParentUndo, recoverParentUndos, withCausalParentUndo, type JevParentUndo } from './parent-undo.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'native-owner', kind: 'user', access: 'write', canApprove: true };
let root: string; let store: CanvasStore; let files: StorageFiles; let stateFiles: JevWorkspaceFiles;
let workspaceId: string; let canvasId: string; let source: CanvasBlock;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-parent-boundary-'));
  store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Causal Undo boundary' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Source action' })).id;
  source = await store.createBlock(canvasId, { title: 'Parent source', content: '# Original parent source' });
  source = await store.getCanvasBlock(canvasId, source.id);
  files = new StorageFiles(root, store.locks); stateFiles = new JevWorkspaceFiles(root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const directory = () => path.join(root, 'jev', 'parent-undo');
const parent = (): JevParentUndo => ({ kind: 'created', after: source });
const current = () => new CanvasStore(root).getCanvasBlock(canvasId, source.id);
async function receipt(targetCanvasId: string, blockId: string, patch: Record<string, unknown>, automatic = true): Promise<StoredJevReceipt> {
  const snapshot = sourceSnapshot(workspaceId, canvasId, await current());
  const id = randomUUID();
  const mutation: JevMutation = { kind: 'document', canvasId: targetCanvasId, blockId, patch };
  const written = await store.jevExecutor.execute(mutation, [snapshot], id, 'Symbi Reflex', automatic,
    prepared => atomicJson(path.join(root, 'prepared-receipt.json'), prepared, 0o600));
  const saved: StoredJevReceipt = { id, proposalId: randomUUID(), action: 'file', actor: 'Symbi Reflex', createdAt: new Date().toISOString(),
    state: 'applied', automatic, before: written.before, after: written.after, sourcesAfter: written.sourcesAfter,
    preparedArtifacts: written.artifacts, ownershipBefore: written.ownershipBefore };
  const state = await stateFiles.read(workspaceId); state.receipts.push(saved); await stateFiles.write(workspaceId, state);
  return saved;
}
async function secondary() {
  const canvas = await store.createCanvas(workspaceId, { name: 'Related source' });
  return { canvasId: canvas.id, block: await store.createBlock(canvas.id, { title: 'Related document', content: '# Related document' }) };
}
async function writeJournal(value: unknown, id = randomUUID()): Promise<string> {
  await mkdir(directory(), { recursive: true });
  const file = path.join(directory(), id + '.json'); await atomicJson(file, value, 0o600); return file;
}
async function journal() {
  const raw = await files.readJson<StoredCanvas>(files.canvasFile(canvasId));
  return { id: randomUUID(), workspaceId, canvasId, parents: [parent()], receipts: [] as string[], state: 'prepared',
    canvases: [{ id: canvasId, before: raw, after: raw }] };
}

it('refuses malformed persisted scopes, parent identities, canvas images and receipt IDs before any recovery write', async () => {
  const valid = await journal(); const raw = valid.canvases[0].before; const before = await current();
  const corrupted: unknown[] = [null, 7,
    { ...valid, id: randomUUID() }, { ...valid, workspaceId: '../escape' }, { ...valid, canvasId: '../escape' }, { ...valid, state: 'unknown' },
    { ...valid, parents: null }, { ...valid, parents: [] }, { ...valid, canvases: null }, { ...valid, receipts: null },
    { ...valid, parents: [null] }, { ...valid, parents: [{ kind: 'other', after: source }] },
    { ...valid, parents: [{ kind: 'created', after: null }] },
    { ...valid, parents: [{ kind: 'created', after: { ...source, id: '../escape' } }] },
    { ...valid, parents: [{ kind: 'created', after: { ...source, incarnation: 7 } }] },
    { ...valid, parents: [{ kind: 'created', after: { ...source, sourceGeneration: 0 } }] },
    { ...valid, parents: [{ kind: 'created', after: { ...source, sourceGeneration: 1.5 } }] },
    { ...valid, parents: [{ kind: 'created', after: { ...source, content: null } }] },
    { ...valid, parents: [{ kind: 'edited', after: source }] },
    { ...valid, parents: [{ kind: 'edited', after: source, before: { ...source, id: 'different' } }] },
    { ...valid, parents: [{ kind: 'edited', after: source, before: { ...source, content: null } }] },
    { ...valid, canvases: [null] }, { ...valid, canvases: [{ id: '../escape', before: raw, after: raw }] },
    { ...valid, canvases: [{ id: canvasId, after: raw }] },
    { ...valid, canvases: [{ id: canvasId, before: { ...raw, workspaceId: 'different' }, after: raw }] },
    { ...valid, canvases: [{ id: canvasId, before: { ...raw, blocks: null }, after: raw }] },
    { ...valid, canvases: [{ id: canvasId, before: raw, after: { ...raw, id: 'different' } }] },
    { ...valid, receipts: [7] }, { ...valid, receipts: ['not-a-receipt'] },
  ];
  for (const value of corrupted) {
    const file = await writeJournal(value, valid.id);
    await expect(recoverParentUndos(store, workspaceId)).rejects.toMatchObject({ status: 503 });
    expect(await current()).toEqual(before); expect(await readFile(file, 'utf8')).toBeTruthy();
    await rm(file);
  }
});

it('preserves filesystem recovery failures and skips journals from another actual workspace', async () => {
  await mkdir(directory(), { recursive: true });
  const badFile = path.join(directory(), randomUUID() + '.json'); await mkdir(badFile);
  await expect(recoverParentUndos(store, workspaceId)).rejects.toMatchObject({ code: 'EISDIR' });
  await rm(directory(), { recursive: true }); await writeFile(directory(), 'blocked recovery directory');
  await expect(recoverParentUndos(store, workspaceId)).rejects.toMatchObject({ code: 'ENOTDIR' });
  await rm(directory());
  const otherWorkspace = await store.createWorkspace({ name: 'Another workspace' });
  const otherCanvas = await store.createCanvas(otherWorkspace.id, { name: 'Another action' });
  const otherSource = await store.createBlock(otherCanvas.id, { title: 'Other source', content: '# Other' });
  const skipped = { id: randomUUID(), workspaceId: otherWorkspace.id, canvasId: otherCanvas.id,
    parents: [{ kind: 'created', after: otherSource }], canvases: [], receipts: [], state: 'prepared' };
  const file = await writeJournal(skipped, skipped.id);
  await recoverParentUndos(store, workspaceId);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(skipped); expect(await current()).toEqual(source);
});

it('checks the actual workspace and every causal destination before compensating any native document', async () => {
  const otherWorkspace = await store.createWorkspace({ name: 'Wrong workspace' });
  await expect(withCausalParentUndo(store, otherWorkspace.id, canvasId, [parent()], owner,
    () => store.deleteBlock(canvasId, source.id))).rejects.toMatchObject({ status: 404 });
  const related = await secondary(); await receipt(related.canvasId, related.block.id, { group: 'custom:related' });
  const before = await store.getCanvasBlock(related.canvasId, related.block.id);
  await expect(withCausalParentUndo(store, workspaceId, canvasId, [parent()], { ...owner, allowedCanvasIds: [canvasId] },
    () => store.deleteBlock(canvasId, source.id))).rejects.toMatchObject({ status: 404 });
  expect(await store.getCanvasBlock(related.canvasId, related.block.id)).toEqual(before); expect(await current()).toEqual(source);
});

it.each(['missing', 'changed-fields', 'changed-ownership', 'missing-artifacts', 'missing-after-block'] as const)
('holds causal Undo when a native descendant is %s without deleting or rewriting the source', async boundary => {
  const related = await secondary(); const saved = await receipt(related.canvasId, related.block.id, { group: 'custom:related' });
  if (boundary === 'missing') await store.deleteBlock(related.canvasId, related.block.id);
  if (boundary === 'changed-fields') await store.updateBlock(related.canvasId, related.block.id, { group: 'custom:human' }, 'Browser');
  if (boundary === 'changed-ownership') {
    const value = await store.getCanvasBlock(related.canvasId, related.block.id);
    await store.jevExecutor.setOwnership(related.canvasId, value.id, { ...value.jevOwnership!, pins: ['group'] });
  }
  if (boundary === 'missing-artifacts' || boundary === 'missing-after-block') {
    const state = await stateFiles.read(workspaceId); const original = state.receipts.find(item => item.id === saved.id) as StoredJevReceipt;
    if (boundary === 'missing-artifacts') delete original.preparedArtifacts;
    else for (const artifact of original.preparedArtifacts!) if (artifact.kind === 'canvas') artifact.after.blocks = [];
    await stateFiles.write(workspaceId, state);
  }
  const before = await store.getCanvas(related.canvasId, true);
  await expect(preflightCausalParentUndo(store, workspaceId, canvasId, [parent()])).rejects.toMatchObject({ status: 409 });
  expect(await store.getCanvas(related.canvasId, true)).toEqual(before); expect(await current()).toEqual(source);
});

it('restores a checked automatic chain in reverse order and leaves unrelated manual metadata intact', async () => {
  const sibling = await store.createBlock(canvasId, { title: 'Untouched sibling', content: '# Independent source' });
  const siblingBefore = await store.getCanvasBlock(canvasId, sibling.id);
  const first = await receipt(canvasId, source.id, { group: 'custom:first' });
  const second = await receipt(canvasId, source.id, { group: null });
  const related = await secondary(); const manual = await receipt(related.canvasId, related.block.id, { headline: 'Human metadata' }, false);
  await withCausalParentUndo(store, workspaceId, canvasId, [parent()], owner, () => store.deleteBlock(canvasId, source.id, 'Symbi'));
  const state = await stateFiles.read(workspaceId);
  expect(state.receipts.find(value => value.id === first.id)?.state).toBe('undone');
  expect(state.receipts.find(value => value.id === second.id)?.state).toBe('undone');
  expect(state.receipts.find(value => value.id === manual.id)?.state).toBe('applied');
  expect((await store.getCanvasBlock(related.canvasId, related.block.id)).headline).toBe('Human metadata');
  expect((await store.getCanvas(canvasId, true)).blocks.map(block => block.id)).toEqual([sibling.id]);
  expect(await store.getCanvasBlock(canvasId, sibling.id)).toEqual(siblingBefore);
});

it.each([false, true])('accounts for an already-deleted peer and preserves remaining link types: %s', async remaining => {
  const peer = await store.createBlock(canvasId, { title: 'Peer source', content: '# Peer' });
  const unrelated = await store.createBlock(canvasId, { title: 'Unrelated source', content: '# Unrelated' });
  source = await store.updateBlock(canvasId, source.id, { links: remaining ? [peer.id, unrelated.id] : [peer.id],
    linkTypes: remaining ? { [peer.id]: 'related', [unrelated.id]: 'prerequisite' } : { [peer.id]: 'related' } }, 'Symbi');
  const expected = source;
  await store.deleteBlock(canvasId, peer.id, 'Symbi');
  await withCausalParentUndo(store, workspaceId, canvasId, [{ kind: 'created', after: expected }], owner,
    () => store.deleteBlock(canvasId, source.id, 'Symbi', { requireUnreferenced: true }),
    { peers: [{ kind: 'created', after: peer }, { kind: 'created', after: expected }] });
  expect((await store.getCanvas(canvasId, true)).blocks.map(block => block.id)).toEqual([unrelated.id]);
});

it('projects another parent edit before reference checks and rejects a later peer correction', async () => {
  const peerBefore = await store.createBlock(canvasId, { title: 'Peer source', content: '# Peer' });
  const peerAfter = await store.updateBlock(canvasId, peerBefore.id, { links: [source.id] }, 'Symbi');
  const peers: JevParentUndo[] = [parent(), { kind: 'edited', before: peerBefore, after: peerAfter }];
  await store.updateBlock(canvasId, peerBefore.id, { title: 'Human peer correction' }, 'Browser');
  const changed = await store.getCanvasBlock(canvasId, peerBefore.id);
  await expect(withCausalParentUndo(store, workspaceId, canvasId, [parent()], owner,
    () => store.deleteBlock(canvasId, source.id, 'Symbi'), { peers })).rejects.toMatchObject({ status: 409 });
  expect(await current()).toEqual(source); expect(await store.getCanvasBlock(canvasId, peerBefore.id)).toEqual(changed);
});

it('projects a checked peer edit before deleting its created parent and preserves the peer document', async () => {
  const peer = await store.createBlock(canvasId, { title: 'Edited peer source', content: '# Independent peer' });
  const before = await store.getCanvasBlock(canvasId, peer.id);
  const after = await store.updateBlock(canvasId, peer.id, { links: [source.id] }, 'Symbi');
  const peers: JevParentUndo[] = [parent(), { kind: 'edited', before, after }];
  await withCausalParentUndo(store, workspaceId, canvasId, [parent()], owner,
    () => store.deleteBlock(canvasId, source.id, 'Symbi'), { peers });
  const surviving = await store.getCanvasBlock(canvasId, peer.id);
  expect(surviving.links).toEqual([]); expect(surviving.content).toBe(before.content);
  expect(surviving.incarnation).toBe(before.incarnation);
  expect(surviving.sourceGeneration).toBe(before.sourceGeneration);
  expect(surviving.metadataRevision).toBeGreaterThan(after.metadataRevision!);
  expect((await store.getCanvas(canvasId, true)).blocks.map(block => block.id)).toEqual([peer.id]);
});

it.each(['local', 'cross-canvas'] as const)('holds parent deletion when a native %s reference still exists', async reference => {
  const related = reference === 'local'
    ? { canvasId, block: await store.createBlock(canvasId, { title: 'Local reference', content: '# Local peer' }) }
    : await secondary();
  const patch = reference === 'local' ? { links: [source.id] }
    : { crossLinks: [{ canvasId, blockId: source.id, relation: 'related' as const }] };
  await store.updateBlock(related.canvasId, related.block.id, patch, 'Browser');
  const peer = await store.getCanvasBlock(related.canvasId, related.block.id);
  await expect(preflightCausalParentUndo(store, workspaceId, canvasId, [parent()])).rejects.toMatchObject({ status: 409 });
  expect(await store.getCanvasBlock(related.canvasId, peer.id)).toEqual(peer); expect(await current()).toEqual(source);
});

it('retains a saved cross-workspace reference even when the native hydrated view filters that legacy reference', async () => {
  const otherWorkspace = await store.createWorkspace({ name: 'Legacy imported workspace' });
  const otherCanvas = await store.createCanvas(otherWorkspace.id, { name: 'Legacy imported links' });
  const peer = await store.createBlock(otherCanvas.id, { title: 'Saved foreign reference', content: '# Reference' });
  const raw = await files.readJson<StoredCanvas>(files.canvasFile(otherCanvas.id));
  raw.blocks.find(block => block.id === peer.id)!.crossLinks = [{ canvasId, blockId: source.id, relation: 'related' }];
  await atomicJson(files.canvasFile(otherCanvas.id), raw);
  expect((await store.getCanvasBlock(otherCanvas.id, peer.id)).crossLinks ?? []).toEqual([]);
  await expect(preflightCausalParentUndo(store, workspaceId, canvasId, [parent()])).rejects.toMatchObject({ status: 409 });
  expect(await files.readJson(files.canvasFile(otherCanvas.id))).toEqual(raw); expect(await current()).toEqual(source);
});

it('keeps a failed rollback journal and refuses recovery over a later human write', async () => {
  await receipt(canvasId, source.id, { group: 'custom:organized' });
  await expect(withCausalParentUndo(store, workspaceId, canvasId, [parent()], owner, async () => {
    await store.updateBlock(canvasId, source.id, { content: '# Later human source' }, 'Browser');
    throw new Error('Native parent action failed');
  })).rejects.toMatchObject({ name: 'AggregateError', message: 'Parent Undo stopped and requires checked recovery' });
  const later = await current(); const names = await readdir(directory()); expect(names).toHaveLength(1);
  await expect(recoverParentUndos(new CanvasStore(root), workspaceId)).rejects.toMatchObject({ status: 503 });
  expect(await current()).toEqual(later); expect((await stateFiles.read(workspaceId)).receipts[0].state).toBe('applied');
  expect(await readdir(directory())).toEqual(names);
});

it('finishes a completed native edit after ledger write failure without rolling back restored source bytes', async () => {
  const before = source; const after = await store.updateBlock(canvasId, source.id, { content: '# Edited parent source' }, 'Symbi');
  source = after; const saved = await receipt(canvasId, source.id, { group: 'custom:organized' });
  const stateFile = stateFiles.file(workspaceId); const backup = stateFile + '.backup';
  await expect(withCausalParentUndo(store, workspaceId, canvasId, [{ kind: 'edited', before, after }], owner, async () => {
    await store.updateBlock(canvasId, source.id, { content: before.content }, 'Symbi');
    await store.jevExecutor.setOwnership(canvasId, source.id, before.jevOwnership!);
    await rename(stateFile, backup); await mkdir(stateFile);
  })).rejects.toMatchObject({ code: 'EISDIR' });
  await rm(stateFile, { recursive: true }); await rename(backup, stateFile);
  const names = await readdir(directory()); expect(names).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(directory(), names[0]), 'utf8')).state).toBe('completed');
  await recoverParentUndos(new CanvasStore(root), workspaceId);
  expect((await current()).content).toBe(before.content); expect((await current()).sourceGeneration).toBeGreaterThan(after.sourceGeneration!);
  expect((await stateFiles.read(workspaceId)).receipts.find(item => item.id === saved.id)?.state).toBe('undone');
  expect(await readdir(directory())).toEqual([]);
});

it('handles a pruned receipt in a completed native deletion journal without resurrecting the document', async () => {
  const prepared = await journal(); prepared.canvases = []; prepared.receipts = [randomUUID()];
  await store.deleteBlock(canvasId, source.id, 'Symbi');
  const file = await writeJournal(prepared, prepared.id);
  await recoverParentUndos(new CanvasStore(root), workspaceId);
  expect((await store.getCanvas(canvasId, true)).blocks).toEqual([]);
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('repairs a compensated legacy canvas journal with missing metadata clocks without changing source identity', async () => {
  const related = await secondary();
  const before = await files.readJson<StoredCanvas>(files.canvasFile(related.canvasId));
  const block = before.blocks.find(item => item.id === related.block.id)!;
  delete block.metadataRevision;
  const after = structuredClone(before); after.blocks[0].group = 'custom:compensated';
  await atomicJson(files.canvasFile(related.canvasId), after);
  const id = randomUUID();
  const file = await writeJournal({ id, workspaceId, canvasId, parents: [parent()], receipts: [], actor: 'Symbi', state: 'compensated',
    canvases: [{ id: related.canvasId, before, after }] }, id);
  await recoverParentUndos(new CanvasStore(root), workspaceId);
  const restored = await files.readJson<StoredCanvas>(files.canvasFile(related.canvasId));
  expect(restored).toEqual({ ...before, blocks: before.blocks.map(item => ({ ...item, metadataRevision: 1 })) });
  expect((await store.getCanvasBlock(related.canvasId, related.block.id)).content).toBe(related.block.content);
  expect(await current()).toEqual(source);
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
