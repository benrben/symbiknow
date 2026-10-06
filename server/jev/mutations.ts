import type { JevMutation } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { validId } from '../storage-shapes.js';
import { validateVocabularyMutation } from './vocabulary.js';

export const metadataFields = ['group', 'tags', 'purpose', 'reviewer', 'quality', 'stale', 'archived', 'links', 'linkTypes', 'crossLinks', 'headline', 'freshness', 'processingExcluded'];
const taskFields = ['id', 'title', 'detail', 'status', 'assignee', 'dueDate', 'dependsOnTaskIds', 'blockIds', 'reviewer', 'priority', 'acceptanceCriteria', 'findingRef'];

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function keys(value: unknown, allowed: string[]): void {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'Unsupported mutation fields');
}
function identifier(value: unknown): void { if (typeof value !== 'string' || !validId(value)) throw new ApiError(400, 'Invalid mutation target'); }

export function validateMutation(mutation: JevMutation, internalUndo = false): void {
  if (!record(mutation)) throw new ApiError(400, 'Invalid mutation');
  if (mutation.kind === 'derived') { derivedValues(mutation.values); return; }
  if (mutation.kind === 'vocabulary') {
    validateVocabularyMutation(mutation);
    return;
  }
  identifier(mutation.canvasId);
  if (documentMutation(mutation)) return;
  if (taskMutation(mutation, internalUndo)) return;
  throw new ApiError(400, 'Unknown mutation kind');
}
function derivedValues(values: Record<string, unknown>): void { keys(values, Object.keys(values ?? {})); }

function documentMutation(mutation: JevMutation): boolean {
  if (mutation.kind === 'document') { identifier(mutation.blockId); keys(mutation.patch, metadataFields); return true; }
  if (mutation.kind === 'move') { identifier(mutation.blockId); identifier(mutation.targetCanvasId); return true; }
  if (mutation.kind === 'content') {
    contentMutation(mutation); return true;
  }
  return false;
}
function contentMutation(mutation: Extract<JevMutation, { kind: 'content' }>): void {
  identifier(mutation.blockId);
  if (typeof mutation.content !== 'string' || mutation.content.length > 1_000_000 || typeof mutation.expectedContentHash !== 'string') throw new ApiError(400, 'Invalid staged edit');
}
function taskMutation(mutation: JevMutation, internalUndo: boolean): boolean {
  if (mutation.kind === 'task_create') { keys(mutation.task, internalUndo ? [...taskFields, 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'comments', 'revision', 'jevMutationId'] : taskFields); return true; }
  if (mutation.kind === 'task_update' || mutation.kind === 'task_delete') {
    taskRevision(mutation); return true;
  }
  return false;
}
function taskRevision(mutation: Extract<JevMutation, { kind: 'task_update' | 'task_delete' }>): void {
  identifier(mutation.taskId);
  if (typeof mutation.expectedUpdatedAt !== 'string') throw new ApiError(400, 'Missing task revision');
  if (mutation.kind === 'task_update') keys(mutation.patch, taskFields.filter(field => field !== 'id'));
}

export function mutationIdentity(mutation: JevMutation): string {
  if (mutation.kind === 'vocabulary') return JSON.stringify([mutation.kind, mutation.term.id, mutation.previousId ?? null]);
  if (mutation.kind === 'derived') return JSON.stringify([mutation.kind, mutation.blockId ?? null]);
  return documentIdentity(mutation);
}
function documentIdentity(mutation: Exclude<JevMutation, { kind: 'vocabulary' | 'derived' }>): string {
  if (mutation.kind === 'task_create') return JSON.stringify([mutation.kind, mutation.canvasId, mutation.task.id ?? null]);
  if (mutation.kind === 'task_update' || mutation.kind === 'task_delete') return JSON.stringify([mutation.kind, mutation.canvasId, mutation.taskId]);
  return JSON.stringify([mutation.kind, mutation.canvasId, mutation.blockId, mutation.kind === 'move' ? mutation.targetCanvasId : null]);
}
