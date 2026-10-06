import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readdir, readFile, rm } from 'node:fs/promises';
import type { CanvasBlock, CanvasDocument } from '../../shared/types.js';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { documentReviewState } from '../../shared/document-state.js';
import type { JevArtifact } from '../storage-jev-executor.js';
import type { CanvasStore } from '../storage.js';
import { ApiError } from '../errors.js';
import { atomicJson, StorageFiles } from '../storage-files.js';
import { canvasData, contentHash, storedBlock, validId, type StoredCanvas } from '../storage-shapes.js';
import { changedJevStamp, initializeJevStamp } from './stamps.js';
import { requireApprove, requireCanvas, currentPrincipal } from './authorization.js';
import type { StoredJevReceipt } from './proposals.js';
import { JevWorkspaceFiles } from './workspace.js';

export type JevParentUndo = { kind: 'created'; after: CanvasBlock } | { kind: 'edited'; before: CanvasBlock; after: CanvasBlock };
type CausalCanvas = { id: string; before: StoredCanvas; after: StoredCanvas };
type CausalJournal = { id: string; workspaceId: string; canvasId: string; parents: JevParentUndo[];
  canvases: CausalCanvas[]; receipts: string[]; actor?: string; state: 'prepared' | 'compensated' | 'completed' };

function same(value: unknown, expected: unknown): boolean { return JSON.stringify(value) === JSON.stringify(expected); }
function directory(store: CanvasStore): string { return path.join(store.root, 'jev', 'parent-undo'); }
function saved(canvas: CanvasDocument): StoredCanvas { return { ...canvasData(canvas), blocks: canvas.blocks.map(storedBlock) }; }

export const browserUndoDefaults: Record<string, unknown> = { linkTypes: {}, crossLinks: [], group: null, tags: [], purpose: null, reviewer: null, workArea: null,
  stale: false, archived: false, headline: null, freshness: null };
function browserDefault(block: CanvasBlock, key: string, defaultValue: unknown): unknown {
  const value = Reflect.get(block, key) ?? (defaultValue === null ? undefined : defaultValue);
  if (key === 'crossLinks' && Array.isArray(value) && !value.length) return undefined;
  return value;
}
function browserMetadata(block: CanvasBlock): Record<string, unknown> {
  return Object.fromEntries(Object.entries(browserUndoDefaults).map(([key, value]) => [key, browserDefault(block, key, value)]));
}
function restoredParent(parent: Extract<JevParentUndo, { kind: 'edited' }>, block: CanvasBlock, actor?: string): boolean {
  const expected = { ...parent.before, ...(actor === 'Browser' ? browserMetadata(parent.before) : {}), contentHash: contentHash(parent.before.content),
    jevOwnership: initializeJevStamp(parent.before).jevOwnership };
  return block.incarnation === parent.after.incarnation && block.sourceGeneration! >= parent.after.sourceGeneration!
    && documentReviewState(block) === documentReviewState(expected);
}

function parentStamp(parent: JevParentUndo): boolean {
  const after = parent.after;
  return Boolean(after) && validId(after.id) && typeof after.incarnation === 'string' && Number.isSafeInteger(after.sourceGeneration)
    && after.sourceGeneration! >= 1 && typeof after.content === 'string';
}
function parentShape(parent: JevParentUndo): boolean {
  if (!parent || !['created', 'edited'].includes(parent.kind) || !parentStamp(parent)) return false;
  return parent.kind === 'created' || (parent.before?.id === parent.after.id && typeof parent.before.content === 'string');
}
function canvasPart(canvas: StoredCanvas | undefined, id: string, workspaceId: string): boolean {
  return canvas?.id === id && canvas.workspaceId === workspaceId && Array.isArray(canvas.blocks);
}
function canvasShape(canvas: CausalCanvas, workspaceId: string): boolean {
  return Boolean(canvas) && validId(canvas.id) && canvasPart(canvas.before, canvas.id, workspaceId) && canvasPart(canvas.after, canvas.id, workspaceId);
}
function journalLists(journal: CausalJournal): boolean {
  return Array.isArray(journal.parents) && journal.parents.length > 0 && Array.isArray(journal.canvases) && Array.isArray(journal.receipts);
}
function journalScope(journal: CausalJournal, name: string): boolean {
  return journal.id === name.slice(0, -5) && validId(journal.workspaceId) && validId(journal.canvasId) && ['prepared', 'compensated', 'completed'].includes(journal.state);
}
function journalShape(value: unknown, name: string): value is CausalJournal {
  if (!value || typeof value !== 'object') return false;
  const journal = value as CausalJournal;
  if (!journalScope(journal, name) || !journalLists(journal)) return false;
  return journalEntriesValid(journal);
}
function journalEntriesValid(journal: CausalJournal): boolean {
  return journal.parents.every(parentShape) && journal.canvases.every(canvas => canvasShape(canvas, journal.workspaceId))
    && journal.receipts.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id));
}

async function readJournal(file: string, name: string): Promise<CausalJournal> {
  let journal: unknown;
  try { journal = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new ApiError(503, 'Parent Undo recovery metadata requires repair'); }
  if (!journalShape(journal, name)) throw new ApiError(503, 'Parent Undo recovery metadata requires repair');
  return journal;
}

function afterPeerDeletions(parent: JevParentUndo, peers: JevParentUndo[], canvas: CanvasDocument): CanvasBlock {
  let expected = parent.after;
  for (const peer of peers) {
    if (peer.kind !== 'created' || canvas.blocks.some(block => block.id === peer.after.id) || !expected.links.includes(peer.after.id)) continue;
    const links = expected.links.filter(id => id !== peer.after.id);
    const linkTypes = { ...expected.linkTypes }; delete linkTypes[peer.after.id];
    expected = changedJevStamp(expected, { ...expected, links, linkTypes: Object.keys(linkTypes).length ? linkTypes : undefined });
  }
  return expected;
}

function sameParent(block: CanvasBlock | undefined, expected: CanvasBlock): boolean {
  return Boolean(block) && block!.incarnation === expected.incarnation && block!.sourceGeneration === expected.sourceGeneration
    && documentReviewState(block!) === documentReviewState(expected);
}
function undonePeer(block: CanvasBlock, parent: JevParentUndo): boolean {
  return parent.kind === 'edited' && documentReviewState(block) === documentReviewState({ ...parent.before,
    jevOwnership: initializeJevStamp(parent.before).jevOwnership });
}
function referencesAfterUndo(canvas: CanvasDocument, canvasId: string, peers: JevParentUndo[]): CanvasBlock[] {
  if (canvas.id !== canvasId) return canvas.blocks;
  return canvas.blocks.flatMap(block => {
    const peer = peers.find(parent => parent.after.id === block.id);
    if (!peer || undonePeer(block, peer)) return [block];
    if (!sameParent(block, afterPeerDeletions(peer, peers, canvas))) throw new ApiError(409, 'A related document changed after the parent action');
    return peer.kind === 'created' ? [] : [peer.before];
  });
}
type CausalReceipt = StoredJevReceipt & { before: Extract<StoredJevReceipt['before'], { kind: 'document' }>; after: Extract<StoredJevReceipt['after'], { kind: 'document' }> };
function automaticDocument(receipt: StoredJevReceipt): receipt is CausalReceipt {
  return receipt.state === 'applied' && receipt.automatic === true && receipt.after.kind === 'document' && receipt.before.kind === 'document';
}
function causalReceipt(receipt: CausalReceipt, parents: JevParentUndo[], canvasId: string): boolean {
  return parents.some(parent => receipt.sourcesAfter.some(source => source.canvasId === canvasId && source.blockId === parent.after.id
    && source.incarnation === parent.after.incarnation && source.sourceGeneration === parent.after.sourceGeneration));
}
function causalBlock(block: CanvasBlock | undefined, receipt: CausalReceipt): asserts block is CanvasBlock {
  if (!block || Object.entries(receipt.after.patch).some(([field, value]) => !same(block[field as keyof CanvasBlock] ?? null, value ?? null))) {
    throw new ApiError(409, 'Later organization changes prevent this parent Undo');
  }
}
function artifactMarker(artifact: Extract<JevArtifact, { kind: 'canvas' }>, id: string): string | undefined {
  return artifact.before.blocks.find(item => item.id === id)?.jevMutationId;
}
function restoreCausalBlock(block: CanvasBlock, receipt: CausalReceipt): CanvasBlock {
  const artifact = receipt.preparedArtifacts?.find((item): item is Extract<JevArtifact, { kind: 'canvas' }> => item.kind === 'canvas' && item.id === receipt.after.canvasId);
  const after = artifact?.after.blocks.find(item => item.id === block.id);
  if (!after || !same(block.jevOwnership, after.jevOwnership)) throw new ApiError(409, 'A manual correction prevents this parent Undo');
  const originalMarker = artifactMarker(artifact!, block.id);
  const reviewed: CanvasBlock = { ...block };
  for (const [field, value] of Object.entries(receipt.before.patch)) Reflect.set(reviewed, field, value === null ? undefined : value);
  const restored = changedJevStamp(block, reviewed, { mutationId: receipt.id, managed: true });
  restored.jevOwnership = receipt.ownershipBefore;
  restored.jevMutationId = originalMarker;
  return restored;
}
function referencesBlock(block: CanvasBlock, canvasId: string, target: string): boolean {
  return block.crossLinks?.some(link => link.canvasId === canvasId && link.blockId === target) === true;
}
function localReference(block: CanvasBlock, target: string): boolean { return block.id !== target && block.links.includes(target); }
class ParentProjection {
  private readonly canvases = new Map<string, { before: CanvasDocument; after: CanvasDocument }>();
  private readonly chosen: string[] = [];
  constructor(private readonly store: CanvasStore, private readonly files: StorageFiles, private readonly workspaceId: string,
    private readonly canvasId: string, private readonly parents: JevParentUndo[], private readonly actor: string, private readonly peers: JevParentUndo[]) {}

  private async load(id: string) {
    if (!this.canvases.has(id)) {
      const canvas = await this.store.getCanvas(id, true);
      const raw = await this.files.readJson<StoredCanvas>(this.files.canvasFile(id));
      const hydrated = { ...canvas, blocks: canvas.blocks.map(block => ({ ...block, crossLinks: raw.blocks.find(item => item.id === block.id)?.crossLinks })) };
      this.canvases.set(id, { before: hydrated, after: structuredClone(hydrated) });
    }
    return this.canvases.get(id)!;
  }

  private async compensate(receipt: StoredJevReceipt): Promise<void> {
    if (!automaticDocument(receipt) || !causalReceipt(receipt, this.parents, this.canvasId)) return;
    const view = await this.load(receipt.after.canvasId);
    const block = view.after.blocks.find(item => item.id === receipt.after.blockId);
    causalBlock(block, receipt);
    const restored = restoreCausalBlock(block, receipt);
    view.after.blocks = view.after.blocks.map(item => item.id === block.id ? restored : item);
    this.chosen.push(receipt.id);
  }

  private async checkCanvasReferences(id: string, target: string): Promise<void> {
    const canvas = this.canvases.get(id)?.after ?? await this.store.getCanvas(id, true);
    const references = referencesAfterUndo(canvas, this.canvasId, this.peers);
    if (references.some(block => (id === this.canvasId && localReference(block, target)) || referencesBlock(block, this.canvasId, target))) throw new ApiError(409, 'This document has a new reference');
    const raw = await this.files.readJson<StoredCanvas>(this.files.canvasFile(id));
    if (!this.canvases.has(id) && raw.blocks.some(block => referencesBlock(block as CanvasBlock, this.canvasId, target))) throw new ApiError(409, 'This document has a saved cross-canvas reference');
  }

  private async checkParent(parent: JevParentUndo, canvas: CanvasDocument): Promise<void> {
    const current = canvas.blocks.find(block => block.id === parent.after.id);
    if (!sameParent(current, afterPeerDeletions(parent, this.peers, canvas))) throw new ApiError(409, 'This document changed after the parent action');
    this.store.locks.check(this.canvasId, current!.id, this.actor);
    if (parent.kind !== 'created') return;
    for (const workspace of await this.store.listWorkspaces()) for (const summary of workspace.canvases) await this.checkCanvasReferences(summary.id, current!.id);
  }

  async build(receipts: StoredJevReceipt[]): Promise<CausalJournal> {
    await this.load(this.canvasId);
    for (const receipt of [...receipts].reverse()) await this.compensate(receipt);
    const canvas = (await this.load(this.canvasId)).after;
    for (const parent of this.parents) await this.checkParent(parent, canvas);
    return { id: randomUUID(), workspaceId: this.workspaceId, canvasId: this.canvasId, parents: this.parents, receipts: this.chosen, actor: this.actor, state: 'prepared',
      canvases: [...this.canvases].filter(([, value]) => !same(saved(value.before), saved(value.after)))
        .map(([id, value]) => ({ id, before: saved(value.before), after: saved(value.after) })) };
  }
}
async function project(store: CanvasStore, files: StorageFiles, workspaceId: string, canvasId: string,
  parents: JevParentUndo[], receipts: StoredJevReceipt[], actor = 'Symbi', peers = parents): Promise<CausalJournal> {
  return new ParentProjection(store, files, workspaceId, canvasId, parents, actor, peers).build(receipts);
}

export async function preflightCausalParentUndo(store: CanvasStore, workspaceId: string, canvasId: string, parents: JevParentUndo[]): Promise<void> {
  const files = new StorageFiles(store.root, store.locks);
  const state = await new JevWorkspaceFiles(store.root).read(workspaceId);
  await files.serialize(() => project(store, files, workspaceId, canvasId, parents, state.receipts as StoredJevReceipt[]));
}

async function restore(files: StorageFiles, journal: CausalJournal): Promise<void> {
  for (const artifact of journal.canvases) {
    const current = await files.readJson<StoredCanvas>(files.canvasFile(artifact.id));
    if (!same(current, artifact.before) && !same(current, artifact.after)) throw new ApiError(503, 'Parent Undo recovery conflicts with a later change');
  }
  for (const artifact of journal.canvases) {
    const current = await files.readJson<StoredCanvas>(files.canvasFile(artifact.id));
    const blocks = artifact.before.blocks.map(block => {
      const now = current.blocks.find(item => item.id === block.id)!;
      return { ...block, sourceGeneration: now.sourceGeneration, metadataRevision: Math.max(now.metadataRevision ?? 0, block.metadataRevision ?? 0) + 1 };
    });
    await atomicJson(files.canvasFile(artifact.id), { ...artifact.before, blocks });
  }
}

function markUndone(state: Awaited<ReturnType<JevWorkspaceFiles['read']>>, ids: string[]): void {
  for (const id of ids) { const receipt = state.receipts.find(item => item.id === id); if (receipt) receipt.state = 'undone'; }
}
async function compensateJournal(files: StorageFiles, journal: CausalJournal, file: string): Promise<void> {
  for (const canvas of journal.canvases) await atomicJson(files.canvasFile(canvas.id), canvas.after);
  journal.state = 'compensated'; await atomicJson(file, journal, 0o600);
}

/** Native parent preconditions and every unchanged causal inverse are checked before any write. */
export async function withCausalParentUndo<T>(store: CanvasStore, workspaceId: string, canvasId: string, parents: JevParentUndo[],
  supplied: JevPrincipal, work: () => Promise<T>, options: { actor?: string; peers?: JevParentUndo[] } = {}): Promise<T> {
  const principal = await currentPrincipal(store, supplied); requireApprove(principal); requireCanvas(principal, canvasId);
  const workspaceFiles = new JevWorkspaceFiles(store.root);
  const files = new StorageFiles(store.root, store.locks);
  return workspaceFiles.serial(workspaceId, () => files.serialize(async () => {
    const state = await workspaceFiles.read(workspaceId);
    if ((await store.getCanvas(canvasId, true)).workspaceId !== workspaceId) throw new ApiError(404, 'Parent scope not found');
    const journal = await project(store, files, workspaceId, canvasId, parents, state.receipts as StoredJevReceipt[], options.actor, options.peers);
    for (const canvas of journal.canvases) requireCanvas(principal, canvas.id);
    const file = path.join(directory(store), `${journal.id}.json`);
    await atomicJson(file, journal, 0o600);
    try {
      await compensateJournal(files, journal, file);
      const result = await work();
      journal.state = 'completed'; await atomicJson(file, journal, 0o600);
      markUndone(state, journal.receipts);
      await workspaceFiles.write(workspaceId, state);
      await rm(file, { force: true });
      return result;
    } catch (error) {
      if (journal.state === 'completed') throw error;
      try { await restore(files, journal); await rm(file, { force: true }); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Parent Undo stopped and requires checked recovery'); }
      throw error;
    }
  }));
}

export async function recoverParentUndos(store: CanvasStore, workspaceId: string): Promise<void> {
  let names: string[];
  try { names = await readdir(directory(store)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const files = new StorageFiles(store.root, store.locks);
  const workspaceFiles = new JevWorkspaceFiles(store.root);
  for (const name of names.filter(value => /^[a-f0-9-]{36}\.json$/.test(value))) {
    const file = path.join(directory(store), name);
    const journal = await readJournal(file, name);
    if (journal.workspaceId !== workspaceId) continue;
    await files.serialize(async () => {
      const canvas = await store.getCanvas(journal.canvasId, true);
      const completed = journal.parents.every(parent => parent.kind === 'created' ? !canvas.blocks.some(block => block.id === parent.after.id)
        : canvas.blocks.some(block => block.id === parent.before.id && restoredParent(parent, block, journal.actor)));
      if (journal.state === 'completed' || completed) {
        const state = await workspaceFiles.read(workspaceId);
        markUndone(state, journal.receipts);
        await workspaceFiles.write(workspaceId, state);
      } else await restore(files, journal);
      await rm(file, { force: true });
    });
  }
}
