import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { JevSourceSnapshot } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { atomicJson } from '../storage-files.js';
import { validId } from '../storage-shapes.js';
import { z } from 'zod';

export interface JevDraft {
  id: string;
  generation: number;
  source: JevSourceSnapshot;
  baseContent: string;
  proposedContent: string;
  instruction: string;
  actor: string;
  state: 'staged' | 'ready' | 'held' | 'review_unavailable' | 'needs_rebase' | 'applied' | 'cancelled';
  expiresAt: string;
}
function draftFile(root: string, canvasId: string, blockId: string): string {
  if (!validId(canvasId) || !validId(blockId)) throw new ApiError(400, 'Invalid draft target');
  return path.join(root, 'jev', 'drafts', canvasId, `${blockId}.json`);
}

const identifier = z.string().refine(validId);
const name = z.string().min(1).max(200);
const text = z.string().max(1_000_000);
const inputSchema = z.object({ id: name, baseContent: text, proposedContent: text, instruction: text });
const draftSchema = inputSchema.extend({ generation: z.number().int().safe().positive(), actor: name,
  state: z.enum(['staged', 'ready', 'held', 'review_unavailable', 'needs_rebase', 'applied', 'cancelled']),
  expiresAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  source: z.object({ workspaceId: identifier, canvasId: identifier, blockId: identifier, incarnation: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{16}$/), sourceGeneration: z.number().int().safe().positive(), metadataRevision: z.number().int().safe().positive() }) });
function validDraft(value: unknown): value is JevDraft { return draftSchema.safeParse(value).success; }

function decodeDraft(content: string, canvasId: string, blockId: string): JevDraft {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new ApiError(503, 'Staged draft requires recovery'); }
  if (!validDraft(value) || value.source.canvasId !== canvasId || value.source.blockId !== blockId) throw new ApiError(503, 'Staged draft requires recovery');
  return value;
}

export async function readJevDraft(root: string, canvasId: string, blockId: string): Promise<JevDraft | undefined> {
  try {
    return decodeDraft(await readFile(draftFile(root, canvasId, blockId), 'utf8'), canvasId, blockId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function conflictingDraft(previous: JevDraft | undefined, actor: string, reviewer: boolean): boolean {
  if (!previous || ['applied', 'cancelled'].includes(previous.state)) return false;
  return previous.actor !== actor && !reviewer;
}

export async function stageJevDraft(root: string, source: JevSourceSnapshot,
  input: { id: string; baseContent: string; proposedContent: string; instruction: string }, actor: string,
  options: { reviewer?: boolean } = {}): Promise<JevDraft> {
  if (!inputSchema.safeParse(input).success) throw new ApiError(400, 'Invalid staged draft');
  const previous = await readJevDraft(root, source.canvasId, source.blockId);
  if (conflictingDraft(previous, actor, Boolean(options.reviewer))) {
    throw new ApiError(409, 'Another reviewed draft is active for this document');
  }
  const draft: JevDraft = { ...input, source, actor, generation: (previous?.generation ?? 0) + 1,
    state: input.baseContent === input.proposedContent ? 'ready' : 'staged', expiresAt: new Date(Date.now() + 86400000).toISOString() };
  if (!validDraft(draft)) throw new ApiError(400, 'Invalid staged draft');
  await atomicJson(draftFile(root, source.canvasId, source.blockId), draft, 0o600);
  return draft;
}

export async function setJevDraftState(root: string, canvasId: string, blockId: string, id: string, state: JevDraft['state'], generation?: number): Promise<void> {
  const draft = await readJevDraft(root, canvasId, blockId);
  if (!draft || draft.id !== id || (generation !== undefined && draft.generation !== generation)) return;
  await atomicJson(draftFile(root, canvasId, blockId), { ...draft, state }, 0o600);
}

export async function hasActiveJevDraft(root: string, canvasId: string, blockId: string): Promise<boolean> {
  const draft = await readJevDraft(root, canvasId, blockId);
  return Boolean(draft && !['cancelled', 'applied'].includes(draft.state) && Date.parse(draft.expiresAt) > Date.now());
}
