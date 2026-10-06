import type { SymbiIndexDocument, SymbiPassage, SymbiRetrievalResult } from '../shared/symbi-contract.js';
import type { JevStoreEvent } from './jev/events.js';
import type { JevEvaluationContext, JevInputDocument } from './jev/actions/context.js';
import { createSymbiIndex, type SymbiIndex } from './symbi-index.js';
import type { SymbiSearchRequest } from './symbi-retrieval.js';
import type { CanvasStore } from './storage.js';
import { ApiError } from './errors.js';

/** Reconciles a rebuildable index from ordinary document files. */
export class SymbiIndexLifecycle {
  private static readonly byStore = new WeakMap<CanvasStore, SymbiIndexLifecycle>();
  private pending: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private closed = false;

  private constructor(readonly index: SymbiIndex, private readonly store: CanvasStore) {
    SymbiIndexLifecycle.byStore.set(store, this);
    this.unsubscribe = store.onSaved(event => {
      if (this.closed) return Promise.resolve();
      // Hide an older indexed revision immediately; file reconciliation can queue behind embeddings.
      if (event.kind === 'source' || event.kind === 'metadata') for (const blockId of event.blockIds) {
        this.index.markPending({ canvasId: event.canvasId, blockId, contentHash: 'awaiting-file-revision', title: '' });
      }
      return this.enqueue(() => this.refresh(event));
    });
    this.enqueue(() => this.rebuild());
  }

  static async open(store: CanvasStore, modelRoot?: string): Promise<SymbiIndexLifecycle> {
    const index = await createSymbiIndex({ dataDir: store.root, modelRoot });
    return new SymbiIndexLifecycle(index, store);
  }

  static forStore(store: CanvasStore): SymbiIndexLifecycle | undefined { return this.byStore.get(store); }

  /** A source save can change the index between ranking and pagination; retry after its reconciliation. */
  async search(request: SymbiSearchRequest): Promise<SymbiRetrievalResult> {
    try { return await this.index.search(request); }
    catch (error) {
      if (request.cursor || !(error instanceof Error) || !error.message.includes('Index changed during search')) throw error;
      await this.pending;
      return this.index.search(request);
    }
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.pending.then(action);
    this.pending = next.catch(error => { console.error('Search index reconciliation failed:', error); });
    return next;
  }

  private async *documents(): AsyncGenerator<SymbiIndexDocument> {
    const workspaces = await this.store.listWorkspaces();
    for (const workspace of workspaces) for (const canvas of workspace.canvases) {
      const summary = await this.store.getCanvasSummary(canvas.id);
      for (const block of summary.blocks) {
        yield await this.indexDocument(canvas.id, block.id);
      }
    }
  }

  private async indexDocument(canvasId: string, blockId: string): Promise<SymbiIndexDocument> {
    const block = await this.store.getCanvasBlock(canvasId, blockId);
    return { canvasId, blockId, title: block.title, content: block.content,
      contentHash: block.contentHash!, metadataRevision: block.metadataRevision,
      tags: block.tags, group: block.group, purpose: block.purpose, links: block.links };
  }

  private async rebuild(): Promise<void> { await this.index.rebuild(this.documents()); }

  private async refresh(event: JevStoreEvent): Promise<void> {
    if (event.kind === 'tasks') return;
    if (event.kind === 'move') { await this.rebuild(); return; }
    for (const blockId of event.blockIds) {
      if (event.kind === 'delete') { await this.index.remove(event.canvasId, blockId); continue; }
      try {
        const doc = await this.indexDocument(event.canvasId, blockId);
        this.index.markPending(doc);
        await this.index.upsert(doc);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) await this.index.remove(event.canvasId, blockId);
        else throw error;
      }
    }
  }

  async expectedDocumentIds(allowedCanvasIds?: string[], canvasId?: string, documentIds?: string[]): Promise<string[]> {
    const permitted = allowedCanvasIds ? new Set(allowedCanvasIds) : undefined;
    if (canvasId && permitted && !permitted.has(canvasId)) throw new ApiError(404, 'Canvas not found');
    const wanted = documentIds ? new Set(documentIds) : undefined;
    const workspaces = await this.store.listWorkspaces();
    const ids: string[] = [];
    for (const canvas of workspaces.flatMap(workspace => workspace.canvases)) {
      if (canvasId && canvas.id !== canvasId) continue;
      if (permitted && !permitted.has(canvas.id)) continue;
      const summary = await this.store.getCanvasSummary(canvas.id);
      ids.push(...summary.blocks.filter(block => !wanted || wanted.has(block.id)).map(block => block.id));
    }
    return ids;
  }

  /** Current, authorized local neighbors for automatic Jev candidate discovery. */
  async neighbors(context: JevEvaluationContext, source: JevInputDocument): Promise<SymbiPassage[]> {
    const visible = context.documents.filter(document => document.snapshot.workspaceId === context.workspaceId
      && !document.block.archived && !document.block.processingExcluded);
    const allowedCanvasIds = [...new Set(visible.map(document => document.canvasId))];
    const allowedDocumentIds = [...new Set(visible.map(document => document.block.id))];
    if (!allowedCanvasIds.includes(source.canvasId) || !allowedDocumentIds.includes(source.block.id)) return [];
    const current = new Map(visible.map(document => [`${document.canvasId}\0${document.block.id}`, document.snapshot.contentHash]));
    const query = [source.block.title, source.block.purpose, ...(source.block.tags ?? []),
      source.block.content.slice(0, 1200)].filter(Boolean).join(' ');
    const result = await this.index.search({ query, mode: 'hybrid', limit: 100,
      allowedCanvasIds, allowedDocumentIds, expectedDocumentIds: allowedDocumentIds });
    return result.passages.filter(passage => current.get(`${passage.canvasId}\0${passage.blockId}`) === passage.contentHash
      && (passage.canvasId !== source.canvasId || passage.blockId !== source.block.id));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    await this.pending;
    await this.index.close();
    SymbiIndexLifecycle.byStore.delete(this.store);
  }
}
