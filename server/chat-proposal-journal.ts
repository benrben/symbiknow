import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError, type CanvasStore } from './storage.js';
import type { StoredState } from './chat-proposal-types.js';
import { validState } from './chat-proposal-validation.js';

export const lifetime = 60 * 60_000;
const proposalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function proposalFile(store: CanvasStore, id: string): string {
  if (!proposalId.test(id)) throw new ApiError(410, 'This Chat proposal is no longer available. Ask Chat to prepare a fresh proposal.');
  return path.join(store.root, 'chat-proposals', `${id}.json`);
}
export function readState(store: CanvasStore, id: string): StoredState {
  const file = proposalFile(store, id);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new ApiError(410, 'This Chat proposal is no longer available. Ask Chat to prepare a fresh proposal.'); }
  if (!validState(parsed, id)) throw new ApiError(410, 'This Chat proposal is no longer available. Ask Chat to prepare a fresh proposal.');
  if (parsed.expires < Date.now()) {
    rmSync(file, { force: true });
    throw new ApiError(410, 'This Chat proposal expired. Ask Chat to prepare a fresh proposal.');
  }
  return parsed;
}
export function saveState(store: CanvasStore, id: string, state: StoredState): void {
  const file = proposalFile(store, id);
  const temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
