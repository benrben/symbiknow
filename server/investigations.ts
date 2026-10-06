import { randomUUID } from 'node:crypto';
import { ApiError, CanvasStore } from './storage.js';
import { allowed, accessKeyForCreate, accessKeyForUpdate, keyHash } from './investigations-access.js';
import { InvestigationFiles } from './investigations-files.js';
import { publicRecord, summary, updatedRecord } from './investigations-records.js';
import { serial } from './investigations-queue.js';
import { createFields, listFields, parse, updateFields } from './investigations-schema.js';
import type { Investigation, InvestigationPatch, InvestigationSummary, SavedInvestigation } from './investigations-types.js';

export type { Investigation, InvestigationSummary } from './investigations-types.js';

export class InvestigationStore {
  private readonly files: InvestigationFiles;
  constructor(private readonly store: CanvasStore) { this.files = new InvestigationFiles(store.root); }

  private async validateWorkspace(workspaceId: string, canvasId?: string): Promise<void> {
    const workspace = (await this.store.listWorkspaces()).find(item => item.id === workspaceId);
    if (!workspace) throw new ApiError(404, 'Workspace not found');
    if (canvasId && !workspace.canvases.some(item => item.id === canvasId)) throw new ApiError(400, 'Canvas must belong to this workspace');
  }

  private async accessibleRecord(recordId: string, accessKey?: string): Promise<SavedInvestigation> {
    const saved = await this.files.read(recordId);
    if (!allowed(saved, accessKey)) throw new ApiError(404, 'Investigation not found');
    return saved;
  }

  async create(input: unknown): Promise<{ investigation: Investigation; accessKey?: string }> {
    const fields = parse(createFields, input);
    await this.validateWorkspace(fields.workspaceId, fields.canvasId);
    const accessKey = accessKeyForCreate(fields.visibility);
    const now = new Date().toISOString();
    const saved: SavedInvestigation = { ...fields, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now,
      ...(accessKey ? { keyHash: keyHash(accessKey) } : {}) };
    await this.files.save(saved);
    return { investigation: publicRecord(saved), ...(accessKey ? { accessKey } : {}) };
  }

  async list(input: unknown): Promise<{ investigations: InvestigationSummary[] }> {
    const { workspaceId, privateKeys } = parse(listFields, input);
    await this.validateWorkspace(workspaceId);
    const records = await this.files.list();
    return { investigations: records.filter(record => record.workspaceId === workspaceId
      && (record.visibility === 'shared' || privateKeys.some(key => allowed(record, key))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary) };
  }

  async get(recordId: string, accessKey?: string): Promise<Investigation> {
    return publicRecord(await this.accessibleRecord(recordId, accessKey));
  }

  async update(recordId: string, input: unknown, accessKey?: string): Promise<{ investigation: Investigation; accessKey?: string }> {
    const patch = parse(updateFields, input);
    return serial(this.files.file(recordId), () => this.updateSaved(recordId, patch, accessKey));
  }

  private async updateSaved(recordId: string, patch: InvestigationPatch, accessKey: string | undefined) {
    const saved = await this.accessibleRecord(recordId, accessKey);
    if (saved.revision !== patch.expectedRevision) throw new ApiError(409, 'Investigation changed. Reload it before saving.');
    if (patch.canvasId) await this.validateWorkspace(saved.workspaceId, patch.canvasId);
    const nextKey = accessKeyForUpdate(saved, patch);
    const next = updatedRecord(saved, patch, nextKey);
    await this.files.save(next);
    return { investigation: publicRecord(next), ...(nextKey ? { accessKey: nextKey } : {}) };
  }

  async delete(recordId: string, accessKey?: string): Promise<{ id: string; deleted: true }> {
    return serial(this.files.file(recordId), async () => {
      await this.accessibleRecord(recordId, accessKey);
      await this.files.delete(recordId);
      return { id: recordId, deleted: true };
    });
  }
}
