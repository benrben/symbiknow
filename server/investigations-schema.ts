import { z } from 'zod';
import { ApiError } from './errors.js';

export const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
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
export const createFields = z.object({ workspaceId: id, title: z.string().trim().min(1).max(160), visibility: z.enum(['private', 'shared']),
  canvasId: id.optional(), question: z.string().max(2_000).optional(), messages: z.array(message).max(100).default([]),
  sourceRefs: z.array(source).max(100).default([]), proposalRefs: z.array(proposal).max(100).default([]),
  researchSnapshot: researchSnapshot.optional() });
export const updateFields = createFields.omit({ workspaceId: true }).partial().extend({
  messages: createFields.shape.messages.removeDefault().optional(),
  sourceRefs: createFields.shape.sourceRefs.removeDefault().optional(),
  proposalRefs: createFields.shape.proposalRefs.removeDefault().optional(),
  expectedRevision: z.number().int().positive() });
export const listFields = z.object({ workspaceId: id, privateKeys: z.array(z.string().min(1).max(128)).max(200).default([]) });
const savedFields = createFields.extend({ id, revision: z.number().int().positive(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), keyHash: z.string().regex(/^[a-f0-9]{64}$/).optional() });

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return result.data;
}

export function parseSaved(value: unknown, recordId: string) {
  const parsed = savedFields.safeParse(value);
  if (!parsed.success) throw new ApiError(500, 'Saved investigation is invalid');
  const saved = parsed.data;
  if (saved.id !== recordId || (saved.visibility === 'private' && !saved.keyHash)) {
    throw new ApiError(500, 'Saved investigation is invalid');
  }
  return saved;
}
