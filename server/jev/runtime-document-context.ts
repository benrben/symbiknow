import { createHash } from 'node:crypto';
import type { JevSourceSnapshot } from '../../shared/jev-types.js';
import type { CanvasTask } from '../../shared/types.js';
import { ApiError } from '../errors.js';
import type { JevArtifact } from '../storage-jev-executor.js';
import { contentHash, type StoredBlock } from '../storage-shapes.js';
import type { JevEvaluationContext } from './actions/context.js';
import type { StoredJevReceipt } from './proposals.js';

/** Persisted alongside each document prefix; contains no provider configuration or document content. */
export interface DocumentContextProof {
  version: 1;
  workspaceId: string;
  sources: JevSourceSnapshot[];
  tasks: Record<string, Record<string, string>>;
  canvases: Record<string, string>;
  vocabulary: Record<string, string>;
}

function conflict(): never { throw new ApiError(409, 'The document context changed during automatic processing'); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}
function text(value: unknown): string { return JSON.stringify(canonical(value)); }
function hash(value: unknown): string { return createHash('sha256').update(text(value)).digest('hex'); }
function sourceKey(source: JevSourceSnapshot): string { return `${source.canvasId}:${source.blockId}:${source.incarnation}`; }
function sorted(sources: JevSourceSnapshot[]): JevSourceSnapshot[] { return sources.sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))); }
function taskHashes(tasks: CanvasTask[]): Record<string, string> {
  const result = Object.fromEntries(tasks.map(task => [task.id, hash(task)]));
  if (Object.keys(result).length !== tasks.length) conflict();
  return result;
}

export function snapshotDocumentContext(context: JevEvaluationContext): DocumentContextProof {
  const tasks = Object.fromEntries(context.canvases.map(canvas => [canvas.id,
    taskHashes(context.tasks.filter(item => item.canvasId === canvas.id).map(item => item.task))]));
  return { version: 1, workspaceId: context.workspaceId, sources: sorted(structuredClone(context.documents.map(document => document.snapshot))),
    tasks, canvases: Object.fromEntries(context.canvases.map(canvas => [canvas.id, hash(canvas)])),
    vocabulary: Object.fromEntries(context.vocabulary.map(term => [term.id, hash(term)])) };
}

export function assertDocumentContext(expected: DocumentContextProof, context: JevEvaluationContext): void {
  if (!expected || expected.version !== 1 || text(expected) !== text(snapshotDocumentContext(context))) conflict();
}

function artifactSource(proof: DocumentContextProof, receipt: StoredJevReceipt, canvasId: string, block: StoredBlock,
  side: 'before' | 'after'): JevSourceSnapshot {
  const known = [...proof.sources, ...receipt.sourcesAfter].find(source => source.blockId === block.id && source.incarnation === block.incarnation);
  const content = receipt.preparedArtifacts?.find((artifact): artifact is Extract<JevArtifact, { kind: 'content' }> =>
    artifact.kind === 'content' && artifact.id === block.id);
  if (!known || !block.incarnation || !Number.isSafeInteger(block.sourceGeneration) || !Number.isSafeInteger(block.metadataRevision)) conflict();
  return { workspaceId: proof.workspaceId, canvasId, blockId: block.id, incarnation: block.incarnation,
    sourceGeneration: block.sourceGeneration!, metadataRevision: block.metadataRevision!, contentHash: content ? contentHash(content[side]) : known.contentHash };
}

function canvasSources(proof: DocumentContextProof, receipt: StoredJevReceipt, side: 'before' | 'after'): JevSourceSnapshot[] {
  return sorted(receipt.preparedArtifacts!.flatMap(artifact => {
    if (artifact.kind !== 'canvas') return [];
    const canvas = artifact[side];
    if (!Object.hasOwn(proof.canvases, artifact.id) || canvas.id !== artifact.id || canvas.workspaceId !== proof.workspaceId) conflict();
    return canvas.blocks.filter(block => !block.processingExcluded).map(block => artifactSource(proof, receipt, canvas.id, block, side));
  }));
}

function advanceSources(proof: DocumentContextProof, receipt: StoredJevReceipt): void {
  const canvases = new Set(receipt.preparedArtifacts!.filter(artifact => artifact.kind === 'canvas').map(artifact => artifact.id));
  if (!canvases.size) return;
  const actual = sorted(proof.sources.filter(source => canvases.has(source.canvasId)));
  const before = canvasSources(proof, receipt, 'before'); const after = canvasSources(proof, receipt, 'after');
  // Full membership and counters prevent an own artifact from adopting unrelated intervening edits.
  if (text(actual) !== text(before) && text(actual) !== text(after)) conflict();
  proof.sources = sorted([...proof.sources.filter(source => !canvases.has(source.canvasId)), ...after]);
}

function advanceTasks(proof: DocumentContextProof, receipt: StoredJevReceipt): void {
  for (const artifact of receipt.preparedArtifacts!) {
    if (artifact.kind !== 'tasks') continue;
    if (!Object.hasOwn(proof.tasks, artifact.id)) conflict();
    const actual = text(proof.tasks[artifact.id]); const before = taskHashes(artifact.before); const after = taskHashes(artifact.after);
    if (actual !== text(before) && actual !== text(after)) conflict();
    proof.tasks[artifact.id] = after;
  }
}

function vocabularyHashes(receipt: StoredJevReceipt): { id: string; previous?: string; next?: string } {
  const { before, after } = receipt;
  if (before.kind !== 'vocabulary' || after.kind !== 'vocabulary' || before.term.id !== after.term.id) conflict();
  // The inverse's remove means the term was absent; every other operation restores its exact prior value.
  return { id: after.term.id, previous: before.operation === 'remove' ? undefined : hash(before.term),
    next: after.operation === 'remove' ? undefined : hash(after.term) };
}

function advanceVocabulary(proof: DocumentContextProof, receipt: StoredJevReceipt): void {
  const { id, previous, next } = vocabularyHashes(receipt);
  const current = Object.hasOwn(proof.vocabulary, id) ? proof.vocabulary[id] : undefined;
  if (current !== previous && current !== next) conflict();
  if (next === undefined) delete proof.vocabulary[id];
  else Object.defineProperty(proof.vocabulary, id, { value: next, enumerable: true, writable: true, configurable: true });
}

function advanceReceipt(proof: DocumentContextProof, receipt: StoredJevReceipt): void {
  if (receipt.state !== 'applied') conflict();
  if (receipt.after.kind === 'derived') return;
  if (receipt.after.kind === 'vocabulary') { advanceVocabulary(proof, receipt); return; }
  if (!receipt.preparedArtifacts?.length) conflict();
  advanceSources(proof, receipt);
  advanceTasks(proof, receipt);
}

/** Caller supplies only applied receipts belonging to the active document intent, in durable order. */
export function advanceDocumentContext(expected: DocumentContextProof, receipts: StoredJevReceipt[]): DocumentContextProof {
  if (!expected || expected.version !== 1 || !expected.vocabulary || typeof expected.vocabulary !== 'object') conflict();
  const projected = structuredClone(expected);
  for (const receipt of receipts) advanceReceipt(projected, receipt);
  return projected;
}
