import { createHash } from 'node:crypto';
import type { CanvasBlock } from '../shared/types.js';

export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function isString(value: unknown): value is string { return typeof value === 'string'; }
export function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }
export function legacyStateHash(block: CanvasBlock): string {
  const state = { ...block };
  delete state.contentHash;
  delete state.lock;
  return createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
}
function canonicalState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalState);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalState(value[key])]));
}
export function stateHash(block: CanvasBlock): string {
  const state = { ...block };
  delete state.contentHash;
  delete state.lock;
  return createHash('sha256').update(JSON.stringify(canonicalState(state))).digest('hex').slice(0, 16);
}
