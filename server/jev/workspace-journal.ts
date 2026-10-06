import { createHash } from 'node:crypto';
import { open, readFile, rm, truncate } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';

type KeyedPatch = { upsert: Record<string, unknown>; remove: string[]; order?: string[] };
type ObjectPatch = { set: Record<string, unknown>; remove: string[] };
export type WorkspacePatch = { set: Record<string, unknown>; remove: string[];
  arrays: Record<string, KeyedPatch>; objects: Record<string, ObjectPatch> };
export interface WorkspaceJournalRecord { format: 'jev-delta'; version: 1; baseHash: string;
  fromRevision: number; toRevision: number; previousHash: string; patch: WorkspacePatch; hash: string }
export interface JournalReplay { state: JevWorkspaceState; validBytes: number; records: number; lastHash: string }
const keyedFields = new Set(['jobs', 'proposals', 'receipts', 'vocabulary', 'prepared', 'commandPlans']);

export function digest(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function equal(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeKey(key: string): boolean { return !['__proto__', 'prototype', 'constructor'].includes(key); }
function safePatchKey(key: unknown): boolean { return typeof key === 'string' && safeKey(key) && key !== 'revision'; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(id => typeof id === 'string'); }
function keyedPayload(entry: Record<string, unknown>): boolean {
  if (!record(entry.upsert) || !strings(entry.remove)) return false;
  if (Object.keys(entry.upsert).some(id => !safeKey(id))) return false;
  if (entry.order !== undefined && !strings(entry.order)) return false;
  return !Object.entries(entry.upsert).some(([id, item]) => !record(item) || item.id !== id);
}
function keyedEntry(key: string, entry: unknown): boolean {
  return keyedFields.has(key) && record(entry) && keyedPayload(entry);
}
function objectEntry(key: string, entry: unknown): boolean {
  if (key !== 'profiles' || !record(entry) || !record(entry.set) || !Array.isArray(entry.remove)) return false;
  return !entry.remove.some(id => typeof id !== 'string' || !safeKey(id))
    && !Object.keys(entry.set).some(id => !safeKey(id));
}
function patchTables(value: unknown): value is WorkspacePatch {
  return record(value) && record(value.set) && Array.isArray(value.remove)
    && record(value.arrays) && record(value.objects);
}
function patchShape(value: unknown): value is WorkspacePatch {
  if (!patchTables(value)) return false;
  if (Object.keys(value.set).some(key => !safePatchKey(key)) || value.remove.some(key => !safePatchKey(key))) return false;
  return Object.entries(value.arrays).every(([key, entry]) => keyedEntry(key, entry))
    && Object.entries(value.objects).every(([key, entry]) => objectEntry(key, entry));
}
function keyed(items: unknown[]): items is Array<Record<string, unknown> & { id: string }> {
  return items.every(item => record(item) && typeof item.id === 'string')
    && new Set(items.map(item => (item as { id: string }).id)).size === items.length;
}
function keyedArray(value: unknown): value is Array<{ id: string }> { return Array.isArray(value) && keyed(value); }
function objectPatch(before: Record<string, unknown>, after: Record<string, unknown>): ObjectPatch {
  return { set: Object.fromEntries(Object.entries(after).filter(([key, value]) => !equal(before[key], value))),
    remove: Object.keys(before).filter(key => !Object.hasOwn(after, key)) };
}
function keyedPatch(before: Array<{ id: string }>, after: Array<{ id: string }>): KeyedPatch {
  const previous = new Map(before.map(item => [item.id, item]));
  const nextIds = new Set(after.map(item => item.id));
  const remove = before.filter(item => !nextIds.has(item.id)).map(item => item.id);
  const upsert = Object.fromEntries(after.filter(item => !equal(previous.get(item.id), item)).map(item => [item.id, item]));
  const natural = [...before.filter(item => nextIds.has(item.id)).map(item => item.id),
    ...after.filter(item => !previous.has(item.id)).map(item => item.id)];
  const desired = after.map(item => item.id);
  return { upsert, remove, ...(!equal(natural, desired) ? { order: desired } : {}) };
}
function profileFieldPatch(patch: WorkspacePatch, key: string, previous: unknown, next: unknown): boolean {
  if (key === 'profiles' && record(previous) && record(next)) {
    patch.objects[key] = objectPatch(previous, next); return true;
  }
  return false;
}
function keyedFieldPatch(patch: WorkspacePatch, key: string, previous: unknown, next: unknown): boolean {
  if (keyedFields.has(key) && keyedArray(previous) && keyedArray(next)) {
    patch.arrays[key] = keyedPatch(previous, next); return true;
  }
  return false;
}
function specializedFieldPatch(patch: WorkspacePatch, key: string, previous: unknown, next: unknown): boolean {
  return profileFieldPatch(patch, key, previous, next) || keyedFieldPatch(patch, key, previous, next);
}
function writeFieldPatch(patch: WorkspacePatch, key: string, old: Record<string, unknown>, next: Record<string, unknown>): void {
  if (key === 'revision') return;
  if (!Object.hasOwn(next, key)) { patch.remove.push(key); return; }
  if (equal(old[key], next[key])) return;
  if (specializedFieldPatch(patch, key, old[key], next[key])) return;
  patch.set[key] = next[key];
}

/** Encode changed top-level values and keyed records, preserving array order and future unknown fields. */
export function workspacePatch(before: JevWorkspaceState, after: JevWorkspaceState): WorkspacePatch {
  const patch: WorkspacePatch = { set: {}, remove: [], arrays: {}, objects: {} };
  const old = before as unknown as Record<string, unknown>;
  const next = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) writeFieldPatch(patch, key, old, next);
  return patch;
}

function applyObjectDelta(current: unknown, delta: ObjectPatch): Record<string, unknown> {
  const value = { ...(record(current) ? current : {}) };
  for (const removed of delta.remove) delete value[removed];
  return Object.assign(value, delta.set);
}
function applyKeyedDelta(current: unknown, delta: KeyedPatch): Array<{ id: string }> {
  const existing = Array.isArray(current) ? current as Array<{ id: string }> : [];
  const removed = new Set(delta.remove);
  const values = new Map(existing.filter(item => !removed.has(item.id)).map(item => [item.id, item]));
  for (const [id, value] of Object.entries(delta.upsert)) values.set(id, value as { id: string });
  const natural = [...existing.filter(item => values.has(item.id)).map(item => item.id),
    ...Object.keys(delta.upsert).filter(id => !existing.some(item => item.id === id))];
  const order = delta.order ?? natural;
  if (!validKeyedOrder(order, values)) throw new ApiError(503, 'Symbi Reflex workspace journal requires recovery');
  return order.map(id => values.get(id)!);
}
function validKeyedOrder(order: string[], values: Map<string, { id: string }>): boolean {
  return order.length === values.size && new Set(order).size === values.size && order.every(id => values.has(id));
}
export function applyWorkspacePatch(before: JevWorkspaceState, patch: WorkspacePatch, revision: number): JevWorkspaceState {
  const state = { ...before } as unknown as Record<string, unknown>;
  for (const key of patch.remove) delete state[key];
  Object.assign(state, patch.set);
  for (const [key, delta] of Object.entries(patch.objects)) state[key] = applyObjectDelta(state[key], delta);
  for (const [key, delta] of Object.entries(patch.arrays)) state[key] = applyKeyedDelta(state[key], delta);
  state.revision = revision;
  return state as unknown as JevWorkspaceState;
}

function recordHash(record: Omit<WorkspaceJournalRecord, 'hash'>): string { return digest(JSON.stringify(record)); }
export function journalRecord(baseHash: string, previousHash: string,
  before: JevWorkspaceState, after: JevWorkspaceState): WorkspaceJournalRecord {
  const unsigned = { format: 'jev-delta' as const, version: 1 as const, baseHash,
    fromRevision: before.revision, toRevision: after.revision, previousHash, patch: workspacePatch(before, after) };
  const applied = applyWorkspacePatch(before, unsigned.patch, after.revision);
  if (!equal(applied, after)) throw new ApiError(503, 'Symbi Reflex workspace delta could not be verified');
  return { ...unsigned, hash: recordHash(unsigned) };
}

function recordHeader(value: Record<string, unknown>): boolean {
  return value.format === 'jev-delta' && value.version === 1
    && typeof value.baseHash === 'string' && typeof value.previousHash === 'string' && typeof value.hash === 'string';
}
function recordRevisions(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.fromRevision) && Number.isSafeInteger(value.toRevision);
}
function checkedRecord(value: unknown): WorkspaceJournalRecord {
  if (!record(value) || !recordHeader(value) || !recordRevisions(value) || !patchShape(value.patch))
    throw new ApiError(503, 'Symbi Reflex workspace journal requires recovery');
  const { hash, ...unsigned } = value;
  if (hash !== recordHash(unsigned as unknown as Omit<WorkspaceJournalRecord, 'hash'>))
    throw new ApiError(503, 'Symbi Reflex workspace journal requires recovery');
  return value as unknown as WorkspaceJournalRecord;
}
function parsedJournalLine(line: string): WorkspaceJournalRecord {
  if (!line.length) throw new ApiError(503, 'Symbi Reflex workspace journal requires recovery');
  try { return checkedRecord(JSON.parse(line)); }
  catch { throw new ApiError(503, 'Symbi Reflex workspace journal requires recovery'); }
}
function checkedReplayLink(entry: WorkspaceJournalRecord, baseHash: string, previousHash: string, revision: number): void {
  if (entry.baseHash !== baseHash || entry.fromRevision !== revision || entry.toRevision !== revision + 1
    || entry.previousHash !== previousHash) throw new ApiError(503, 'Symbi Reflex workspace journal requires recovery');
}

/** A torn final line is ignored; complete lines are hash-checked and strictly chained. */
export function replayWorkspaceJournal(base: JevWorkspaceState, baseHash: string, content: Buffer): JournalReplay {
  let state = base; let validBytes = 0; let records = 0; let previousHash = baseHash;
  while (validBytes < content.length) {
    const end = content.indexOf(10, validBytes);
    if (end < 0) break;
    const line = content.subarray(validBytes, end).toString('utf8'); validBytes = end + 1;
    const entry = parsedJournalLine(line);
    if (entry.toRevision <= base.revision) continue; // Atomic compaction may leave an older journal behind.
    checkedReplayLink(entry, baseHash, previousHash, state.revision);
    state = applyWorkspacePatch(state, entry.patch, entry.toRevision);
    previousHash = entry.hash; records += 1;
  }
  return { state, validBytes, records, lastHash: previousHash };
}

export async function readJournal(file: string): Promise<Buffer> {
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; }
}

export async function appendJournal(file: string, entry: WorkspaceJournalRecord, validBytes: number,
  currentBytes: number): Promise<void> {
  if (validBytes < currentBytes) await truncate(file, validBytes);
  const handle = await open(file, 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify(entry)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function removeJournal(file: string): Promise<void> {
  await rm(file, { force: true });
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
