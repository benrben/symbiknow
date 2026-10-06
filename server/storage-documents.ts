import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { CanvasBlock, CanvasDocument, CanvasTask, DocumentLock, LinkRelation } from '../shared/types.js';
import { loaderFor } from '../shared/file-transfer.js';
import { DocumentVersions } from './version-control.js';
import { ApiError } from './errors.js';
import { blockStateHash } from './block-state.js';
import { checkBlockStateHashes } from './storage-state.js';
import { movedCanvasDocuments, movedDocumentTasks } from './document-moves.js';
import { moveSnapshot } from './document-move-snapshots.js';
import { changedDocumentSnapshot, documentWriteSnapshot } from './document-write-snapshots.js';
import { atomicJson, durableDocument } from './storage-files.js';
import { changedJevStamp, initializeJevStamp } from './jev/stamps.js';
import { stampedMove } from './jev/move-stamps.js';
import { contentHash, storedBlock, validId } from './storage-shapes.js';
import { blockKind, checkExpectedHash, contentText, coordinate, freeBlockPosition, optionalGroup, optionalLabel, optionalTags, protectedChange, requiredText, updatedBlock, validLinks, validPositions } from './storage-validation.js';
import type { StorageContext } from './storage-context.js';
import type { BlockDeletionPreconditions } from '../shared/document-state.js';
import { checkCrossCanvasDeletionReferences, checkDeletionPreconditions, checkReviewedDocumentState, checkSavedCrossLinkState } from './document-deletion.js';

type InsightLink = { type: 'link' | 'unlink'; fromBlockId: string; toBlockId: string; relation?: LinkRelation };

function creationMetadata(input: Record<string, unknown>) {
  const group = optionalGroup(input.group, undefined);
  const tags = optionalTags(input.tags, undefined);
  const purpose = optionalLabel(input.purpose, 'purpose', undefined);
  const workArea = optionalLabel(input.workArea, 'workArea', undefined);
  return { ...(group ? { group } : {}), ...(tags ? { tags } : {}),
    ...(purpose ? { purpose } : {}), ...(workArea ? { workArea } : {}) };
}

function checkExpectedState(value: unknown, previous: CanvasBlock): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value !== blockStateHash(previous)) {
    throw new ApiError(409, 'The document changed since this suggestion was reviewed');
  }
}

function crossTargetVersion(value: unknown): { canvasId: string; blockId: string; hash: string } {
  const expected = value as { canvasId?: unknown; blockId?: unknown; hash?: unknown };
  if (!expected || typeof expected.canvasId !== 'string' || typeof expected.blockId !== 'string' || typeof expected.hash !== 'string') {
    throw new ApiError(400, 'Invalid cross-canvas source version');
  }
  return expected as { canvasId: string; blockId: string; hash: string };
}

function editMessage(value: unknown, title: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : `Edit ${title}`;
}

function blockWithLock(block: CanvasBlock, lock: DocumentLock | undefined): CanvasBlock {
  const result: CanvasBlock = { ...block, contentHash: contentHash(block.content) };
  if (lock) result.lock = lock;
  else delete result.lock;
  return result;
}

function linkedBlock(canvas: CanvasDocument, id: string): CanvasBlock {
  const block = canvas.blocks.find(item => item.id === id);
  if (!block || block.archived) throw new ApiError(404, 'A linked document no longer exists');
  return block;
}

function supersedes(action: InsightLink): boolean {
  return action.type === 'link' && action.relation === 'supersedes';
}

function changedInsightSource(source: CanvasBlock, target: CanvasBlock, action: InsightLink, blocks: CanvasBlock[]): CanvasBlock {
  const links = action.type === 'unlink' ? source.links.filter(id => id !== target.id) : [...new Set([...source.links, target.id])];
  const linkTypes = { ...source.linkTypes };
  if (action.type === 'unlink') delete linkTypes[target.id];
  else if (action.relation) linkTypes[target.id] = action.relation;
  return updatedBlock(source, { links, linkTypes }, blocks);
}

function hasTypedReference(block: CanvasBlock, blockId: string): boolean {
  return Object.hasOwn(block.linkTypes ?? {}, blockId);
}
function withoutDeletedReference(block: CanvasBlock, blockId: string): CanvasBlock {
  if (!block.links.includes(blockId) && !hasTypedReference(block, blockId)) return block;
  const links = block.links.filter(id => id !== blockId);
  if (!block.linkTypes || !Object.hasOwn(block.linkTypes, blockId)) return changedJevStamp(block, { ...block, links });
  const linkTypes = { ...block.linkTypes };
  delete linkTypes[blockId];
  return changedJevStamp(block, { ...block, links, linkTypes: Object.keys(linkTypes).length ? linkTypes : undefined });
}

export class StorageDocuments {
  constructor(private readonly context: StorageContext) {}

  async createBlock(canvasId: string, input: Record<string, unknown>, actor = 'api'): Promise<CanvasBlock> {
    const title = requiredText(input.title, 'title');
    const content = contentText(input.content ?? `# ${title}\n`);
    const kind = loaderFor(blockKind(input.kind), content);
    const origin = { x: coordinate(input.x, 'x', 100), y: coordinate(input.y, 'y', 100) };
    const metadata = creationMetadata(input);
    const key = input.idempotencyKey;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 128)) {
      throw new ApiError(400, 'idempotencyKey must be a nonempty string of at most 128 characters');
    }
    return this.context.files.serialize(async () => {
      const canvas = await this.context.getCanvas(canvasId, true);
      const id = key === undefined ? randomUUID()
        : 'imp-' + createHash('sha256').update(`${canvasId}\0${key}`).digest('hex').slice(0, 32);
      const existing = canvas.blocks.find(block => block.id === id);
      if (existing) {
        if (existing.title !== title || existing.content !== content || existing.kind !== kind) {
          throw new ApiError(409, 'This idempotency key already belongs to a different document');
        }
        return blockWithLock(existing, this.context.locks.active(canvasId, id));
      }
      const links = input.links ?? [];
      if (!validLinks(links, id, canvas.blocks)) throw new ApiError(400, 'links must contain existing block IDs on this canvas');
      const position = freeBlockPosition(canvas.blocks, origin);
      const block = initializeJevStamp({ id, title, kind, content, ...position, width: 400, height: 320, links: links as string[], file: `docs/${id}.md`,
        ...metadata });
      const snapshot = await documentWriteSnapshot(this.context.files, { ...canvas, blocks: [...canvas.blocks, block] });
      await durableDocument(this.context.files.docFile(block.file), content);
      await atomicJson(this.context.files.canvasFile(canvasId), { ...snapshot, blocks: snapshot.blocks.map(storedBlock) });
      const versions = this.context.files.versionFile(id);
      await versions.init('');
      await versions.commit(content, `Create ${title}`, actor);
      this.context.saved?.({ workspaceId: canvas.workspaceId, canvasId, blockIds: [id], kind: 'source', actor });
      return { ...block, contentHash: contentHash(content) };
    });
  }

  async updateBlock(canvasId: string, blockId: string, input: Record<string, unknown>, actor = 'api'): Promise<CanvasBlock> {
    if (!validId(blockId)) throw new ApiError(400, 'Invalid block ID');
    return this.context.files.serialize(async () => {
      const canvas = await this.context.getCanvas(canvasId, true);
      const previous = canvas.blocks.find(item => item.id === blockId);
      if (!previous) throw new ApiError(404, 'Block not found');
      if (protectedChange(input)) this.context.locks.check(canvasId, blockId, actor);
      checkExpectedHash(input, previous.content);
      checkExpectedState(input.expectedStateHash, previous);
      checkReviewedDocumentState(previous, input.expectedDocumentState);
      await this.checkCrossTarget(input.expectedCrossTargetState);
      const updated = changedJevStamp(previous, updatedBlock(previous, input, canvas.blocks));
      await this.checkCrossLinks(canvas, input, updated);
      const snapshot = await documentWriteSnapshot(this.context.files, canvas);
      checkSavedCrossLinkState(snapshot.blocks.find(item => item.id === blockId)!, input.expectedSavedCrossLinks);
      const changed = changedDocumentSnapshot(snapshot, updated, input);
      if (updated.sourceGeneration !== previous.sourceGeneration) {
        const reserved = snapshot.blocks.map(block => block.id === blockId ? { ...block, incarnation: updated.incarnation,
          sourceGeneration: updated.sourceGeneration, metadataRevision: updated.metadataRevision } : block);
        await atomicJson(this.context.files.canvasFile(canvasId), { ...snapshot, blocks: reserved.map(storedBlock) });
      }
      await this.commitContent(previous, updated, input, actor);
      await atomicJson(this.context.files.canvasFile(canvasId), { ...changed, blocks: changed.blocks.map(storedBlock) });
      if (updated.sourceGeneration !== previous.sourceGeneration) {
        this.context.saved?.({ workspaceId: canvas.workspaceId, canvasId, blockIds: [blockId], kind: 'source', actor });
      }
      return blockWithLock(updated, this.context.locks.active(canvasId, blockId));
    });
  }

  private async checkCrossTarget(value: unknown): Promise<void> {
    if (value === undefined) return;
    const expected = crossTargetVersion(value);
    const target = await this.context.getCanvas(expected.canvasId, true);
    const block = target.blocks.find(item => item.id === expected.blockId);
    if (!block || blockStateHash(block) !== expected.hash) {
      throw new ApiError(409, 'The linked document changed since this suggestion was reviewed');
    }
  }

  private async checkCrossLinks(canvas: CanvasDocument, input: Record<string, unknown>, updated: CanvasBlock): Promise<void> {
    if (input.crossLinks === undefined) return;
    const links = updated.crossLinks ?? [];
    const existing = await this.context.files.existingCrossLinks(canvas.workspaceId, canvas.id, links);
    if (existing.length !== links.length) throw new ApiError(400, 'Cross links must target existing documents in this workspace');
  }

  private async commitContent(previous: CanvasBlock, updated: CanvasBlock, input: Record<string, unknown>, actor: string): Promise<void> {
    if (input.content === undefined || updated.content === previous.content) return;
    const versions = this.context.files.versionFile(previous.id);
    await versions.init(previous.content);
    await versions.commit(updated.content, editMessage(input.message, updated.title), actor);
    await durableDocument(this.context.files.docFile(previous.file), updated.content);
  }

  /** Apply a link and its superseded marker in one serialized canvas write. */
  async updateInsightLink(canvasId: string,
    action: { type: 'link' | 'unlink'; fromBlockId: string; toBlockId: string; relation?: LinkRelation },
    actor: string, expectedStateHashes?: Record<string, string>): Promise<void> {
    await this.context.files.serialize(async () => {
      const canvas = await this.context.getCanvas(canvasId, true);
      const source = linkedBlock(canvas, action.fromBlockId);
      const target = linkedBlock(canvas, action.toBlockId);
      checkBlockStateHashes(canvas.blocks, expectedStateHashes, 'A linked document changed since review');
      this.context.locks.check(canvasId, source.id, actor);
      if (supersedes(action)) this.context.locks.check(canvasId, target.id, actor);
      const updated = changedJevStamp(source, changedInsightSource(source, target, action, canvas.blocks));
      const superseded = supersedes(action) ? changedJevStamp(target, updatedBlock(target, { stale: true }, canvas.blocks)) : target;
      const replacements = new Map([[target.id, superseded], [source.id, updated]]);
      const blocks = canvas.blocks.map(block => replacements.get(block.id) ?? block);
      const snapshot = await documentWriteSnapshot(this.context.files, { ...canvas, blocks });
      await atomicJson(this.context.files.canvasFile(canvasId), { ...snapshot, blocks: snapshot.blocks.map(storedBlock) });
    });
  }

  async moveBlockToCanvas(canvasId: string, blockId: string, targetCanvasId: string, actor = 'api', expectedStateHash?: string):
    Promise<{ fromCanvasId: string; toCanvasId: string; blockId: string }> {
    if (!validId(blockId) || !validId(targetCanvasId) || canvasId === targetCanvasId) throw new ApiError(400, 'Choose another canvas in this workspace');
    return this.context.files.serialize(async () => {
      const source = await this.context.getCanvas(canvasId, true);
      const target = await this.context.getCanvas(targetCanvasId, true);
      if (source.workspaceId !== target.workspaceId) throw new ApiError(400, 'Documents can move only within one workspace');
      const block = source.blocks.find(item => item.id === blockId);
      if (!block || block.archived) throw new ApiError(404, 'Document not found');
      if (expectedStateHash && blockStateHash(block) !== expectedStateHash) throw new ApiError(409, 'Document changed since review');
      this.context.locks.check(canvasId, blockId, actor);
      const workspace = (await this.context.listWorkspaces()).find(item => item.id === source.workspaceId)!;
      const before = await Promise.all(workspace.canvases.map(async item =>
        moveSnapshot(this.context.files, await this.context.getCanvas(item.id, true))));
      const savedBlock = before.find(canvas => canvas.id === canvasId)!.blocks.find(item => item.id === blockId)!;
      const moved = { ...initializeJevStamp(savedBlock), ...freeBlockPosition(target.blocks, { x: 100, y: 100 }) };
      const after = stampedMove(before, movedCanvasDocuments(before, canvasId, targetCanvasId, moved), canvasId, targetCanvasId, blockId);
      const sourceTasks = await this.context.listTasks(canvasId);
      const targetTasks = await this.context.listTasks(targetCanvasId);
      const tasks = movedDocumentTasks(sourceTasks, targetTasks, blockId,
        after.find(item => item.id === targetCanvasId)!, actor);
      await this.persistDocumentMove(before, after, canvasId, targetCanvasId, sourceTasks, targetTasks, tasks, actor);
      this.context.locks.move(canvasId, targetCanvasId, blockId);
      this.context.saved?.({ workspaceId: source.workspaceId, canvasId: targetCanvasId, blockIds: [blockId], kind: 'move', actor });
      return { fromCanvasId: canvasId, toCanvasId: targetCanvasId, blockId };
    });
  }

  private async persistDocumentMove(before: CanvasDocument[], after: CanvasDocument[], sourceId: string,
    targetId: string, sourceTasks: CanvasTask[], targetTasks: CanvasTask[], tasks: { source: CanvasTask[]; target: CanvasTask[] }, actor: string): Promise<void> {
    try {
      for (const canvas of after) await atomicJson(this.context.files.canvasFile(canvas.id), { ...canvas, blocks: canvas.blocks.map(storedBlock) });
      await this.context.writeTaskSnapshot(sourceId, sourceTasks, tasks.source, actor);
      await this.context.writeTaskSnapshot(targetId, targetTasks, tasks.target, actor);
    } catch (error) {
      for (const canvas of before) await atomicJson(this.context.files.canvasFile(canvas.id), { ...canvas, blocks: canvas.blocks.map(storedBlock) });
      await this.context.writeTaskSnapshot(sourceId, await this.context.listTasks(sourceId), sourceTasks, `${actor} (rollback)`);
      await this.context.writeTaskSnapshot(targetId, await this.context.listTasks(targetId), targetTasks, `${actor} (rollback)`);
      throw error;
    }
  }

  async updateLayout(canvasId: string, positions: unknown, expectedStateHashes?: Record<string, string>): Promise<CanvasDocument> {
    const updates = validPositions(positions);
    return this.context.files.serialize(async () => {
      const canvas = await this.context.getCanvas(canvasId, true);
      checkBlockStateHashes(canvas.blocks, expectedStateHashes, 'Canvas changed since layout review');
      const known = new Set(canvas.blocks.map(block => block.id));
      if (updates.some(item => !known.has(item.blockId))) throw new ApiError(404, 'Layout includes an unknown block');
      const byId = new Map(updates.map(item => [item.blockId, item]));
      const blocks = canvas.blocks.map(block => {
        const update = byId.get(block.id);
        if (!update) return block;
        const group = update.group === undefined ? block.group : update.group ?? undefined;
        const moved = changedJevStamp(block, { ...block, x: update.x, y: update.y, group });
        if (!group) delete moved.group;
        return moved;
      });
      const snapshot = await documentWriteSnapshot(this.context.files, { ...canvas, blocks });
      await atomicJson(this.context.files.canvasFile(canvasId), { ...snapshot, blocks: snapshot.blocks.map(storedBlock) });
      return { ...canvas, blocks };
    });
  }

  async deleteBlock(canvasId: string, blockId: string, actor = 'api', preconditions?: BlockDeletionPreconditions): Promise<void> {
    if (!validId(blockId)) throw new ApiError(400, 'Invalid block ID');
    await this.context.files.serialize(async () => {
      const canvas = await this.context.getCanvas(canvasId, true);
      const block = canvas.blocks.find(item => item.id === blockId);
      if (!block) throw new ApiError(404, 'Block not found');
      this.context.locks.check(canvasId, blockId, actor);
      checkDeletionPreconditions(canvas, block, preconditions);
      await checkCrossCanvasDeletionReferences(this.context, canvas, block, preconditions?.requireUnreferenced);
      const snapshot = await documentWriteSnapshot(this.context.files, canvas);
      checkSavedCrossLinkState(snapshot.blocks.find(item => item.id === blockId)!, preconditions?.expectedSavedCrossLinks);
      const remaining = snapshot.blocks.filter(item => item.id !== blockId).map(item => withoutDeletedReference(item, blockId));
      const versions = this.context.files.versionFile(blockId);
      await versions.init(block.content);
      await versions.recordDeletion(`Delete ${block.title} from canvas ${canvas.name}`, actor);
      await atomicJson(this.context.files.canvasFile(canvasId), { ...snapshot, blocks: remaining.map(storedBlock) });
      await rm(this.context.files.docFile(block.file));
      this.context.locks.forget(canvasId, blockId);
      this.context.saved?.({ workspaceId: canvas.workspaceId, canvasId, blockIds: [blockId], kind: 'delete', actor });
    });
  }

  async lockBlock(canvasId: string, blockId: string, actor: string, input: Record<string, unknown>): Promise<DocumentLock> {
    await this.requireBlock(canvasId, blockId);
    return this.context.locks.acquire(canvasId, blockId, actor, input);
  }

  async unlockBlock(canvasId: string, blockId: string, actor: string, force: boolean): Promise<void> {
    await this.requireBlock(canvasId, blockId);
    this.context.locks.release(canvasId, blockId, actor, force);
  }

  private async requireBlock(canvasId: string, blockId: string): Promise<CanvasBlock> {
    if (!validId(blockId)) throw new ApiError(400, 'Invalid block ID');
    const block = (await this.context.getCanvas(canvasId, true)).blocks.find(item => item.id === blockId);
    if (!block) throw new ApiError(404, 'Block not found');
    return block;
  }

  private async documentVersions(canvasId: string, blockId: string): Promise<{ versions: DocumentVersions; block: CanvasBlock }> {
    const block = await this.requireBlock(canvasId, blockId);
    const versions = this.context.files.versionFile(blockId);
    await versions.init(block.content);
    return { versions, block };
  }

  async documentHistory(canvasId: string, blockId: string, options?: { limit?: number; cursor?: number }) {
    const block = await this.requireBlock(canvasId, blockId);
    const versions = this.context.files.versionFile(blockId);
    // Reading history must not wait behind queued writes (Reflex batches can hold the queue for a long time).
    // Only a missing repository or an outside edit to import needs the write queue.
    if (await versions.matches(block.content)) return versions.status(options);
    return this.context.files.serialize(async () => (await this.documentVersions(canvasId, blockId)).versions.status(options));
  }

  async readDocumentBranch(canvasId: string, blockId: string, branch: string) {
    const block = await this.requireBlock(canvasId, blockId);
    const versions = this.context.files.versionFile(blockId);
    await versions.init(block.content);
    const source = await versions.branchContent(branch);
    return { ...block, content: source.content, contentHash: contentHash(source.content),
      branch, revision: source.revision };
  }

  async editDocumentBranch(canvasId: string, blockId: string, branch: string, input: Record<string, unknown>, actor: string) {
    if (input.content === undefined || Object.keys(input).some(key => !['content', 'expectedContentHash', 'message'].includes(key))) {
      throw new ApiError(400, 'A branch edit changes only source content');
    }
    return this.context.files.serialize(async () => {
      this.context.locks.check(canvasId, blockId, actor);
      const block = await this.requireBlock(canvasId, blockId);
      const versions = this.context.files.versionFile(blockId);
      await versions.init(block.content);
      const before = await versions.branchContent(branch);
      if (typeof input.expectedContentHash !== 'string' || input.expectedContentHash !== contentHash(before.content)) {
        const currentContentHash = contentHash(before.content);
        throw new ApiError(409, `This branch changed since you read it. Current contentHash: ${currentContentHash}`,
          { currentContentHash });
      }
      const content = contentText(input.content);
      const after = await versions.commitBranch(branch, content, editMessage(input.message, block.title), actor);
      return { ...block, content: after.content, contentHash: contentHash(after.content),
        branch, revision: after.revision };
    });
  }

  async deleteDocumentBranch(canvasId: string, blockId: string, branch: string, actor: string) {
    return this.context.files.serialize(async () => {
      this.context.locks.check(canvasId, blockId, actor);
      return (await this.documentVersions(canvasId, blockId)).versions.deleteBranch(branch);
    });
  }

  async previewDocumentVersion(canvasId: string, blockId: string, kind: 'switch' | 'merge' | 'restore', target: string) {
    return this.context.files.serialize(async () => (await this.documentVersions(canvasId, blockId)).versions.preview(kind, target));
  }

  async createDocumentBranch(canvasId: string, blockId: string, name: string) {
    return this.context.files.serialize(async () => (await this.documentVersions(canvasId, blockId)).versions.createBranch(name));
  }

  private async changeDocumentVersion(canvasId: string, blockId: string, actor: string,
    change: (versions: DocumentVersions) => Promise<{ status: Awaited<ReturnType<DocumentVersions['status']>>; content: string }>) {
    return this.context.files.serialize(async () => {
      this.context.locks.check(canvasId, blockId, actor);
      const { versions, block } = await this.documentVersions(canvasId, blockId);
      const canvas = await this.context.getCanvas(canvasId, true);
      const stamped = changedJevStamp(block, block, undefined, true);
      const snapshot = await documentWriteSnapshot(this.context.files, canvas);
      const reserved = snapshot.blocks.map(item => item.id === blockId ? stamped : item);
      await atomicJson(this.context.files.canvasFile(canvasId), { ...snapshot, blocks: reserved.map(storedBlock) });
      const { status, content } = await change(versions);
      await durableDocument(this.context.files.docFile(block.file), content);
      this.context.saved?.({ workspaceId: canvas.workspaceId, canvasId, blockIds: [blockId], kind: 'source', actor });
      return status;
    });
  }

  async switchDocumentBranch(canvasId: string, blockId: string, name: string, actor = 'api') {
    return this.changeDocumentVersion(canvasId, blockId, actor, versions => versions.switchBranch(name));
  }

  async mergeDocumentBranch(canvasId: string, blockId: string, name: string, actor = 'api') {
    return this.changeDocumentVersion(canvasId, blockId, actor, versions => versions.mergeBranch(name, actor));
  }

  async restoreDocumentRevision(canvasId: string, blockId: string, revision: string, actor = 'api') {
    return this.changeDocumentVersion(canvasId, blockId, actor, versions => versions.restoreRevision(revision, actor));
  }
}
