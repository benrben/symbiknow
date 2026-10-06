import { z } from 'zod';
import type { AnswerCanvasTurn } from '../shared/answer-canvas';
import { emptyResearchEdits, type ResearchCanvasEdits } from './research-edits';

const kind = z.enum(['markdown', 'slides', 'website', 'mdx']);
const type = z.enum(['text', 'diagram', 'task', 'section']);
const layout = z.enum(['roadmap', 'kanban', 'architecture', 'mindmap']);
const integer = z.number().refine(Number.isInteger);
const verification = z.object({ status: z.enum(['supported', 'unsupported', 'unverified']),
  checkedClaims: z.number(), totalClaims: z.number() });
const evidence = z.object({ claim: z.string(), passage: z.string(), passageKind: z.enum(['exact', 'approximation']),
  passageLabel: z.string().optional(), canvasId: z.string().optional(), documentId: z.string().optional(),
  documentTitle: z.string().optional(), contentHash: z.string().optional(), revision: z.string().optional(), checkedAt: z.string(),
  navigation: z.object({ kind: z.literal('document'), canvasId: z.string().optional(), blockId: z.string() }) });
// Older stream snapshots omitted these display-only source fields and turn status.
const source = z.object({ canvasId: z.string(), blockId: z.string(), title: z.string(), excerpt: z.string(),
  canvasName: z.string().optional(), relevance: z.number().optional(), contentHash: z.string().optional(), evidence: evidence.optional() });
const patchBlock = z.object({ id: z.string(), type, kind: kind.or(z.literal('html')).optional(),
  title: z.string(), content: z.string(), sourceIds: z.array(z.string()),
  verification: verification.optional(), lane: z.string().optional() });
const patch = z.object({ query: z.string(), layout: layout.optional(), blocks: z.array(patchBlock),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })) });
const turn = z.object({ id: integer, query: z.string(), answer: z.string(), sources: z.array(source),
  selection: z.enum(['jev', 'local']).optional(), status: z.enum(['working', 'complete', 'stopped']).optional(), patch: patch.optional() });
const block = z.object({ id: z.string(), turnId: integer, type, title: z.string(), content: z.string(),
  markdown: z.string(), sources: z.array(source), x: z.number(), y: z.number(), verification: verification.optional(),
  lane: z.string().optional(), kind: kind.optional(), width: z.number().optional(), height: z.number().optional(),
  group: z.string().nullable().optional(), tags: z.array(z.string()).optional() });
const change = z.object({ title: z.string().optional(), content: z.string().optional(), type: type.optional(),
  kind: kind.optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
  group: z.string().nullable().optional(), tags: z.array(z.string()).optional() }).strict();
const edits = z.object({ added: z.array(block), changed: z.record(z.string(), change), deleted: z.array(z.string()),
  addedEdges: z.array(z.object({ source: z.string(), target: z.string(), label: z.string() })), deletedEdges: z.array(z.string()) });
const editFields = z.object({ added: z.array(z.unknown()).catch([]), changed: z.record(z.string(), z.unknown()).catch({}),
  deleted: z.array(z.unknown()).catch([]), addedEdges: z.array(z.unknown()).catch([]), deletedEdges: z.array(z.unknown()).catch([]) });

/** Validate snapshots without replacing their original provenance or optional metadata. */
export function isSavedResearchTurn(value: unknown): value is AnswerCanvasTurn {
  return turn.safeParse(value).success;
}

function validEntries<T>(values: unknown[], schema: z.ZodType<T>): T[] {
  return values.filter((value): value is T => schema.safeParse(value).success);
}

export function recoveredResearchEdits(value: unknown): ResearchCanvasEdits {
  if (edits.safeParse(value).success) return value as ResearchCanvasEdits;
  const fields = editFields.safeParse(value);
  if (!fields.success) return emptyResearchEdits();
  return {
    added: validEntries(fields.data.added, edits.shape.added.element) as ResearchCanvasEdits['added'],
    changed: Object.fromEntries(Object.entries(fields.data.changed).filter(([, entry]) => change.safeParse(entry).success)) as ResearchCanvasEdits['changed'],
    deleted: validEntries(fields.data.deleted, edits.shape.deleted.element),
    addedEdges: validEntries(fields.data.addedEdges, edits.shape.addedEdges.element),
    deletedEdges: validEntries(fields.data.deletedEdges, edits.shape.deletedEdges.element),
  };
}
