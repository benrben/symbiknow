import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import type { CanvasBlock, CanvasDocument, CanvasTask, CrossLink } from '../shared/types.js';
import { commentedTask } from './coordination.js';
import { ApiError } from './errors.js';
import { atomicJson, durableDocument } from './storage-files.js';
import { changedJevStamp } from './jev/stamps.js';
import { contentHash, storedBlock, validId, type MergeJournal, type StoredCanvas, type StoredBlock } from './storage-shapes.js';
import { contentText } from './storage-validation.js';
import type { StorageContext } from './storage-context.js';
import { outgoingCrossLinks, outgoingRelations } from './merge-references.js';
import { mergeTransaction } from './merge-transaction.js';
import { recoverableMerge } from './merge-recovery.js';
import type { MergeRecoveryJournal } from './merge-transaction-types.js';

type MergeInput = { keepBlockId: string; mergeBlockIds: string[]; hashes: Record<string, unknown>; content: string };
const invalidMerge = 'Merge requires a keeper, distinct documents, and expected content hashes';

function mergeIds(value: unknown, keeper: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10 ||
    value.some(id => typeof id !== 'string' || !validId(id) || id === keeper) || new Set(value).size !== value.length) {
    throw new ApiError(400, invalidMerge);
  }
  return value;
}

function mergeHashes(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, invalidMerge);
  return value as Record<string, unknown>;
}

function mergeInput(input: Record<string, unknown>): MergeInput {
  const content = contentText(input.content);
  const keeper = input.keepBlockId;
  if (typeof keeper !== 'string' || !validId(keeper)) throw new ApiError(400, invalidMerge);
  return { keepBlockId: keeper, mergeBlockIds: mergeIds(input.mergeBlockIds, keeper), hashes: mergeHashes(input.expectedContentHashes), content };
}

function mergeBlock(canvas: CanvasDocument, id: string): CanvasBlock {
  const block = canvas.blocks.find(item => item.id === id);
  if (!block || block.archived) throw new ApiError(404, 'A merge document no longer exists');
  return block;
}

function remappedLocalLinks(block: CanvasBlock, keeper: string, mergedIds: Set<string>, outgoing: Set<string>): string[] {
  if (block.id === keeper) return [...outgoing];
  return [...new Set(block.links.map(id => mergedIds.has(id) ? keeper : id))].filter(id => id !== block.id);
}

function remappedLinkTypes(block: CanvasBlock, keeper: string, mergedIds: Set<string>, links: string[]) {
  const entries = Object.entries(block.linkTypes ?? {}).map(([id, relation]) => [mergedIds.has(id) ? keeper : id, relation]);
  return Object.fromEntries(entries.filter(([id]) => links.includes(id)));
}

function mergedBlocks(canvas: CanvasDocument, keeper: CanvasBlock, merging: CanvasBlock[], input: MergeInput): CanvasBlock[] {
  const mergedIds = new Set(input.mergeBlockIds);
  // Canvas hydration always supplies the required local link collection.
  const outgoing = new Set([...keeper.links, ...merging.flatMap(block => block.links)]);
  const relations = outgoingRelations(keeper, merging);
  const crossLinks = outgoingCrossLinks(keeper, merging);
  outgoing.delete(keeper.id);
  for (const id of mergedIds) outgoing.delete(id);
  return canvas.blocks.map(block => {
    if (mergedIds.has(block.id)) return { ...block, archived: true };
    const links = remappedLocalLinks(block, keeper.id, mergedIds, outgoing);
    const source = block.id === keeper.id ? { ...block, linkTypes: relations } : block;
    const linkTypes = remappedLinkTypes(source, keeper.id, mergedIds, links);
    return { ...block, ...(block.id === keeper.id ? { content: input.content, crossLinks: crossLinks.length ? crossLinks : undefined } : {}), links,
      linkTypes: Object.keys(linkTypes).length ? linkTypes : undefined };
  });
}

function remappedCrossLinks(links: CrossLink[], canvasId: string, keeper: string, mergedIds: Set<string>): CrossLink[] {
  const mapped = new Map<string, CrossLink>();
  for (const link of links) {
    const next = link.canvasId === canvasId && mergedIds.has(link.blockId) ? { ...link, blockId: keeper } : link;
    mapped.set(`${next.canvasId}:${next.blockId}`, next);
  }
  return [...mapped.values()];
}

function remappedCrossBlock(block: StoredBlock, canvasId: string, keeper: string, mergedIds: Set<string>): StoredBlock {
  if (!block.crossLinks?.some(link => link.canvasId === canvasId && mergedIds.has(link.blockId))) return block;
  return storedBlock(changedJevStamp({ ...block, content: '' },
    { ...block, content: '', crossLinks: remappedCrossLinks(block.crossLinks, canvasId, keeper, mergedIds) }));
}

function mergedTasks(tasks: CanvasTask[], merging: CanvasBlock[], keeper: CanvasBlock, mergedIds: Set<string>, actor: string): CanvasTask[] {
  const titles = merging.map(block => block.title).join(', ');
  return tasks.map(task => task.blockIds.some(id => mergedIds.has(id))
    ? commentedTask({ ...task, blockIds: [...new Set(task.blockIds.map(id => mergedIds.has(id) ? keeper.id : id))] },
      `Merged ${titles} into ${keeper.title}`, actor) : task);
}

export class StorageMerges {
  constructor(private readonly context: StorageContext) {}

  async mergeDocuments(canvasId: string, input: Record<string, unknown>, actor = 'api'):
    Promise<{ mergeId: string; keepBlockId: string; archivedBlockIds: string[]; contentHash: string }> {
    const validated = mergeInput(input);
    return this.context.files.serialize(() => this.applyMerge(canvasId, validated, actor));
  }

  private async applyMerge(canvasId: string, input: MergeInput, actor: string) {
    const canvas = await this.context.getCanvas(canvasId, true);
    const beforeCanvas = await this.context.files.readJson<StoredCanvas>(this.context.files.canvasFile(canvasId));
    const keeper = mergeBlock(canvas, input.keepBlockId);
    const merging = input.mergeBlockIds.map(id => mergeBlock(canvas, id));
    this.checkMergeDocuments(canvasId, [keeper, ...merging], input.hashes, actor);
    const mergedIds = new Set(input.mergeBlockIds);
    const blocks = mergedBlocks(canvas, keeper, merging, input).map(block =>
      changedJevStamp(canvas.blocks.find(item => item.id === block.id)!, block, undefined, block.id === keeper.id));
    const afterCanvas = { ...beforeCanvas, blocks: blocks.map(storedBlock) };
    const otherCanvases = await this.inboundMergeLinks(canvas, keeper.id, mergedIds);
    const beforeTasks = await this.readTasks(canvasId);
    const afterTasks = mergedTasks(beforeTasks, merging, keeper, mergedIds, actor);
    const mergeId = randomUUID();
    const journal: MergeJournal = { mergeId, canvasId, keepBlockId: keeper.id,
      beforeCanvas, afterCanvas, beforeTasks: structuredClone(beforeTasks), afterTasks,
      beforeContent: keeper.content, afterContent: input.content, otherCanvases };
    const reserved = { ...beforeCanvas, blocks: beforeCanvas.blocks.map(block => block.id === keeper.id ? {
      ...block, incarnation: blocks.find(item => item.id === keeper.id)!.incarnation,
      sourceGeneration: blocks.find(item => item.id === keeper.id)!.sourceGeneration,
      metadataRevision: blocks.find(item => item.id === keeper.id)!.metadataRevision,
    } : block) };
    journal.recoveryCanvases = [reserved];
    await mergeTransaction(this.context.files, journal, async () => {
      await atomicJson(this.context.files.canvasFile(canvasId), reserved);
      await this.commitMerge(keeper, merging, input.content, actor);
      await this.writeMergeState(journal, 'after', actor);
    }, () => this.restoreMerge(journal, keeper, 'before', 'Rollback failed merge', actor), 'merge');
    this.context.saved?.({ workspaceId: canvas.workspaceId, canvasId, blockIds: [keeper.id, ...mergedIds], kind: 'source', actor });
    return { mergeId, keepBlockId: keeper.id, archivedBlockIds: [...mergedIds], contentHash: contentHash(input.content) };
  }

  private checkMergeDocuments(canvasId: string, blocks: CanvasBlock[], hashes: Record<string, unknown>, actor: string): void {
    for (const block of blocks) {
      this.context.locks.check(canvasId, block.id, actor);
      if (hashes[block.id] !== contentHash(block.content)) throw new ApiError(409, 'A merge document changed. Review the proposed merge again.');
    }
  }

  private async commitMerge(keeper: CanvasBlock, merging: CanvasBlock[], content: string, actor: string): Promise<void> {
    const versions = this.context.files.versionFile(keeper.id);
    await versions.init(keeper.content);
    if (content === keeper.content) return;
    await versions.commit(content, `Merge ${merging.map(block => block.title).join(', ')} into ${keeper.title}`, actor);
    await durableDocument(this.context.files.docFile(keeper.file), content);
  }

  private async inboundMergeLinks(canvas: CanvasDocument, keeper: string, mergedIds: Set<string>): Promise<MergeJournal['otherCanvases']> {
    const workspace = (await this.context.listWorkspaces()).find(item => item.id === canvas.workspaceId);
    const changes: MergeJournal['otherCanvases'] = [];
    for (const summary of workspace?.canvases ?? []) {
      if (summary.id === canvas.id) continue;
      const before = await this.context.files.readJson<StoredCanvas>(this.context.files.canvasFile(summary.id));
      const blocks = before.blocks.map(block => remappedCrossBlock(block, canvas.id, keeper, mergedIds));
      if (blocks.some((block, index) => block !== before.blocks[index])) changes.push({ id: summary.id, before, after: { ...before, blocks } });
    }
    return changes;
  }

  private async readTasks(canvasId: string): Promise<CanvasTask[]> {
    try { return await this.context.files.readJson<CanvasTask[]>(this.context.files.tasksFile(canvasId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeMergeState(journal: MergeJournal, state: 'before' | 'after', actor: string): Promise<void> {
    await atomicJson(this.context.files.canvasFile(journal.canvasId), journal[`${state}Canvas`]);
    for (const other of journal.otherCanvases ?? []) await atomicJson(this.context.files.canvasFile(other.id), other[state]);
    const tasks = journal[`${state}Tasks`];
    if (tasks.length || state === 'before') {
      const taskDirectory = dirname(this.context.files.tasksFile(journal.canvasId));
      await mkdir(taskDirectory, { recursive: true });
      // Preserve the canonical write failure when a simultaneous hook makes the task directory unwritable.
      await access(taskDirectory, constants.W_OK);
      await this.context.writeTaskSnapshot(journal.canvasId, await this.readTasks(journal.canvasId), tasks, actor);
    }
  }

  private async restoreMerge(journal: MergeJournal, keeper: StoredBlock, state: 'before' | 'after', message: string, actor: string): Promise<void> {
    const content = journal[`${state}Content`];
    const current = await this.context.getCanvas(journal.canvasId, true);
    const desired = journal[`${state}Canvas`];
    const blocks = desired.blocks.map(block => {
      const previous = current.blocks.find(item => item.id === block.id)!;
      const restored = changedJevStamp(previous, { ...block, content: block.id === keeper.id ? content : previous.content },
        { mutationId: block.jevMutationId ?? '' , managed: true }, block.id === keeper.id);
      restored.jevOwnership = block.jevOwnership;
      restored.jevMutationId = block.jevMutationId;
      return storedBlock(restored);
    });
    const refreshed = { ...desired, blocks };
    for (const other of journal.otherCanvases ?? []) {
      const currentOther = await this.context.files.readJson<StoredCanvas>(this.context.files.canvasFile(other.id));
      other[state] = { ...other[state], blocks: other[state].blocks.map(block => {
        const previous = currentOther.blocks.find(item => item.id === block.id)!;
        const restored = changedJevStamp({ ...previous, content: '' }, { ...block, content: '' }, { mutationId: block.jevMutationId ?? '', managed: true });
        return storedBlock({ ...restored, jevOwnership: block.jevOwnership, jevMutationId: block.jevMutationId });
      }) };
    }
    const currentTasks = await this.readTasks(journal.canvasId).catch(error => {
      if (!['EISDIR', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      return journal[`${state}Tasks`];
    });
    journal[`${state}Tasks`] = journal[`${state}Tasks`].map(task => {
      const previous = currentTasks.find(item => item.id === task.id);
      return previous && JSON.stringify(previous) !== JSON.stringify(task) ? { ...task, revision: Math.max(task.revision ?? 0, previous.revision ?? 0) + 1 } : task;
    });
    const reserved = current.blocks.map(block => block.id === keeper.id ? { ...block,
      sourceGeneration: blocks.find(item => item.id === keeper.id)!.sourceGeneration,
      metadataRevision: blocks.find(item => item.id === keeper.id)!.metadataRevision } : block);
    const reservation = { ...current, blocks: reserved.map(storedBlock) };
    journal.recoveryCanvases = [...journal.recoveryCanvases ?? [], reservation];
    // Restoration must also work when the original failure obstructed the journal.
    // The transaction retries its durable journal after completing this checked rollback.
    try { await atomicJson(this.context.files.mergeFile(journal.mergeId), journal, 0o600); }
    catch {
      // Finish the checked rollback using the prepared journal; the transaction retries persistence below.
      console.warn('Merge rollback is using its saved preparation because the recovery journal could not be updated.');
    }
    await atomicJson(this.context.files.canvasFile(journal.canvasId), reservation);
    await this.context.files.versionFile(journal.keepBlockId).commit(content, message, actor);
    await durableDocument(this.context.files.docFile(keeper.file), content);
    journal[`${state}Canvas`] = refreshed;
    await this.writeMergeState(journal, state, actor);
    this.context.saved?.({ workspaceId: current.workspaceId, canvasId: current.id, blockIds: [keeper.id], kind: 'source', actor });
  }

  async undoMerge(mergeId: string, actor = 'api'): Promise<{ mergeId: string; reverted: true }> {
    if (!/^[a-f0-9-]{36}$/.test(mergeId)) throw new ApiError(400, 'Invalid merge ID');
    return this.context.files.serialize(() => this.revertMerge(mergeId, actor));
  }

  private async readMerge(mergeId: string): Promise<MergeRecoveryJournal> {
    try { return await this.context.files.readJson<MergeRecoveryJournal>(this.context.files.mergeFile(mergeId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Merge not found');
      throw error;
    }
  }

  private async unchangedMerge(journal: MergeJournal): Promise<StoredBlock> {
    const current = await this.context.files.readJson<StoredCanvas>(this.context.files.canvasFile(journal.canvasId));
    const tasks = await this.readTasks(journal.canvasId);
    const keeper = current.blocks.find(block => block.id === journal.keepBlockId);
    const content = keeper ? await readFile(this.context.files.docFile(keeper.file), 'utf8') : undefined;
    if (JSON.stringify(current) !== JSON.stringify(journal.afterCanvas) || JSON.stringify(tasks) !== JSON.stringify(journal.afterTasks) ||
      content !== journal.afterContent) throw new ApiError(409, 'Documents changed since the merge');
    return keeper!;
  }

  private async checkOtherCanvases(journal: MergeJournal): Promise<void> {
    for (const other of journal.otherCanvases ?? []) {
      const current = await this.context.files.readJson<StoredCanvas>(this.context.files.canvasFile(other.id));
      if (JSON.stringify(current) !== JSON.stringify(other.after)) throw new ApiError(409, 'Cross-canvas links changed since the merge');
    }
  }

  private async revertMerge(mergeId: string, actor: string): Promise<{ mergeId: string; reverted: true }> {
    const journal = await this.readMerge(mergeId);
    if (journal.undone) throw new ApiError(409, 'Merge already undone');
    const keeper = await this.checkedUndo(journal);
    this.context.locks.check(journal.canvasId, journal.keepBlockId, actor);
    await mergeTransaction(this.context.files, journal, async () => {
      await this.restoreMerge(journal, keeper, 'before', 'Undo merge', actor);
    }, () => this.restoreMerge(journal, keeper, 'after', 'Rollback failed Undo merge', actor), 'undo');
    return { mergeId, reverted: true };
  }

  private async checkedUndo(journal: MergeRecoveryJournal): Promise<StoredBlock> {
    if (journal.recovery) return recoverableMerge(this.context.files, journal, await this.readTasks(journal.canvasId));
    const keeper = await this.unchangedMerge(journal);
    await this.checkOtherCanvases(journal);
    return keeper;
  }
}
