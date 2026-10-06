import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CanvasTask } from '../../shared/types.js';
import type { JevVocabularyTerm, JevWorkspaceState } from '../../shared/jev-types.js';
import { groupPath, normalizedGroup } from '../../shared/groups.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import type { JevArtifact } from '../storage-jev-executor.js';
import { validId, type StoredBlock, type StoredCanvas } from '../storage-shapes.js';
import { trustedManagedOrigin } from './approval-origin.js';
import { metadataFields } from './mutations.js';
import type { StoredJevReceipt } from './proposals.js';
import { validateVocabularyMutation } from './vocabulary.js';
import type { JevWorkspaceFiles } from './workspace.js';

type ResetArtifact = Exclude<JevArtifact, { kind: 'content' }>;
type DocumentReceipt = StoredJevReceipt & { after: Extract<StoredJevReceipt['after'], { kind: 'document' }> };
type VocabularyReceipt = StoredJevReceipt & { after: Extract<StoredJevReceipt['after'], { kind: 'vocabulary' }> };
export interface JevResetJournal {
  schemaVersion: 1;
  id: string;
  canvasIds: string[];
  documentCount: number;
  artifacts: ResetArtifact[];
  vocabularyAfter: JevVocabularyTerm[];
  checksum: string;
}
/** The recovery journal stays server-side, like prepared canonical mutations. */
export type StoredJevResetWorkspace = JevWorkspaceState & { resetJournal?: JevResetJournal };

function trusted(state: JevWorkspaceState, receipt: StoredJevReceipt): boolean {
  const proposal = state.proposals.find(item => item.id === receipt.proposalId);
  if (proposal?.reviewerEdited) return false;
  return receipt.automatic === true || Boolean(proposal && trustedManagedOrigin(proposal));
}
function same(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left ?? null, right ?? null); }
function documentReceipts(state: JevWorkspaceState, block: StoredBlock): DocumentReceipt[] {
  return (state.receipts as StoredJevReceipt[]).filter((receipt): receipt is DocumentReceipt =>
    receipt.state === 'applied' && receipt.after.kind === 'document' && receipt.after.blockId === block.id).reverse();
}
function receiptBlock(receipt: DocumentReceipt, phase: 'before' | 'after'): StoredBlock | undefined {
  const artifact = receipt.preparedArtifacts?.find(item => item.kind === 'canvas' && item.id === receipt.after.canvasId);
  return artifact?.kind === 'canvas' ? artifact[phase].blocks.find(item => item.id === receipt.after.blockId) : undefined;
}
function sameIncarnation(block: StoredBlock, before?: StoredBlock, after?: StoredBlock): boolean {
  return Boolean(before && after && before.incarnation === block.incarnation && after.incarnation === block.incarnation);
}
function pinned(block: StoredBlock, field: string): boolean {
  const pins = block.jevOwnership!.pins;
  return pins.includes(field) || (field === 'linkTypes' && pins.includes('links')) || (field === 'links' && pins.includes('linkTypes'));
}
function restoreField(block: StoredBlock, field: string, value: unknown): void {
  const record = block as unknown as Record<string, unknown>;
  if (value === undefined) delete record[field];
  else record[field] = structuredClone(value);
}
function resetField(state: JevWorkspaceState, block: StoredBlock, field: string, receipts: DocumentReceipt[]): void {
  if (!block.jevOwnership || pinned(block, field) || !managed(block, field)) return;
  for (const receipt of receipts.filter(item => Object.hasOwn(item.after.patch, field))) {
    const before = receiptBlock(receipt, 'before'); const after = receiptBlock(receipt, 'after');
    if (!checkedField(state, block, field, receipt, before, after)) break;
    restoreField(block, field, before![field as keyof StoredBlock]);
  }
}
function managed(block: StoredBlock, field: string): boolean {
  return block.jevOwnership!.managed.includes(field === 'linkTypes' ? 'links' : field);
}
function checkedField(state: JevWorkspaceState, block: StoredBlock, field: string, receipt: DocumentReceipt,
  before?: StoredBlock, after?: StoredBlock): boolean {
  return trusted(state, receipt) && sameIncarnation(block, before, after)
    && same(block[field as keyof StoredBlock], after![field as keyof StoredBlock]);
}
function existingLink(block: StoredBlock, canvasId: string, marker: string): boolean {
  if (!marker.startsWith('link:')) return true;
  const [, targetCanvas, targetBlock] = marker.split(':');
  if (targetCanvas === canvasId) return block.links.includes(targetBlock);
  return Boolean(block.crossLinks?.some(link => link.canvasId === targetCanvas && link.blockId === targetBlock));
}
function resetBlock(state: JevWorkspaceState, block: StoredBlock, canvasId: string): StoredBlock {
  const after = structuredClone(block); const receipts = documentReceipts(state, block);
  for (const field of metadataFields) resetField(state, after, field, receipts);
  if (isDeepStrictEqual(after, block)) return after;
  after.metadataRevision = (block.metadataRevision ?? 0) + 1;
  delete after.jevMutationId;
  after.jevOwnership!.managed = after.jevOwnership!.managed.filter(marker => existingLink(after, canvasId, marker));
  return after;
}
function taskSnapshot(receipt: StoredJevReceipt, canvasId: string, taskId: string, phase: 'before' | 'after'): CanvasTask | undefined {
  const artifact = receipt.preparedArtifacts?.find(item => item.kind === 'tasks' && item.id === canvasId);
  return artifact?.kind === 'tasks' ? artifact[phase].find(task => task.id === taskId) : undefined;
}
function taskReceipt(state: JevWorkspaceState, task: CanvasTask, canvasId: string): StoredJevReceipt | undefined {
  const receipt = state.receipts.find(item => item.state === 'applied' && item.id === task.jevMutationId) as StoredJevReceipt | undefined;
  if (!receipt || !trusted(state, receipt)) return undefined;
  const mutation = receipt.after;
  if (!taskMutation(mutation)) return undefined;
  if (mutation.canvasId !== canvasId) return undefined;
  return same(taskSnapshot(receipt, canvasId, task.id, 'after'), task) ? receipt : undefined;
}
function taskMutation(mutation: StoredJevReceipt['after']): mutation is Extract<StoredJevReceipt['after'], { kind: 'task_update' | 'task_create' }> {
  return mutation.kind === 'task_update' || mutation.kind === 'task_create';
}
function resetTask(state: JevWorkspaceState, task: CanvasTask, canvasId: string): CanvasTask {
  const after = structuredClone(task); const seen = new Set<string>();
  let previous: CanvasTask | undefined = task;
  while (previous && !seen.has(previous.jevMutationId ?? '')) {
    const receipt = taskReceipt(state, previous, canvasId);
    if (!receipt) break;
    seen.add(receipt.id);
    const before = taskSnapshot(receipt, canvasId, task.id, 'before');
    for (const field of ['blockIds', 'assignee', 'reviewer'] as const) {
      restoreTaskField(after, field, before);
    }
    previous = before;
  }
  return finalizedTask(task, after);
}
function finalizedTask(task: CanvasTask, after: CanvasTask): CanvasTask {
  if (isDeepStrictEqual(after, task)) return after;
  after.revision = (task.revision ?? 0) + 1;
  after.updatedAt = new Date().toISOString(); after.updatedBy = 'workspace-automation';
  delete after.jevMutationId;
  return after;
}
function restoreTaskField(task: CanvasTask, field: 'blockIds' | 'assignee' | 'reviewer', before?: CanvasTask): void {
  if (field === 'blockIds') { task.blockIds = structuredClone(before?.blockIds ?? []); return; }
  if (before?.[field] === undefined) delete task[field];
  else task[field] = before[field];
}
function vocabularyReceipts(state: JevWorkspaceState): VocabularyReceipt[] {
  return (state.receipts as StoredJevReceipt[]).filter((receipt): receipt is VocabularyReceipt =>
    receipt.state === 'applied' && receipt.after.kind === 'vocabulary').reverse();
}
function previousTerm(receipt: VocabularyReceipt): JevVocabularyTerm | undefined {
  return receipt.before.kind === 'vocabulary' && receipt.before.operation !== 'remove' ? receipt.before.term : undefined;
}
function resetVocabulary(state: JevWorkspaceState): JevVocabularyTerm[] {
  const terms = new Map(state.vocabulary.map(term => [term.id, term])); const settled = new Set<string>();
  for (const receipt of vocabularyReceipts(state)) {
    const id = receipt.after.term.id;
    if (settled.has(id)) continue;
    if (!restoreVocabularyTerm(state, terms, receipt)) settled.add(id);
  }
  return [...terms.values()];
}
function restoreVocabularyTerm(state: JevWorkspaceState, terms: Map<string, JevVocabularyTerm>, receipt: VocabularyReceipt): boolean {
  const id = receipt.after.term.id;
  const expected = receipt.after.operation === 'remove' ? undefined : receipt.after.term;
  if (!trusted(state, receipt) || !same(terms.get(id), expected)) return false;
  const before = previousTerm(receipt);
  if (before) terms.set(id, before); else terms.delete(id);
  return true;
}
function usedTerm(term: JevVocabularyTerm, blocks: StoredBlock[]): boolean {
  if (term.kind === 'group') return blocks.some(block => block.group && groupPath(block.group).includes(normalizedGroup(term.groupKey) ?? ''));
  if (term.kind === 'label') return blocks.some(block => block.tags?.includes(term.name));
  return false;
}
function keepReferencedTerms(state: JevWorkspaceState, vocabulary: JevVocabularyTerm[], canvases: StoredCanvas[]): JevVocabularyTerm[] {
  const terms = new Map(vocabulary.map(term => [term.id, term])); const blocks = canvases.flatMap(canvas => canvas.blocks);
  for (const term of state.vocabulary) if (usedTerm(term, blocks)) terms.set(term.id, term);
  for (const term of terms.values()) keepParents(term, terms, state.vocabulary);
  return [...terms.values()];
}
function keepParents(term: JevVocabularyTerm, terms: Map<string, JevVocabularyTerm>, original: JevVocabularyTerm[]): void {
  const seen = new Set<string>(); let parentId = term.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = terms.get(parentId) ?? original.find(item => item.id === parentId);
    if (!parent) break;
    terms.set(parent.id, parent); parentId = parent.parentId;
  }
}
async function readArtifact<T>(store: CanvasStore, directory: string, id: string): Promise<T> {
  if (!validId(id)) throw new ApiError(503, 'Invalid Reflex reset target');
  return JSON.parse(await readFile(path.join(store.root, directory, `${id}.json`), 'utf8')) as T;
}
async function readTasks(store: CanvasStore, canvasId: string): Promise<CanvasTask[]> {
  try { return await readArtifact<CanvasTask[]>(store, 'tasks', canvasId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function changedArtifact(artifacts: ResetArtifact[], artifact: ResetArtifact): void {
  if (!isDeepStrictEqual(artifact.before, artifact.after)) artifacts.push(artifact);
}
function checksum(journal: Omit<JevResetJournal, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(journal)).digest('hex');
}
/** Build from native saved metadata; hydrated reads must never drop stale manual references. */
export async function prepareJevReset(store: CanvasStore, workspaceId: string, state: JevWorkspaceState): Promise<JevResetJournal> {
  const workspace = (await store.listWorkspaces()).find(item => item.id === workspaceId);
  if (!workspace) throw new ApiError(404, 'Workspace not found');
  const artifacts: ResetArtifact[] = []; const canvases: StoredCanvas[] = [];
  for (const item of workspace.canvases) {
    const before = await readArtifact<StoredCanvas>(store, 'canvases', item.id);
    if (before.workspaceId !== workspaceId) throw new ApiError(503, 'Reflex reset canvas scope requires recovery');
    const after = { ...before, blocks: before.blocks.map(block => resetBlock(state, block, item.id)) };
    changedArtifact(artifacts, { kind: 'canvas', id: item.id, before, after }); canvases.push(after);
    const tasks = await readTasks(store, item.id);
    changedArtifact(artifacts, { kind: 'tasks', id: item.id, before: tasks, after: tasks.map(task => resetTask(state, task, item.id)) });
  }
  const journal: Omit<JevResetJournal, 'checksum'> = { schemaVersion: 1, id: randomUUID(),
    canvasIds: canvases.map(canvas => canvas.id), documentCount: canvases.reduce((count, canvas) => count + canvas.blocks.length, 0),
    artifacts, vocabularyAfter: keepReferencedTerms(state, resetVocabulary(state), canvases) };
  return { ...journal, checksum: checksum(journal) };
}

const identifier = z.string().refine(validId);
const canvasSchema = z.object({ id: identifier, workspaceId: identifier, name: z.string(), blocks: z.array(z.object({ id: identifier }).passthrough()) }).passthrough();
const tasksSchema = z.array(z.object({ id: identifier }).passthrough());
const journalSchema = z.object({ schemaVersion: z.literal(1), id: z.string().uuid(), canvasIds: z.array(identifier),
  documentCount: z.number().int().nonnegative(), checksum: z.string().length(64), vocabularyAfter: z.array(z.unknown()),
  artifacts: z.array(z.discriminatedUnion('kind', [z.object({ kind: z.literal('canvas'), id: identifier, before: canvasSchema, after: canvasSchema }),
    z.object({ kind: z.literal('tasks'), id: identifier, before: tasksSchema, after: tasksSchema })])) });
function checkJournal(journal: JevResetJournal, workspaceId: string): void {
  if (!journalSchema.safeParse(journal).success) throw new ApiError(503, 'Reflex reset journal requires recovery');
  const { checksum: saved, ...payload } = journal;
  if (checksum(payload) !== saved) throw new ApiError(503, 'Reflex reset journal requires recovery');
  for (const artifact of journal.artifacts) checkScope(artifact, workspaceId, journal.canvasIds);
  checkTerms(journal.vocabularyAfter);
}
function checkTerms(terms: JevVocabularyTerm[]): void {
  try { for (const term of terms) validateVocabularyMutation({ kind: 'vocabulary', operation: 'restore', term }); }
  catch { throw new ApiError(503, 'Reflex reset vocabulary requires recovery'); }
}
function checkScope(artifact: ResetArtifact, workspaceId: string, canvasIds: string[]): void {
  if (!canvasIds.includes(artifact.id)) throw new ApiError(503, 'Reflex reset artifact is outside its workspace');
  if (artifact.kind !== 'canvas') return;
  checkCanvasIdentity(artifact);
  if (artifact.before.workspaceId !== workspaceId || artifact.after.workspaceId !== workspaceId) throw new ApiError(503, 'Reflex reset artifact is outside its workspace');
}
function checkCanvasIdentity(artifact: Extract<ResetArtifact, { kind: 'canvas' }>): void {
  if (artifact.before.id !== artifact.id || artifact.after.id !== artifact.id) throw new ApiError(503, 'Reflex reset canvas identity changed');
}
function clearedWorkspace(state: StoredJevResetWorkspace, journal: JevResetJournal): StoredJevResetWorkspace {
  const proposalIds = new Set(state.receipts.map(receipt => receipt.proposalId));
  const after = { ...state, settings: { ...state.settings, paused: false }, jobs: [], profiles: {}, proposals: state.proposals.filter(proposal => proposalIds.has(proposal.id)),
    vocabulary: journal.vocabularyAfter, prepared: [] };
  delete after.resetJournal; delete after.commandPlans;
  return after;
}
/** Caller holds the workspace queue; canonical serialization blocks concurrent native writes. */
export async function recoverJevResetInside(store: CanvasStore, files: JevWorkspaceFiles, workspaceId: string): Promise<boolean> {
  return store.jevExecutor.serialized(async () => {
    const state = await files.read(workspaceId) as StoredJevResetWorkspace;
    if (state.resetJournal === undefined) return false;
    const journal = state.resetJournal; checkJournal(journal, workspaceId);
    await store.jevExecutor.recover(journal.artifacts);
    for (const canvasId of journal.canvasIds) await rm(path.join(store.root, 'jev-cache', `${canvasId}.json`), { force: true });
    await files.write(workspaceId, clearedWorkspace(state, journal));
    for (const canvasId of journal.canvasIds) store.similarityIndex(workspaceId).clearCanvas(canvasId);
    return true;
  });
}
export function withoutJevResetJournal(state: JevWorkspaceState): JevWorkspaceState {
  const visible = { ...state } as StoredJevResetWorkspace;
  delete visible.resetJournal;
  return visible;
}
/** Persist the entire cleanup plan before the first artifact write, then finish or resume it. */
export async function resetJevWorkspaceInside(store: CanvasStore, files: JevWorkspaceFiles, workspaceId: string): Promise<JevResetJournal> {
  return store.jevExecutor.serialized(async () => {
    const state = await files.read(workspaceId) as StoredJevResetWorkspace;
    if (state.prepared.length) throw new ApiError(409, 'Recover pending Reflex changes before resetting');
    const journal = state.resetJournal ?? await prepareJevReset(store, workspaceId, state);
    state.resetJournal = journal; state.settings.paused = true;
    await files.write(workspaceId, state);
    await recoverJevResetInside(store, files, workspaceId);
    return journal;
  });
}
