import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CanvasBlock, CanvasDocument, CanvasTask, ChatSettings, DocumentLock, LinkRelation, SearchHit, WorkspaceSummary } from '../shared/types.js';
import { ApiError } from './errors.js';
import { DocumentLocks } from './coordination.js';
import type { PrivateSettings } from './settings.js';
import type { McpActivityInput } from './mcp-activity.js';
import type { SimilarityIndex } from './similarity.js';
import { searchCandidates } from './search-candidates.js';
import { atomicJson, StorageFiles } from './storage-files.js';
import { canvasData, contentHash, fileSignature, validId, type StoredBlock, type StoredCanvas } from './storage-shapes.js';
import { requiredText } from './storage-validation.js';
import type { StorageContext } from './storage-context.js';
import { StorageDocuments } from './storage-documents.js';
import { StorageMerges } from './storage-merges.js';
import { StorageTasks } from './storage-tasks.js';
import { StorageSettings } from './storage-settings.js';
import type { BlockDeletionPreconditions } from '../shared/document-state.js';
import { publishJevStore, type JevStoreEvent } from './jev/events.js';
import { initializeJevStamp } from './jev/stamps.js';
import { storedBlock } from './storage-shapes.js';
import { StorageJevExecutor } from './storage-jev-executor.js';
import { groupLabels } from './jev/group-labels.js';
import { outsideJevWorkspace } from './jev/workspace.js';

export { ApiError, contentHash, validId };

type CanvasLinkChange = { id: string; before: StoredCanvas; after: StoredCanvas };

export class CanvasStore {
  readonly locks = new DocumentLocks();
  private readonly savedListeners = new Set<(event: JevStoreEvent) => Promise<void>>();
  private readonly files: StorageFiles;
  private readonly documents: StorageDocuments;
  private readonly merges: StorageMerges;
  private readonly tasks: StorageTasks;
  private readonly settings: StorageSettings;
  readonly jevExecutor: StorageJevExecutor;

  constructor(public readonly root: string) {
    this.files = new StorageFiles(root, this.locks);
    const context: StorageContext = { files: this.files, locks: this.locks,
      getCanvas: (id, includeArchived) => this.getCanvas(id, includeArchived, false),
      getCanvasSummary: id => this.getCanvasSummary(id),
      listWorkspaces: () => this.listWorkspaces(), listTasks: id => this.listTasks(id),
      writeTaskSnapshot: (canvasId, before, after, actor) => this.tasks.writeTaskSnapshot(canvasId, before, after, actor),
      saved: event => this.publishSaved(event) };
    this.documents = new StorageDocuments(context);
    this.merges = new StorageMerges(context);
    this.tasks = new StorageTasks(context);
    this.settings = new StorageSettings(context);
    this.jevExecutor = new StorageJevExecutor(context);
  }

  similarityIndex(workspaceId: string): SimilarityIndex { return this.files.similarityIndex(workspaceId); }

  onSaved(listener: (event: JevStoreEvent) => Promise<void>): () => void {
    this.savedListeners.add(listener);
    return () => this.savedListeners.delete(listener);
  }

  private publishSaved(event: JevStoreEvent): void {
    this.files.outsideWriter(() => outsideJevWorkspace(() => {
      publishJevStore(this, event);
      for (const listener of this.savedListeners) {
        void listener(event).catch(error => console.error('Search index update failed; reconciliation will retry.', error));
      }
    }));
  }

  async ensureJevStamps(canvasId: string): Promise<void> {
    await this.files.serialize(async () => {
      const snapshot = await this.readCanvasMetadata(canvasId);
      if (snapshot.blocks.every(block => block.incarnation)) return;
      await atomicJson(this.files.canvasFile(canvasId), { ...snapshot,
        blocks: snapshot.blocks.map(block => storedBlock(initializeJevStamp({ ...block, content: '' }))) });
    });
  }

  async documentMetadata(block: CanvasBlock): Promise<{ lastModified?: string; authors: string[]; latestAuthor?: string }> {
    return this.files.serialize(() => this.files.readDocumentMetadata(block));
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.root, 'docs'), { recursive: true });
    await mkdir(path.join(this.root, 'canvases'), { recursive: true });
    try {
      await readFile(this.files.workspacesFile());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.files.seed();
    }
    await this.tasks.recover();
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.files.readJson<WorkspaceSummary[]>(this.files.workspacesFile());
  }

  async createWorkspace(input: Record<string, unknown>): Promise<WorkspaceSummary> {
    const name = requiredText(input.name, 'name');
    return this.files.serialize(async () => {
      const workspaces = await this.listWorkspaces();
      const workspace = { id: randomUUID(), name, canvases: [] };
      workspaces.push(workspace);
      await atomicJson(this.files.workspacesFile(), workspaces);
      return workspace;
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    if (!validId(workspaceId)) throw new ApiError(400, 'Invalid workspace ID');
    await this.files.serialize(async () => {
      const workspaces = await this.listWorkspaces();
      const workspace = workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new ApiError(404, 'Workspace not found');
      const canvases = await Promise.all(workspace.canvases.map(async item => {
        const canvas = await this.files.readJson<StoredCanvas>(this.files.canvasFile(item.id));
        await Promise.all(canvas.blocks.map(block => this.files.readDocument(block.file)));
        return { canvas, journals: await this.files.canvasJournals(item.id) };
      }));
      await atomicJson(this.files.workspacesFile(), workspaces.filter(item => item.id !== workspaceId));
      for (const { canvas, journals } of canvases) {
        await rm(this.files.canvasFile(canvas.id), { force: true });
        await Promise.all(canvas.blocks.flatMap(block => [
          rm(this.files.docFile(block.file), { force: true }),
          rm(path.join(this.root, '.versions', block.id), { recursive: true, force: true }),
        ]));
        await Promise.all([this.files.tasksFile(canvas.id), this.files.jevCacheFile(canvas.id), ...journals]
          .map(file => rm(file, { force: true })));
        this.files.forgetCanvasMemory(canvas);
        this.files.outsideWriter(() => outsideJevWorkspace(() => publishJevStore(this, { workspaceId, canvasId: canvas.id,
          blockIds: canvas.blocks.map(block => block.id), kind: 'delete', actor: 'api' })));
      }
    });
  }

  async getCanvas(id: string, includeArchived = false, includeGroupLabels = true): Promise<CanvasDocument> {
    const canvas = await this.readCanvasMetadata(id);
    const crossLinkCanvases = new Map<string, Promise<StoredCanvas | undefined>>();
    const blocks = await Promise.all(canvas.blocks.map(async block => {
      const content = await this.files.readDocument(block.file);
      const lock = this.locks.active(id, block.id);
      const crossLinks = block.crossLinks ? await this.files.existingCrossLinks(canvas.workspaceId, id, block.crossLinks, crossLinkCanvases) : undefined;
      return { ...block, content, contentHash: contentHash(content), ...(lock ? { lock } : {}),
        crossLinks: crossLinks?.length ? crossLinks : undefined };
    }));
    this.files.similarityIndex(canvas.workspaceId).syncCanvas(id, blocks.filter(block => !block.archived));
    const visible = { ...canvasData(canvas), blocks: includeArchived ? blocks : blocks.filter(block => !block.archived) };
    if (!includeGroupLabels) return visible;
    const labels = await groupLabels(this.root, visible);
    return { ...visible, ...(labels ? { groupLabels: labels } : {}) };
  }

  async getCanvasSummary(id: string): Promise<CanvasDocument> {
    const canvas = await this.readCanvasMetadata(id);
    const crossLinkCanvases = new Map<string, Promise<StoredCanvas | undefined>>();
    const blocks = await Promise.all(canvas.blocks.filter(block => !block.archived).map(async block => ({
      ...await this.currentBlockMetadata(canvas, block, crossLinkCanvases), content: '', contentLoaded: false,
    })));
    return { ...canvas, blocks };
  }

  async getCanvasBlock(canvasId: string, blockId: string): Promise<CanvasBlock> {
    if (!validId(blockId)) throw new ApiError(400, 'Invalid block ID');
    const canvas = await this.readCanvasMetadata(canvasId);
    const block = canvas.blocks.find(item => item.id === blockId && !item.archived);
    if (!block) throw new ApiError(404, 'Document not found');
    const metadata = await this.currentBlockMetadata(canvas, block, new Map());
    const content = await readFile(this.files.docFile(block.file), 'utf8');
    return { ...metadata,
      content, contentHash: contentHash(content), contentLoaded: true };
  }

  private async readCanvasMetadata(id: string): Promise<StoredCanvas> {
    if (!validId(id)) throw new ApiError(400, 'Invalid canvas ID');
    try { return await this.files.readJson<StoredCanvas>(this.files.canvasFile(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Canvas not found');
      throw error;
    }
  }

  private async currentBlockMetadata(canvas: StoredCanvas, block: StoredBlock,
    crossLinkCanvases: Map<string, Promise<StoredCanvas | undefined>>): Promise<StoredBlock & { lock?: DocumentLock }> {
    const lock = this.locks.active(canvas.id, block.id);
    const crossLinks = block.crossLinks
      ? await this.files.existingCrossLinks(canvas.workspaceId, canvas.id, block.crossLinks, crossLinkCanvases) : undefined;
    return { ...block, ...(lock ? { lock } : {}), crossLinks: crossLinks?.length ? crossLinks : undefined,
      contentVersion: await this.documentContentVersion(block.file) };
  }

  private async documentContentVersion(file: string): Promise<string | undefined> {
    try { return fileSignature(await stat(this.files.docFile(file), { bigint: true })); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async getCanvasRevision(id: string): Promise<string> {
    if (!validId(id)) throw new ApiError(400, 'Invalid canvas ID');
    let canvas: StoredCanvas;
    const canvasFile = this.files.canvasFile(id);
    try { canvas = await this.files.readJson<StoredCanvas>(canvasFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Canvas not found');
      throw error;
    }
    const linkedCanvases = [...new Set(canvas.blocks.flatMap(block => block.crossLinks?.map(link => link.canvasId) ?? []))]
      .filter(linkedId => linkedId !== id).sort();
    const files = [canvasFile, ...canvas.blocks.map(block => this.files.docFile(block.file)),
      ...linkedCanvases.map(linkedId => this.files.canvasFile(linkedId))];
    const signatures = await Promise.all(files.map(async (file, index) => {
      try { return `${index}:${fileSignature(await stat(file, { bigint: true }))}`; }
      catch (error) {
        if (index > canvas.blocks.length && (error as NodeJS.ErrnoException).code === 'ENOENT') return `${index}:missing`;
        throw error;
      }
    }));
    const locks = canvas.blocks.map(block => this.locks.active(id, block.id) ?? null);
    return `"${createHash('sha256').update(signatures.join('|')).update(JSON.stringify(locks)).digest('hex').slice(0, 24)}"`;
  }

  async createCanvas(workspaceId: string, input: Record<string, unknown>): Promise<CanvasDocument> {
    if (!validId(workspaceId)) throw new ApiError(400, 'Invalid workspace ID');
    const name = requiredText(input.name, 'name');
    return this.files.serialize(async () => {
      const workspaces = await this.listWorkspaces();
      const workspace = workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new ApiError(404, 'Workspace not found');
      const canvas: StoredCanvas = { id: randomUUID(), name, workspaceId, blocks: [] };
      workspace.canvases.push({ id: canvas.id, name });
      await atomicJson(this.files.canvasFile(canvas.id), canvas);
      await atomicJson(this.files.workspacesFile(), workspaces);
      return { ...canvas, blocks: [] };
    });
  }

  async deleteCanvas(canvasId: string): Promise<void> {
    if (!validId(canvasId)) throw new ApiError(400, 'Invalid canvas ID');
    await this.files.serialize(async () => {
      const workspaces = await this.listWorkspaces();
      const workspace = workspaces.find(item => item.canvases.some(canvas => canvas.id === canvasId));
      if (!workspace) throw new ApiError(404, 'Canvas not found');
      const canvas = await this.files.readJson<StoredCanvas>(this.files.canvasFile(canvasId));
      await Promise.all(canvas.blocks.map(async block => contentHash(await this.files.readDocument(block.file))));
      const journals = await this.files.canvasJournals(canvasId);
      const changes = await this.inboundCanvasLinkChanges(workspace, canvasId);
      await this.commitCanvasDeletion(workspaces, workspace, canvasId, changes);
      await Promise.all(canvas.blocks.flatMap(block => [
        rm(this.files.docFile(block.file), { force: true }),
        rm(path.join(this.root, '.versions', block.id), { recursive: true, force: true }),
      ]));
      await Promise.all([this.files.tasksFile(canvasId), this.files.jevCacheFile(canvasId), ...journals]
        .map(file => rm(file, { force: true })));
      this.files.forgetCanvasMemory(canvas);
      this.files.outsideWriter(() => outsideJevWorkspace(() => publishJevStore(this, { workspaceId: workspace.id, canvasId,
        blockIds: canvas.blocks.map(block => block.id), kind: 'delete', actor: 'api' })));
    });
  }

  private async inboundCanvasLinkChanges(workspace: WorkspaceSummary, canvasId: string): Promise<CanvasLinkChange[]> {
    const changes: CanvasLinkChange[] = [];
    for (const item of workspace.canvases.filter(item => item.id !== canvasId)) {
      const other = await this.files.readJson<StoredCanvas>(this.files.canvasFile(item.id));
      const blocks = other.blocks.map(block => {
        const crossLinks = block.crossLinks?.filter(link => link.canvasId !== canvasId);
        return crossLinks?.length === block.crossLinks?.length ? block : { ...block, crossLinks: crossLinks?.length ? crossLinks : undefined };
      });
      if (blocks.some((block, index) => block !== other.blocks[index])) {
        changes.push({ id: item.id, before: other, after: { ...other, blocks } });
      }
    }
    return changes;
  }

  private async commitCanvasDeletion(workspaces: WorkspaceSummary[], workspace: WorkspaceSummary,
    canvasId: string, changes: CanvasLinkChange[]): Promise<void> {
    const attempted: CanvasLinkChange[] = [];
    const originalCanvases = workspace.canvases;
    let manifestAttempted = false;
    try {
      for (const change of changes) {
        // An atomic write can replace its destination before chmod or cleanup fails.
        attempted.push(change);
        await atomicJson(this.files.canvasFile(change.id), change.after);
      }
      workspace.canvases = workspace.canvases.filter(item => item.id !== canvasId);
      manifestAttempted = true;
      await atomicJson(this.files.workspacesFile(), workspaces);
      await rm(this.files.canvasFile(canvasId), { force: true });
    } catch (error) {
      workspace.canvases = originalCanvases;
      await this.restoreCanvasDeletion(attempted, manifestAttempted ? workspaces : undefined, error);
    }
  }

  private async restoreCanvasDeletion(attempted: CanvasLinkChange[], workspaces: WorkspaceSummary[] | undefined,
    originalError: unknown): Promise<never> {
    const restorations = attempted.reverse().map(change => atomicJson(this.files.canvasFile(change.id), change.before));
    if (workspaces) restorations.push(atomicJson(this.files.workspacesFile(), workspaces));
    const results = await Promise.allSettled(restorations);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError([originalError, ...failures], 'Canvas deletion failed and could not be fully restored');
    throw originalError;
  }

  async search(query: string): Promise<SearchHit[]> {
    if (query.length > 200) throw new ApiError(400, 'Search query is too long');
    if (!query.trim()) return [];
    const workspaces = await this.listWorkspaces();
    const canvasIds = workspaces.flatMap(workspace => workspace.canvases.map(canvas => canvas.id));
    const canvases = await Promise.all(canvasIds.map(id => this.getCanvas(id)));
    return searchCandidates(canvases, query);
  }

  async createBlock(canvasId: string, input: Record<string, unknown>, actor = 'api'): Promise<CanvasBlock> {
    return this.documents.createBlock(canvasId, input, actor);
  }

  async updateBlock(canvasId: string, blockId: string, input: Record<string, unknown>, actor = 'api'): Promise<CanvasBlock> {
    return this.documents.updateBlock(canvasId, blockId, input, actor);
  }

  async updateInsightLink(canvasId: string,
    action: { type: 'link' | 'unlink'; fromBlockId: string; toBlockId: string; relation?: LinkRelation },
    actor: string, expectedStateHashes?: Record<string, string>): Promise<void> {
    return this.documents.updateInsightLink(canvasId, action, actor, expectedStateHashes);
  }

  async moveBlockToCanvas(canvasId: string, blockId: string, targetCanvasId: string, actor = 'api', expectedStateHash?: string):
    Promise<{ fromCanvasId: string; toCanvasId: string; blockId: string }> {
    return this.documents.moveBlockToCanvas(canvasId, blockId, targetCanvasId, actor, expectedStateHash);
  }

  async updateLayout(canvasId: string, positions: unknown, expectedStateHashes?: Record<string, string>): Promise<CanvasDocument> {
    return this.documents.updateLayout(canvasId, positions, expectedStateHashes);
  }

  async deleteBlock(canvasId: string, blockId: string, actor = 'api', preconditions?: BlockDeletionPreconditions): Promise<void> {
    return this.documents.deleteBlock(canvasId, blockId, actor, preconditions);
  }

  async lockBlock(canvasId: string, blockId: string, actor: string, input: Record<string, unknown>): Promise<DocumentLock> {
    return this.documents.lockBlock(canvasId, blockId, actor, input);
  }

  async unlockBlock(canvasId: string, blockId: string, actor: string, force: boolean): Promise<void> {
    return this.documents.unlockBlock(canvasId, blockId, actor, force);
  }

  async documentHistory(canvasId: string, blockId: string, options?: { limit?: number; cursor?: number }) {
    return this.documents.documentHistory(canvasId, blockId, options);
  }

  async readDocumentBranch(canvasId: string, blockId: string, branch: string) {
    return this.documents.readDocumentBranch(canvasId, blockId, branch);
  }

  async editDocumentBranch(canvasId: string, blockId: string, branch: string, input: Record<string, unknown>, actor: string) {
    return this.documents.editDocumentBranch(canvasId, blockId, branch, input, actor);
  }

  async deleteDocumentBranch(canvasId: string, blockId: string, branch: string, actor: string) {
    return this.documents.deleteDocumentBranch(canvasId, blockId, branch, actor);
  }

  async previewDocumentVersion(canvasId: string, blockId: string, kind: 'switch' | 'merge' | 'restore', target: string) {
    return this.documents.previewDocumentVersion(canvasId, blockId, kind, target);
  }

  async createDocumentBranch(canvasId: string, blockId: string, name: string) {
    return this.documents.createDocumentBranch(canvasId, blockId, name);
  }

  async switchDocumentBranch(canvasId: string, blockId: string, name: string, actor = 'api') {
    return this.documents.switchDocumentBranch(canvasId, blockId, name, actor);
  }

  async mergeDocumentBranch(canvasId: string, blockId: string, name: string, actor = 'api') {
    return this.documents.mergeDocumentBranch(canvasId, blockId, name, actor);
  }

  async restoreDocumentRevision(canvasId: string, blockId: string, revision: string, actor = 'api') {
    return this.documents.restoreDocumentRevision(canvasId, blockId, revision, actor);
  }

  async mergeDocuments(canvasId: string, input: Record<string, unknown>, actor = 'api'):
    Promise<{ mergeId: string; keepBlockId: string; archivedBlockIds: string[]; contentHash: string }> {
    return this.merges.mergeDocuments(canvasId, input, actor);
  }

  async undoMerge(mergeId: string, actor = 'api'): Promise<{ mergeId: string; reverted: true }> {
    return this.merges.undoMerge(mergeId, actor);
  }

  async listTasks(canvasId: string): Promise<CanvasTask[]> {
    return this.tasks.listTasks(canvasId);
  }

  async listTaskHistory(canvasId: string, taskId?: string, limit?: number, cursor?: number) {
    return this.tasks.listTaskHistory(canvasId, taskId, limit, cursor);
  }

  async createTask(canvasId: string, input: Record<string, unknown>, actor: string): Promise<CanvasTask> {
    return this.tasks.createTask(canvasId, input, actor);
  }

  async updateTask(canvasId: string, taskId: string, input: Record<string, unknown>, actor: string): Promise<CanvasTask> {
    return this.tasks.updateTask(canvasId, taskId, input, actor);
  }

  async claimTask(canvasId: string, taskId: string, actor: string, force: boolean): Promise<CanvasTask> {
    return this.tasks.claimTask(canvasId, taskId, actor, force);
  }

  async commentTask(canvasId: string, taskId: string, text: unknown, actor: string): Promise<CanvasTask> {
    return this.tasks.commentTask(canvasId, taskId, text, actor);
  }

  async deleteTask(canvasId: string, taskId: string, actor = 'api', expectedRevision?: number): Promise<void> {
    return this.tasks.deleteTask(canvasId, taskId, actor, expectedRevision);
  }

  async undoTask(canvasId: string, taskId: string, eventId: string, expectedRevision: number, actor: string) {
    return this.tasks.undoTask(canvasId, taskId, eventId, expectedRevision, actor);
  }

  async secretSettings(): Promise<PrivateSettings> {
    return this.settings.secretSettings();
  }

  async getSettings(): Promise<ChatSettings> {
    return this.settings.getSettings();
  }

  async getApiKey(): Promise<string> {
    return this.settings.getApiKey();
  }

  async updateSettings(input: Record<string, unknown>): Promise<ChatSettings> {
    return this.settings.updateSettings(input);
  }

  async createMcpToken(name: unknown, access: unknown = 'read', scope?: { allowedCanvasIds?: unknown; tools?: unknown; canApprove?: unknown; canConfigure?: unknown }): Promise<{ token: string; settings: ChatSettings }> {
    return this.settings.createMcpToken(name, access, scope);
  }

  async revokeMcpToken(id: string): Promise<ChatSettings> {
    return this.settings.revokeMcpToken(id);
  }

  async mcpActivity() {
    return this.settings.mcpActivity();
  }

  async mcpDocumentRevision(blockId: string): Promise<string | undefined> {
    return this.settings.mcpDocumentRevision(blockId);
  }

  async recordMcpActivity(input: McpActivityInput) {
    return this.settings.recordMcpActivity(input);
  }

  async mcpTokenIdentity(token: string): Promise<{ id: string; name: string; access: 'read' | 'propose' | 'write';
    allowedCanvasIds?: string[]; tools?: string[]; canApprove?: boolean; canConfigure?: boolean } | null> {
    return this.settings.mcpTokenIdentity(token);
  }

  async verifyMcpToken(token: string): Promise<string | null> {
    return this.settings.verifyMcpToken(token);
  }
}
