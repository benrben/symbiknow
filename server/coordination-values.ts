import type { TaskStatus } from '../shared/types.js';
import { cleanActor } from './auth.js';
import { ApiError } from './errors.js';

const statuses: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
function invalidText(value: unknown, max: number, required: boolean) {
  return typeof value !== 'string' || value.length > max || (required && !value.trim());
}
export function text(value: unknown, field: string, max: number, required = false): string {
  if (invalidText(value, max, required)) {
    throw new ApiError(400, `${field} must be ${required ? 'a nonempty' : 'a'} string of at most ${max} characters`);
  }
  return (value as string).trim();
}
export function status(value: unknown): TaskStatus {
  if (!statuses.includes(value as TaskStatus)) throw new ApiError(400, 'status must be todo, in_progress, blocked, or done');
  return value as TaskStatus;
}
export function blockIds(value: unknown, known: Set<string>): string[] {
  if (!Array.isArray(value) || value.length > 20 || !value.every(id => typeof id === 'string' && known.has(id))) {
    throw new ApiError(400, 'blockIds must list up to 20 documents on this canvas');
  }
  return [...new Set(value as string[])];
}
export function assignee(value: unknown): string | undefined {
  if (value === null || value === '') return undefined;
  const name = cleanActor(value);
  if (!name) throw new ApiError(400, 'assignee must be a short name');
  return name;
}
function isEmptyDate(value: unknown) { return value === undefined || value === null || value === ''; }
function validCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
export function taskDueDate(value: unknown): string | undefined {
  if (isEmptyDate(value)) return undefined;
  if (!validCalendarDate(value)) throw new ApiError(400, 'dueDate must be a valid YYYY-MM-DD date');
  return value;
}
export function taskDependencies(value: unknown, known: Set<string>, selfId?: string): string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== 'string'
    || !known.has(id) || id === selfId) || new Set(value).size !== value.length) {
    throw new ApiError(400, 'dependsOnTaskIds must list distinct existing tasks on this canvas');
  }
  return value as string[];
}
export function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, message);
  return value as Record<string, unknown>;
}
export function list(value: unknown, max: number, message: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ApiError(400, message);
  return value;
}
export function optionalText(entry: Record<string, unknown>, key: string, field: string, max: number, required = false) {
  return entry[key] === undefined ? {} : { [key]: text(entry[key], field, max, required) };
}
