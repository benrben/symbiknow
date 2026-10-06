import { z } from 'zod';
import { jevActions, type JevActionRequest } from '../shared/jev-types.js';
import { validGroupKey } from '../shared/groups.js';
import { ApiError } from './errors.js';

const actionSchema = z.strictObject({ action: z.enum(jevActions), canvasId: z.string().min(1).max(64),
  blockIds: z.array(z.string().min(1).max(64)).max(20).optional(), query: z.string().max(4000).optional(),
  options: z.record(z.string().max(80), z.json()).optional(), idempotencyKey: z.string().min(1).max(128).optional() });

export function actionRequest(input: Record<string, unknown>, canvasId?: string): JevActionRequest {
  const result = actionSchema.safeParse({ ...input, ...(canvasId ? { canvasId } : {}) });
  if (!result.success || JSON.stringify(input).length > 24_000) throw new ApiError(400, 'Invalid or oversized Symbi Reflex action request');
  return result.data;
}

export function parsedInput<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, message);
  return result.data;
}

export const metadataSchema = z.strictObject({ canvasId: z.string().min(1).max(64).optional(), blockId: z.string().min(1).max(64), group: z.string().max(256).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(), headline: z.string().max(400).optional(),
  purpose: z.string().max(80).optional(), reviewer: z.string().max(80).optional(), stale: z.boolean().optional(),
  processingExcluded: z.boolean().optional(), pins: z.array(z.string().max(40)).max(20).optional(),
  managed: z.array(z.string().max(40)).max(20).optional() });

const parentBlockSchema = z.object({ id: z.string().min(1).max(64), title: z.string().max(400), kind: z.string().max(40),
  content: z.string().max(1_000_000), links: z.array(z.string().max(64)).max(200), contentHash: z.string().optional(),
  incarnation: z.string().optional(), sourceGeneration: z.number().int().positive().optional() }).passthrough();
export const parentUndoSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('created'), after: parentBlockSchema }),
  z.strictObject({ kind: z.literal('edited'), before: parentBlockSchema, after: parentBlockSchema })]);
export const groupApprovalSchema = z.strictObject({ groupKey: z.string().max(256).refine(validGroupKey),
  proposalIds: z.array(z.string().min(1).max(128)).min(1).max(100).refine(ids => new Set(ids).size === ids.length) });
export const documentRecheckSchema = z.strictObject({ canvasId: z.string().min(1).max(64), contentHash: z.string().regex(/^[a-f0-9]{16}$/) });
export const documentGroupApprovalSchema = documentRecheckSchema.extend({ proposalId: z.string().min(1).max(128) });
export const draftCancellationSchema = z.strictObject({ draftId: z.string().min(1).max(200) });
export const recipeSchema = z.strictObject({ canvasId: z.string().min(1).max(64), recipe: z.enum(['organize', 'tasks', 'connections']) });
