import { isDeepStrictEqual } from 'node:util';
import type { JevMutation, JevOwnership, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import type { StoredJevReceipt } from './proposals.js';
import { ApiError } from '../errors.js';
import { mutationCanvases, requireCanvas } from './authorization.js';
import { sourceSnapshot } from './stamps.js';
import { checkTaskArtifactInverse } from './move-task-inverse.js';

function affectedField(field: string, fields: string[], canvasId: string): boolean {
  if (fields.includes(field)) return true;
  if (!field.startsWith('link:')) return false;
  return fields.includes(field.startsWith(`link:${canvasId}:`) ? 'links' : 'crossLinks');
}
export function inverseOwnership(current: JevOwnership | undefined, before: JevOwnership | undefined, mutation: JevMutation): JevOwnership | undefined {
  if (!current || !before || mutation.kind !== 'document') return before;
  const fields = Object.keys(mutation.patch).map(field => field === 'linkTypes' ? 'links' : field);
  const affected = (field: string) => affectedField(field, fields, mutation.canvasId);
  const merge = (now: string[], old: string[]) => [...now.filter(field => !affected(field)), ...old.filter(affected)];
  const localLink = (link: string) => fields.includes(link.includes(':') ? 'crossLinks' : 'links');
  return { pins: merge(current.pins, before.pins), managed: merge(current.managed, before.managed),
    removedLabels: fields.includes('tags') ? before.removedLabels : current.removedLabels,
    removedLinks: [...current.removedLinks.filter(link => !localLink(link)), ...before.removedLinks.filter(localLink)] };
}
function changedVocabulary(state: JevWorkspaceState, receipt: StoredJevReceipt): boolean {
  if (receipt.after.kind !== 'vocabulary') return false;
  const after = receipt.after;
  const current = state.vocabulary.find(term => term.id === after.term.id);
  return !isDeepStrictEqual(current, after.operation === 'remove' ? undefined : after.term);
}
export function checkReceiptState(state: JevWorkspaceState, receipt: StoredJevReceipt): void {
  if (state.settings.paused) throw new ApiError(409, 'Symbi Reflex is paused');
  if (receipt.state === 'undone') return;
  if (changedVocabulary(state, receipt)) throw new ApiError(409, 'Vocabulary changed after this action; Undo is unavailable');
}
export function receiptCanvases(receipt: StoredJevReceipt): string[] {
  return [...mutationCanvases(receipt.after), ...receipt.sourcesAfter.map(source => source.canvasId)];
}
export function authorizeReceipt(receipt: StoredJevReceipt, principal: Parameters<typeof requireCanvas>[0]): void {
  for (const id of receiptCanvases(receipt)) requireCanvas(principal, id);
}
async function checkTasks(store: CanvasStore, receipt: StoredJevReceipt): Promise<void> {
  for (const artifact of receipt.preparedArtifacts ?? []) {
    if (artifact.kind !== 'tasks') continue;
    checkTaskArtifactInverse(await store.listTasks(artifact.id), artifact);
  }
}
function sameValue(value: unknown, expected: unknown): boolean { return isDeepStrictEqual(value ?? null, expected ?? null); }
function savedDocument(receipt: StoredJevReceipt, canvasId: string, blockId: string) {
  const artifact = receipt.preparedArtifacts?.find(item => item.kind === 'canvas' && item.id === canvasId);
  return artifact?.kind === 'canvas' ? artifact.after.blocks.find(item => item.id === blockId) : undefined;
}
async function checkDocument(store: CanvasStore, receipt: StoredJevReceipt): Promise<void> {
  if (receipt.after.kind !== 'document') return;
  const after = receipt.after;
  const block = (await store.getCanvas(after.canvasId, true)).blocks.find(item => item.id === after.blockId);
  if (!block) throw new ApiError(409, 'Document no longer exists');
  const fields = Object.keys(after.patch) as Array<keyof typeof after.patch>;
  const saved = savedDocument(receipt, after.canvasId, block.id);
  const expected = saved ?? after.patch;
  if (fields.some(field => !sameValue(block[field], expected[field]))) throw new ApiError(409, 'A later correction prevents this Undo');
  if (fields.some(field => Boolean(block.jevOwnership?.pins.includes(field)) !== Boolean(saved?.jevOwnership?.pins.includes(field)))) throw new ApiError(409, 'A later pin prevents this Undo');
}
export async function checkReceiptInverse(store: CanvasStore, receipt: StoredJevReceipt): Promise<void> {
  await checkTasks(store, receipt); await checkDocument(store, receipt);
}
export async function inverseSources(store: CanvasStore, workspaceId: string, receipt: StoredJevReceipt): Promise<JevSourceSnapshot[]> {
  const sources: JevSourceSnapshot[] = [];
  for (const expected of receipt.sourcesAfter) {
    const block = (await store.getCanvas(expected.canvasId, true)).blocks.find(item => item.id === expected.blockId);
    if (!block || block.incarnation !== expected.incarnation || block.sourceGeneration !== expected.sourceGeneration) throw new ApiError(409, 'The source changed after this action');
    sources.push(sourceSnapshot(workspaceId, expected.canvasId, block));
  }
  return sources;
}
export function versionInverse(state: JevWorkspaceState, mutation: JevMutation): void {
  if (mutation.kind !== 'vocabulary' || mutation.operation === 'remove') return;
  const current = state.vocabulary.find(term => term.id === mutation.term.id);
  mutation.term = { ...mutation.term, version: (current?.version ?? 0) + 1 };
}
