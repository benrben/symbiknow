import type { CanvasBlock, CanvasTask } from '../shared/types.js';
import { ApiError } from './errors.js';

function date(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ApiError(400, 'Invalid freshness date');
  return new Date(value).toISOString();
}

export function freshness(value: unknown, previous: CanvasBlock['freshness']): CanvasBlock['freshness'] {
  if (value === undefined) return previous;
  if (value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Invalid freshness metadata');
  const input = value as Record<string, unknown>;
  return { reviewAt: date(input.reviewAt), expiresAt: date(input.expiresAt), effectiveAt: date(input.effectiveAt) };
}

function validateCriterion(item: Record<string, unknown>): asserts item is { id: string; text: string } {
  if (typeof item.id !== 'string' || !item.id) throw new ApiError(400, 'Invalid task acceptance criterion');
  if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000) throw new ApiError(400, 'Invalid task acceptance criterion');
}
function criterion(entry: unknown): { id: string; text: string } {
  if (!entry || typeof entry !== 'object') throw new ApiError(400, 'Invalid task acceptance criterion');
  const item = entry as Record<string, unknown>;
  validateCriterion(item);
  return { id: item.id, text: item.text.trim() };
}
function criteria(value: unknown): CanvasTask['acceptanceCriteria'] {
  if (!Array.isArray(value) || value.length > 50) throw new ApiError(400, 'Invalid task acceptance criteria');
  const result = value.map(criterion);
  if (new Set(result.map(item => item.id)).size !== result.length) throw new ApiError(400, 'Duplicate task criterion IDs');
  return result;
}

function setPriority(result: CanvasTask, value: unknown): void {
  if (value === undefined) return;
  if (value === null) { delete result.priority; return; }
  if (!['low', 'normal', 'high', 'urgent'].includes(String(value))) throw new ApiError(400, 'Invalid task priority');
  result.priority = value as CanvasTask['priority'];
}
function setReviewer(result: CanvasTask, value: unknown): void {
  if (value === undefined) return;
  if (value !== null && (typeof value !== 'string' || value.length > 120)) throw new ApiError(400, 'Invalid task reviewer');
  if (value) result.reviewer = String(value); else delete result.reviewer;
}
function setCriteria(result: CanvasTask, value: unknown): void {
  if (value === null) delete result.acceptanceCriteria;
  else if (value !== undefined) result.acceptanceCriteria = criteria(value);
}
export function taskJevFields(task: CanvasTask, input: Record<string, unknown>): CanvasTask {
  const result = { ...task };
  setPriority(result, input.priority);
  setReviewer(result, input.reviewer);
  setCriteria(result, input.acceptanceCriteria);
  return result;
}
