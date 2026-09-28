import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AnswerCanvasTurn, ResearchLayout } from '../shared/answer-canvas.js';
import type { ResearchCanvasEdits } from '../src/research-edits.js';
import { ApiError, CanvasStore } from './storage.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(20_000) });
const source = z.object({ canvasId: id, blockId: id, contentHash: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  revisionId: z.string().min(1).max(128).optional(), excerpt: z.string().max(2_000).optional() });
const proposal = z.object({ kind: z.enum(['chat', 'jev']), id, status: z.string().max(40).optional() });
const researchId = z.string().min(1).max(256);
const researchText = z.string().max(300_000);
const researchLayout = z.enum(['roadmap', 'kanban', 'architecture', 'mindmap']);
const blockKind = z.enum(['markdown', 'slides', 'website', 'mdx']);
const researchEvidence = z.object({ claim: z.string().max(2_000), passage: z.string().max(20_000),
  passageKind: z.enum(['exact', 'approximation']), passageLabel: z.string().max(500).optional(),
  canvasId: researchId, documentId: researchId, documentTitle: z.string().max(500).optional(),
  contentHash: z.string().max(128).optional(), revision: z.string().max(128).optional(), checkedAt: z.iso.datetime(),
  navigation: z.object({ kind: z.literal('document'), canvasId: researchId, blockId: researchId }) });
const researchSource = z.object({ canvasId: researchId, canvasName: z.string().max(500), blockId: researchId,
  title: z.string().max(500), excerpt: z.string().max(20_000), relevance: z.number().finite(),
  contentHash: z.string().max(128).optional(), evidence: researchEvidence.optional() });
const patchBlock = z.object({ id: researchId, type: z.enum(['text', 'diagram', 'task', 'section']), kind: blockKind.or(z.literal('html')).optional(),
  title: z.string().max(500), content: researchText, sourceIds: z.array(researchId).max(100), lane: z.string().max(160).optional() });
const patchEdge = z.object({ from: researchId, to: researchId, label: z.string().max(160).optional() });
const researchPatch = z.object({ query: z.string().max(2_000), layout: researchLayout.optional(),
  blocks: z.array(patchBlock).max(300), edges: z.array(patchEdge).max(600) });
const researchTurn = z.object({ id: z.number().int().nonnegative(), query: z.string().max(2_000), answer: researchText,
  sources: z.array(researchSource).max(100), selection: z.enum(['jev', 'local']).optional(),
  status: z.enum(['working', 'complete', 'stopped']), patch: researchPatch.optional() });
const researchBlock = z.object({ id: researchId, turnId: z.number().int().nonnegative(), type: patchBlock.shape.type,
  title: z.string().max(500), content: researchText, markdown: researchText, sources: z.array(researchSource).max(100),
  x: z.number().finite(), y: z.number().finite(), lane: z.string().max(160).optional(), kind: blockKind.optional(),
  width: z.number().finite().optional(), height: z.number().finite().optional(), group: z.string().max(160).nullable().optional(),
  tags: z.array(z.string().max(100)).max(100).optional() });
const researchEdge = z.object({ source: researchId, target: researchId, label: z.string().max(160) });
const blockChange = z.object({ title: z.string().max(500).optional(), content: researchText.optional(),
  type: patchBlock.shape.type.optional(), kind: blockKind.optional(), x: z.number().finite().optional(), y: z.number().finite().optional(),
  width: z.number().finite().optional(), height: z.number().finite().optional(), group: z.string().max(160).nullable().optional(),
  tags: z.array(z.string().max(100)).max(100).optional() });
const researchEdits = z.object({ added: z.array(researchBlock).max(300),
  changed: z.record(researchId, blockChange).refine(changes => Object.keys(changes).length <= 300),
  deleted: z.array(researchId).max(300), addedEdges: z.array(researchEdge).max(600),
  deletedEdges: z.array(z.string().min(1).max(600)).max(600) });
const researchSnapshotShape = z.object({ turns: z.array(researchTurn).max(100), edits: researchEdits, layout: researchLayout });
const researchSnapshot = z.preprocess(value => {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > 1_000_000) return null;
    return value;
  } catch { return null; }
}, researchSnapshotShape);
type ResearchSnapshot = { turns: AnswerCanvasTurn[]; edits: ResearchCanvasEdits; layout: ResearchLayout };
const createFields = z.object({ workspaceId: id, title: z.string().trim().min(1).max(160), visibility: z.enum(['private', 'shared']),
  canvasId: id.optional(), question: z.string().max(2_000).optional(), messages: z.array(message).max(100).default([]),
  sourceRefs: z.array(source).max(100).default([]), proposalRefs: z.array(proposal).max(100).default([]),
  researchSnapshot: researchSnapshot.optional() });
const updateFields = createFields.omit({ workspaceId: true }).partial().extend({ expectedRevision: z.number().int().positive() });
const listFields = z.object({ workspaceId: id, privateKeys: z.array(z.string().min(1).max(128)).max(200).default([]) });
const savedFields = createFields.extend({ id, revision: z.number().int().positive(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), keyHash: z.string().regex(/^[a-f0-9]{64}$/).optional() });

export type Investigation = Omit<z.infer<typeof createFields>, 'researchSnapshot'> & { researchSnapshot?: ResearchSnapshot;
  id: string; revision: number; createdAt: string; updatedAt: string };
export type InvestigationSummary = Pick<Investigation, 'id' | 'workspaceId' | 'canvasId' | 'title' | 'visibility' | 'question' | 'revision' | 'createdAt' | 'updatedAt'>
  & { sourceCount: number; proposalCount: number; messageCount: number };
type Saved = Investigation & { keyHash?: string };
const queues = new Map<string, Promise<unknown>>();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return result.data;
}
function keyHash(key: string): string { return createHash('sha256').update(key).digest('hex'); }
function allowed(saved: Saved, key: string | undefined): boolean {
  if (saved.visibility === 'shared') return true;
  if (!key || !saved.keyHash) return false;
  const expected = Buffer.from(saved.keyHash, 'hex');
  const supplied = Buffer.from(keyHash(key), 'hex');
  return timingSafeEqual(expected, supplied);
}
function publicRecord(saved: Saved): Investigation {
  const { keyHash: _keyHash, ...investigation } = saved;
  void _keyHash;
  return investigation;
}
function summary(saved: Saved): InvestigationSummary {
  const { id, workspaceId, canvasId, title, visibility, question, revision, createdAt, updatedAt } = saved;
  return { id, workspaceId, ...(canvasId ? { canvasId } : {}), title, visibility,
    ...(question ? { question } : {}), revision, createdAt, updatedAt,
    sourceCount: saved.sourceRefs.length, proposalCount: saved.proposalRefs.length, messageCount: saved.messages.length };
}
async function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(action);
  queues.set(key, run);
  try { return await run; }
  finally { if (queues.get(key) === run) queues.delete(key); }
}

export class InvestigationStore {
  constructor(private readonly store: CanvasStore) {}
  private file(recordId: string): string {
    if (!id.safeParse(recordId).success) throw new ApiError(400, 'Invalid investigation ID');
    return path.join(this.store.root, 'investigations', `${recordId}.json`);
  }
  private async read(recordId: string): Promise<Saved> {
    let raw: string;
    try { raw = await readFile(this.file(recordId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Investigation not found'); throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ApiError(500, 'Saved investigation is invalid'); }
    const parsed = savedFields.safeParse(value);
    if (!parsed.success || parsed.data.id !== recordId || (parsed.data.visibility === 'private' && !parsed.data.keyHash)) {
      throw new ApiError(500, 'Saved investigation is invalid');
    }
    return parsed.data;
  }
  private async save(saved: Saved): Promise<void> {
    const file = this.file(saved.id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally { await rm(temporary, { force: true }); }
  }
  private async validateWorkspace(workspaceId: string, canvasId?: string): Promise<void> {
    const workspace = (await this.store.listWorkspaces()).find(item => item.id === workspaceId);
    if (!workspace) throw new ApiError(404, 'Workspace not found');
    if (canvasId && !workspace.canvases.some(item => item.id === canvasId)) throw new ApiError(400, 'Canvas must belong to this workspace');
  }
  async create(input: unknown): Promise<{ investigation: Investigation; accessKey?: string }> {
    const fields = parse(createFields, input);
    await this.validateWorkspace(fields.workspaceId, fields.canvasId);
    const accessKey = fields.visibility === 'private' ? randomBytes(32).toString('base64url') : undefined;
    const now = new Date().toISOString();
    const saved: Saved = { ...fields, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now,
      ...(accessKey ? { keyHash: keyHash(accessKey) } : {}) };
    await this.save(saved);
    return { investigation: publicRecord(saved), ...(accessKey ? { accessKey } : {}) };
  }
  async list(input: unknown): Promise<{ investigations: InvestigationSummary[] }> {
    const { workspaceId, privateKeys } = parse(listFields, input);
    await this.validateWorkspace(workspaceId);
    let files: string[];
    try { files = await readdir(path.join(this.store.root, 'investigations')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { investigations: [] }; throw error; }
    const records = await Promise.all(files.filter(file => /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(file))
      .map(async file => this.read(file.slice(0, -5))));
    return { investigations: records.filter(record => record.workspaceId === workspaceId
      && (record.visibility === 'shared' || privateKeys.some(key => allowed(record, key))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary) };
  }
  async get(recordId: string, accessKey?: string): Promise<Investigation> {
    const saved = await this.read(recordId);
    if (!allowed(saved, accessKey)) throw new ApiError(404, 'Investigation not found');
    return publicRecord(saved);
  }
  async update(recordId: string, input: unknown, accessKey?: string): Promise<{ investigation: Investigation; accessKey?: string }> {
    const patch = parse(updateFields, input);
    return serial(this.file(recordId), async () => {
      const saved = await this.read(recordId);
      if (!allowed(saved, accessKey)) throw new ApiError(404, 'Investigation not found');
      if (saved.revision !== patch.expectedRevision) throw new ApiError(409, 'Investigation changed. Reload it before saving.');
      if (patch.canvasId) await this.validateWorkspace(saved.workspaceId, patch.canvasId);
      const nextKey = patch.visibility === 'private' && saved.visibility === 'shared' ? randomBytes(32).toString('base64url') : undefined;
      const { expectedRevision: _revision, ...changes } = patch;
      void _revision;
      const next: Saved = { ...saved, ...changes, revision: saved.revision + 1, updatedAt: new Date().toISOString(),
        ...(nextKey ? { keyHash: keyHash(nextKey) } : {}) };
      if (next.visibility === 'shared') delete next.keyHash;
      await this.save(next);
      return { investigation: publicRecord(next), ...(nextKey ? { accessKey: nextKey } : {}) };
    });
  }
  async delete(recordId: string, accessKey?: string): Promise<{ id: string; deleted: true }> {
    return serial(this.file(recordId), async () => {
      const saved = await this.read(recordId);
      if (!allowed(saved, accessKey)) throw new ApiError(404, 'Investigation not found');
      await rm(this.file(recordId));
      return { id: recordId, deleted: true };
    });
  }
}
