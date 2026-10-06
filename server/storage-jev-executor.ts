import type { CanvasBlock, CanvasDocument, CanvasTask } from '../shared/types.js';
import type { JevMutation, JevOwnership, JevSourceSnapshot } from '../shared/jev-types.js';
import type { StorageContext } from './storage-context.js';
import type { StoredCanvas } from './storage-shapes.js';
import { canvasData, storedBlock, validId } from './storage-shapes.js';
import { atomicJson, durableDocument } from './storage-files.js';
import { contentHash } from './storage-shapes.js';
import { readJevDraft, setJevDraftState } from './jev/drafts.js';
import { documentWriteSnapshot } from './document-write-snapshots.js';
import { updatedBlock } from './storage-validation.js';
import { StorageJevTasks } from './storage-jev-tasks.js';
import { changedJevStamp, checkJevSource, sourceSnapshot } from './jev/stamps.js';
import { ApiError } from './errors.js';
import { movedCanvasDocuments, movedDocumentTasks } from './document-moves.js';
import { moveSnapshot } from './document-move-snapshots.js';
import { stampedMove } from './jev/move-stamps.js';
import { restoredMoveTaskArtifact } from './jev/move-task-inverse.js';

export type JevArtifact = { kind: 'canvas'; id: string; before: StoredCanvas; after: StoredCanvas; reserved?: StoredCanvas }
  | { kind: 'tasks'; id: string; before: CanvasTask[]; after: CanvasTask[]; auditActor?: string }
  | { kind: 'content'; id: string; file: string; before: string; after: string };
export interface JevCanonicalPreparation {
  before: JevMutation;
  after: JevMutation;
  artifacts: JevArtifact[];
  ownershipBefore?: JevOwnership;
}
export interface JevCanonicalResult extends JevCanonicalPreparation { sourcesAfter: JevSourceSnapshot[] }
const documentFields = ['group', 'tags', 'purpose', 'reviewer', 'quality', 'stale', 'archived', 'links', 'linkTypes', 'crossLinks', 'headline', 'freshness', 'processingExcluded'];

function requireBlock(canvas: CanvasDocument, blockId: string): CanvasBlock {
  const block = canvas.blocks.find(item => item.id === blockId);
  if (!block) throw new ApiError(404, 'Document not found');
  return block;
}

function recoveredCanvasId(mutation: Extract<JevMutation, { kind: 'content' | 'move' }>): string {
  return mutation.kind === 'move' ? mutation.targetCanvasId : mutation.canvasId;
}

function canvasArtifact(before: CanvasDocument, after: CanvasDocument): JevArtifact {
  return { kind: 'canvas', id: before.id,
    before: { ...canvasData(before), blocks: before.blocks.map(storedBlock) }, after: { ...canvasData(after), blocks: after.blocks.map(storedBlock) } };
}

export class StorageJevExecutor {
  constructor(private readonly context: StorageContext) {}
  serialized<T>(operation: () => Promise<T>): Promise<T> { return this.context.files.serialize(operation); }

  async checkSources(sources: JevSourceSnapshot[]): Promise<void> {
    const canvases = new Map<string, CanvasDocument>();
    for (const source of sources) {
      let canvas = canvases.get(source.canvasId);
      if (!canvas) {
        canvas = await this.context.getCanvas(source.canvasId, true);
        canvases.set(source.canvasId, canvas);
      }
      if (canvas.workspaceId !== source.workspaceId) throw new ApiError(404, 'Source scope not found');
      checkJevSource(requireBlock(canvas, source.blockId), source);
    }
  }

  async execute(mutation: JevMutation, sources: JevSourceSnapshot[], id: string, actor: string, managed: boolean,
    prepare: (value: JevCanonicalPreparation) => Promise<void>, restoreOwnership?: JevOwnership, internalUndo = false,
    moveTaskArtifacts?: JevArtifact[]): Promise<JevCanonicalResult> {
    return this.context.files.serialize(async () => {
      await this.checkSources(sources);
      const plan = await this.plan(mutation, id, actor, managed, restoreOwnership, internalUndo, moveTaskArtifacts);
      for (const artifact of plan.artifacts) if (artifact.kind === 'tasks') artifact.auditActor = actor;
      await prepare(plan);
      if (mutation.kind === 'content') {
        const canvas = await this.context.getCanvas(mutation.canvasId, true);
        const block = requireBlock(canvas, mutation.blockId);
        const artifact = plan.artifacts.find(item => item.kind === 'canvas' && item.id === canvas.id) as Extract<JevArtifact, { kind: 'canvas' }>;
        await atomicJson(this.context.files.canvasFile(canvas.id), artifact.reserved);
        await this.context.files.versionFile(block.id).init(block.content);
        await this.context.files.versionFile(block.id).commit(mutation.content, 'Apply reviewed agent draft', actor);
      }
      for (const artifact of plan.artifacts) await this.writeArtifact(artifact, 'after', actor);
      if (mutation.kind === 'move') this.context.locks.move(mutation.canvasId, mutation.targetCanvasId, mutation.blockId);
      if (mutation.kind === 'content') {
        await setJevDraftState(this.context.files.root, mutation.canvasId, mutation.blockId, mutation.draftId, 'applied');
        const canvas = await this.context.getCanvas(mutation.canvasId, true);
        this.context.saved?.({ workspaceId: canvas.workspaceId, canvasId: canvas.id, blockIds: [mutation.blockId], kind: 'source', actor });
      }
      const sourcesAfter = await this.snapshotsAfter(sources, mutation);
      return { ...plan, sourcesAfter };
    });
  }

  private async plan(mutation: JevMutation, id: string, actor: string, managed: boolean, restoreOwnership?: JevOwnership, internalUndo = false,
    moveTaskArtifacts?: JevArtifact[]): Promise<JevCanonicalPreparation> {
    if (mutation.kind === 'document') return this.documentPlan(mutation, id, managed, restoreOwnership);
    if (mutation.kind === 'move') return this.movePlan(mutation, id, actor, internalUndo, moveTaskArtifacts);
    if (mutation.kind === 'content') return this.contentPlan(mutation, id, actor, internalUndo);
    if (['task_create', 'task_update', 'task_delete'].includes(mutation.kind)) return new StorageJevTasks(this.context).plan(mutation, id, actor, internalUndo);
    throw new ApiError(400, 'This mutation is not a canonical store operation');
  }

  private async checkDraft(canvas: CanvasDocument, block: CanvasBlock, mutation: Extract<JevMutation, {kind:'content'}>, internalUndo: boolean): Promise<void> {
    if (internalUndo) return;
    const draft = await readJevDraft(this.context.files.root, canvas.id, block.id);
    if (!draft || !this.matchesDraft(draft, block, mutation)) throw new ApiError(409, 'The current draft requires complete review and approval');
  }

  private matchesDraft(draft: NonNullable<Awaited<ReturnType<typeof readJevDraft>>>, block: CanvasBlock, mutation: Extract<JevMutation, {kind:'content'}>): boolean {
    return draft.id === mutation.draftId && draft.state === 'ready'
      && draft.proposedContent === mutation.content && draft.baseContent === block.content
      && Date.parse(draft.expiresAt) > Date.now();
  }

  private async contentPlan(mutation: Extract<JevMutation, { kind: 'content' }>, id: string, actor: string, internalUndo: boolean): Promise<JevCanonicalPreparation> {
    const canvas = await documentWriteSnapshot(this.context.files, await this.context.getCanvas(mutation.canvasId, true));
    const block = requireBlock(canvas, mutation.blockId);
    this.context.locks.check(canvas.id, block.id, actor);
    if (contentHash(block.content) !== mutation.expectedContentHash) throw new ApiError(409, 'The reviewed draft needs rebase');
    await this.checkDraft(canvas, block, mutation, internalUndo);
    const changed = changedJevStamp(block, { ...block, content: mutation.content }, { mutationId: id }, true);
    const after = { ...canvas, blocks: canvas.blocks.map(item => item.id === block.id ? changed : item) };
    const artifact = canvasArtifact(canvas, after) as Extract<JevArtifact, { kind: 'canvas' }>;
    artifact.reserved = { ...artifact.before, blocks: artifact.before.blocks.map(item => item.id === block.id ? { ...item,
      sourceGeneration: changed.sourceGeneration, metadataRevision: changed.metadataRevision } : item) };
    return { before: { ...mutation, content: block.content, expectedContentHash: contentHash(mutation.content), draftId: `undo:${id}` },
      after: mutation, artifacts: [{ kind: 'content', id: block.id, file: block.file, before: block.content, after: mutation.content },
        artifact], ownershipBefore: block.jevOwnership };
  }

  private reviewedDocument(canvas: CanvasDocument, previous: CanvasBlock, mutation: Extract<JevMutation, {kind:'document'}>): CanvasBlock {
    const patch: Record<string, unknown> = { ...mutation.patch };
    if (patch.crossLinks === null) patch.crossLinks = [];
    if (patch.tags === null) patch.tags = [];
    if (patch.quality === null) delete patch.quality;
    const validated = updatedBlock(previous, patch, canvas.blocks);
    if (mutation.patch.quality === null) delete validated.quality;
    if (mutation.patch.tags === null) delete validated.tags;
    return validated;
  }

  private async documentPlan(mutation: Extract<JevMutation, { kind: 'document' }>, id: string, managed: boolean,
    restoreOwnership?: JevOwnership): Promise<JevCanonicalPreparation> {
    if (Object.keys(mutation.patch).some(key => !documentFields.includes(key))) throw new ApiError(400, 'Unsupported Jev metadata field');
    const canvas = await documentWriteSnapshot(this.context.files, await this.context.getCanvas(mutation.canvasId, true));
    const previous = requireBlock(canvas, mutation.blockId);
    const validated = this.reviewedDocument(canvas, previous, mutation);
    let updated = changedJevStamp(previous, validated, { mutationId: id, managed, canvasId: canvas.id });
    if (restoreOwnership) updated = { ...updated, jevOwnership: restoreOwnership,
      metadataRevision: updated.metadataRevision! + Number(JSON.stringify(previous.jevOwnership) !== JSON.stringify(restoreOwnership)
        && updated.metadataRevision === previous.metadataRevision) };
    if (mutation.patch.crossLinks) {
      const targets = await this.context.files.existingCrossLinks(canvas.workspaceId, canvas.id, mutation.patch.crossLinks);
      if (targets.length !== mutation.patch.crossLinks.length) throw new ApiError(409, 'A linked source is unavailable');
    }
    const inverse = Object.fromEntries(Object.keys(mutation.patch).map(key => [key, previous[key as keyof CanvasBlock] ?? null]));
    const after = { ...canvas, blocks: canvas.blocks.map(block => block.id === mutation.blockId ? updated : block) };
    return { before: { ...mutation, patch: inverse }, after: mutation,
      artifacts: [canvasArtifact(canvas, after)], ownershipBefore: previous.jevOwnership };
  }

  private async movePlan(mutation: Extract<JevMutation, { kind: 'move' }>, id: string, actor: string, internalUndo: boolean,
    moveTaskArtifacts?: JevArtifact[]): Promise<JevCanonicalPreparation> {
    const source = await this.context.getCanvas(mutation.canvasId, true);
    const target = await this.context.getCanvas(mutation.targetCanvasId, true);
    if (source.workspaceId !== target.workspaceId) throw new ApiError(400, 'Move must stay in the same workspace');
    this.context.locks.check(source.id, mutation.blockId, actor);
    const workspace = (await this.context.listWorkspaces()).find(item => item.id === source.workspaceId)!;
    const before = await Promise.all(workspace.canvases.map(item => this.context.getCanvas(item.id, true).then(canvas => moveSnapshot(this.context.files, canvas))));
    const block = requireBlock(source, mutation.blockId);
    const moved = { ...block };
    const after = stampedMove(before, movedCanvasDocuments(before, source.id, target.id, moved), source.id, target.id, block.id, id);
    const sourceTasks = await this.context.listTasks(source.id);
    const targetTasks = await this.context.listTasks(target.id);
    const artifacts = before.map(canvas => canvasArtifact(canvas, after.find(item => item.id === canvas.id)!));
    artifacts.push(...this.moveTasks(sourceTasks, targetTasks, block.id, after.find(canvas => canvas.id === target.id)!,
      source.id, id, actor, internalUndo, moveTaskArtifacts));
    return { before: { ...mutation, canvasId: target.id, targetCanvasId: source.id }, after: mutation, artifacts };
  }

  private moveTasks(source: CanvasTask[], target: CanvasTask[], blockId: string, targetCanvas: CanvasDocument,
    sourceCanvasId: string, id: string, actor: string, internalUndo: boolean, artifacts?: JevArtifact[]): JevArtifact[] {
    if (internalUndo) return [restoredMoveTaskArtifact(source, artifacts, sourceCanvasId, id, actor),
      restoredMoveTaskArtifact(target, artifacts, targetCanvas.id, id, actor)];
    const tasks = movedDocumentTasks(source, target, blockId, targetCanvas, actor);
    return [{ kind: 'tasks', id: sourceCanvasId, before: source, after: tasks.source },
      { kind: 'tasks', id: targetCanvas.id, before: target, after: tasks.target }];
  }

  private async snapshotsAfter(sources: JevSourceSnapshot[], mutation: JevMutation): Promise<JevSourceSnapshot[]> {
    const canvases = new Map<string, Promise<CanvasDocument>>();
    return Promise.all(sources.map(async source => {
      const canvasId = mutation.kind === 'move' && source.blockId === mutation.blockId ? mutation.targetCanvasId : source.canvasId;
      let pending = canvases.get(canvasId);
      if (!pending) {
        pending = this.context.getCanvas(canvasId, true);
        canvases.set(canvasId, pending);
      }
      const canvas = await pending;
      return sourceSnapshot(canvas.workspaceId, canvasId, requireBlock(canvas, source.blockId));
    }));
  }

  private writeArtifact(artifact: JevArtifact, state: 'before' | 'after', actor = 'Symbi Reflex recovery'): Promise<void> {
    if (!validId(artifact.id)) throw new ApiError(503, 'Invalid recovery artifact');
    if (artifact.kind === 'content') {
      if (artifact.file !== `docs/${artifact.id}.md`) throw new ApiError(503, 'Invalid recovery document path');
      return durableDocument(this.context.files.docFile(artifact.file), artifact[state]);
    }
    if (artifact.kind === 'tasks') return this.context.writeTaskSnapshot(artifact.id,
      artifact[state === 'after' ? 'before' : 'after'], artifact[state], artifact.auditActor ?? actor);
    return atomicJson(this.context.files.canvasFile(artifact.id), artifact[state]);
  }

  private async currentArtifact(file: string): Promise<unknown> {
    try { return await this.context.files.readJson(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return []; }
  }

  private async checkArtifact(artifact: JevArtifact): Promise<void> {
    if (!validId(artifact.id)) throw new ApiError(503, 'Invalid recovery artifact');
    if (artifact.kind === 'content') {
      if (artifact.file !== `docs/${artifact.id}.md`) throw new ApiError(503, 'Invalid recovery document path');
      const content = await this.context.files.readDocument(artifact.file);
      if (content !== artifact.before && content !== artifact.after) throw new ApiError(503, 'Reviewed content recovery conflicts with a newer edit');
      return;
    }
    await this.checkJsonArtifact(artifact);
  }

  private async checkJsonArtifact(artifact: Exclude<JevArtifact, {kind: 'content'}>): Promise<void> {
    const file = artifact.kind === 'canvas' ? this.context.files.canvasFile(artifact.id) : this.context.files.tasksFile(artifact.id);
    const current = await this.currentArtifact(file);
    const known: unknown[] = [artifact.before, artifact.after];
    if (artifact.kind === 'canvas' && artifact.reserved) known.push(artifact.reserved);
    if (!known.some(value => JSON.stringify(current) === JSON.stringify(value))) throw new ApiError(503, 'Symbi Reflex recovery conflicts with a later change');
  }

  private async recoveredHistory(artifact: Extract<JevArtifact, {kind: 'content'}>): Promise<void> {
    const versions = this.context.files.versionFile(artifact.id);
    let current: string;
    try { current = await versions.content(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; current = artifact.before; }
    if (current !== artifact.before && current !== artifact.after) throw new ApiError(503, 'Reviewed content history conflicts with a later change');
    await versions.init(current);
    await versions.commit(artifact.after, 'Recover reviewed agent draft', 'Symbi Reflex');
  }

  async recover(artifacts: JevArtifact[]): Promise<void> {
    await this.context.files.serialize(async () => {
      for (const artifact of artifacts) await this.checkArtifact(artifact);
      for (const artifact of artifacts.filter((item): item is Extract<JevArtifact, { kind: 'content' }> => item.kind === 'content')) {
        await this.recoveredHistory(artifact);
      }
      for (const artifact of artifacts) await this.writeArtifact(artifact, 'after');
    });
  }

  async recovered(mutation: JevMutation, actor: string): Promise<void> {
    if (mutation.kind !== 'content' && mutation.kind !== 'move') return;
    const canvasId = recoveredCanvasId(mutation);
    const canvas = await this.context.getCanvas(canvasId, true);
    if (mutation.kind === 'content') await setJevDraftState(this.context.files.root, canvasId, mutation.blockId, mutation.draftId, 'applied');
    this.context.saved?.({ workspaceId: canvas.workspaceId, canvasId, blockIds: [mutation.blockId], kind: mutation.kind === 'move' ? 'move' : 'source', actor });
  }

  async setOwnership(canvasId: string, blockId: string, patch: Partial<JevOwnership>): Promise<CanvasBlock> {
    return this.context.files.serialize(async () => {
      const canvas = await documentWriteSnapshot(this.context.files, await this.context.getCanvas(canvasId, true));
      const block = requireBlock(canvas, blockId);
      const updated = { ...block, metadataRevision: (block.metadataRevision ?? 0) + 1,
        jevOwnership: { ...block.jevOwnership!, ...patch } };
      delete updated.jevMutationId;
      await atomicJson(this.context.files.canvasFile(canvasId), { ...canvas,
        blocks: canvas.blocks.map(item => storedBlock(item.id === blockId ? updated : item)) });
      return updated;
    });
  }
}
