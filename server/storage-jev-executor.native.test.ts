import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasBlock, CanvasTask } from '../shared/types.js';
import type { JevMutation, JevOwnership, JevSourceSnapshot } from '../shared/jev-types.js';
import { CanvasStore, contentHash } from './storage.js';
import { atomicJson, StorageFiles } from './storage-files.js';
import type { StorageContext } from './storage-context.js';
import { StorageJevExecutor, type JevArtifact, type JevCanonicalPreparation } from './storage-jev-executor.js';
import { StorageJevTasks } from './storage-jev-tasks.js';
import { StorageTasks } from './storage-tasks.js';
import { sourceSnapshot } from './jev/stamps.js';
import { readJevDraft, setJevDraftState, stageJevDraft } from './jev/drafts.js';
import { subscribeJevStore, type JevStoreEvent } from './jev/events.js';
import { DocumentVersions } from './version-control.js';

let root: string;
let store: CanvasStore;
let files: StorageFiles;
let context: StorageContext;
let workspaceId: string;
let canvasId: string;
let targetCanvasId: string;
let block: CanvasBlock;
let sibling: CanvasBlock;
let target: CanvasBlock;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-canonical-native-'));
  store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Canonical review' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  targetCanvasId = (await store.createCanvas(workspaceId, { name: 'Delivery' })).id;
  block = await store.createBlock(canvasId, { title: 'Source', content: '# Source\nA declared delivery requirement.' });
  sibling = await store.createBlock(canvasId, { title: 'Sibling', content: '# Sibling\nKeep this source intact.' });
  target = await store.createBlock(targetCanvasId, { title: 'Target', content: '# Target\nDelivery reference.' });
  files = new StorageFiles(root, store.locks);
  context = { files, locks: store.locks, getCanvas: (id, archived) => store.getCanvas(id, archived),
    getCanvasSummary: id => store.getCanvasSummary(id), listWorkspaces: () => store.listWorkspaces(), listTasks: id => store.listTasks(id),
    writeTaskSnapshot: (id, before, after, actor) => new StorageTasks(context).writeTaskSnapshot(id, before, after, actor) };
});
afterEach(async () => { await files.serialize(async () => undefined); await rm(root, { recursive: true, force: true }); });

async function snapshot(canvas = canvasId, id = block.id): Promise<JevSourceSnapshot> {
  const document = await store.getCanvas(canvas, true);
  return sourceSnapshot(document.workspaceId, canvas, document.blocks.find(item => item.id === id)!);
}
async function persist(plan: JevCanonicalPreparation): Promise<void> {
  await writeFile(path.join(root, 'prepared.json'), JSON.stringify(plan));
}
async function execute(mutation: JevMutation, options: { managed?: boolean; ownership?: JevOwnership; undo?: boolean;
  prepare?: (plan: JevCanonicalPreparation) => Promise<void>; sources?: JevSourceSnapshot[]; executor?: StorageJevExecutor } = {}) {
  const sources = options.sources ?? (['document', 'content', 'move'].includes(mutation.kind)
    ? [await snapshot((mutation as { canvasId: string }).canvasId, (mutation as { blockId: string }).blockId)] : []);
  return (options.executor ?? store.jevExecutor).execute(mutation, sources, 'native-operation', 'reviewer', options.managed ?? false,
    options.prepare ?? persist, options.ownership, options.undo ?? false);
}
async function readyDraft(): Promise<Extract<JevMutation, { kind: 'content' }>> {
  const source = await snapshot();
  const current = (await store.getCanvas(canvasId, true)).blocks.find(item => item.id === block.id)!;
  const draft = await stageJevDraft(root, source, { id: 'native-draft', baseContent: current.content,
    proposedContent: '# Reviewed source\nA clarified delivery requirement.', instruction: 'Clarify the heading' }, 'agent');
  await setJevDraftState(root, canvasId, block.id, draft.id, 'ready', draft.generation);
  return { kind: 'content', canvasId, blockId: block.id, content: draft.proposedContent, expectedContentHash: source.contentHash, draftId: draft.id };
}
const draftFile = () => path.join(root, 'jev', 'drafts', canvasId, `${block.id}.json`);

it('checks native source scope, disappearance and mutation kinds before preparation or writes', async () => {
  const source = await snapshot();
  await expect(store.jevExecutor.checkSources([{ ...source, workspaceId: 'other-workspace' }])).rejects.toMatchObject({ status: 404 });
  await expect(store.jevExecutor.checkSources([{ ...source, blockId: 'missing-document' }])).rejects.toMatchObject({ status: 404 });
  await expect(execute({ kind: 'derived', values: {} })).rejects.toMatchObject({ status: 400 });
  await expect(execute({ kind: 'document', canvasId, blockId: block.id, patch: { title: 'Unexpected replacement' } } as unknown as JevMutation))
    .rejects.toMatchObject({ status: 400 });
  await expect(execute({ kind: 'document', canvasId, blockId: 'missing-document', patch: { headline: 'Missing' } }, { sources: [] }))
    .rejects.toMatchObject({ status: 404 });
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(block.content);
  await expect(readFile(path.join(root, 'prepared.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('continues the real serialized writer queue after a failed durable preparation', async () => {
  const directory = path.join(root, 'serialized-journal'); await mkdir(directory);
  const failed = store.jevExecutor.serialized(() => writeFile(directory, 'Cannot replace a directory'));
  const next = store.jevExecutor.serialized(() => writeFile(path.join(root, 'serialized-success'), 'The queue resumed'));
  await expect(failed).rejects.toMatchObject({ code: 'EISDIR' }); await next;
  expect(await readFile(path.join(root, 'serialized-success'), 'utf8')).toBe('The queue resumed');
});

it('commits reviewed metadata, nullable restoration and exact manual ownership without touching source bytes', async () => {
  await store.updateBlock(canvasId, block.id, { tags: ['manual'], quality: { score: 0.8, at: '2026-10-03T00:00:00Z' },
    crossLinks: [{ canvasId: targetCanvasId, blockId: target.id, relation: 'related' }] });
  const cleared = await execute({ kind: 'document', canvasId, blockId: block.id, patch: { tags: null, quality: null, crossLinks: null } });
  const saved = await store.getCanvasBlock(canvasId, block.id);
  expect(saved.tags).toBeUndefined(); expect(saved.quality).toBeUndefined(); expect(saved.crossLinks).toBeUndefined();
  expect(cleared.before).toMatchObject({ patch: { tags: ['manual'], quality: { score: 0.8 }, crossLinks: [{ blockId: target.id }] } });
  await execute(cleared.before, { undo: true, ownership: cleared.ownershipBefore });
  expect(await store.getCanvasBlock(canvasId, block.id)).toMatchObject({ tags: ['manual'], quality: { score: 0.8 }, content: block.content });
  const source = await snapshot();
  const ownership: JevOwnership = { pins: ['headline'], managed: [], removedLabels: [], removedLinks: [] };
  await execute({ kind: 'document', canvasId, blockId: block.id, patch: {} }, { ownership });
  expect(await store.getCanvasBlock(canvasId, block.id)).toMatchObject({ jevOwnership: ownership, metadataRevision: source.metadataRevision + 1 });
  const current = await snapshot();
  await execute({ kind: 'document', canvasId, blockId: block.id, patch: {} }, { ownership });
  expect((await snapshot()).metadataRevision).toBe(current.metadataRevision);
  await expect(execute({ kind: 'document', canvasId, blockId: block.id,
    patch: { crossLinks: [{ canvasId: targetCanvasId, blockId: 'missing-target' }] } })).rejects.toMatchObject({ status: 409 });
  expect((await store.getCanvasBlock(canvasId, block.id)).crossLinks?.[0].blockId).toBe(target.id);
});

it('rejects absent, mismatched, incomplete, expired and stale reviewed drafts before canonical content writes', async () => {
  const mutation: Extract<JevMutation, { kind: 'content' }> = { kind: 'content', canvasId, blockId: block.id,
    content: '# Reviewed source', expectedContentHash: contentHash(block.content), draftId: 'native-draft' };
  await expect(execute(mutation)).rejects.toMatchObject({ status: 409 });
  const ready = await readyDraft(); const original = JSON.parse(await readFile(draftFile(), 'utf8'));
  const invalid = [{ id: 'another-draft' }, { state: 'held' }, { proposedContent: '# Different proposal' },
    { baseContent: '# Different base' }, { expiresAt: '2000-01-01T00:00:00Z' }];
  for (const patch of invalid) {
    await writeFile(draftFile(), JSON.stringify({ ...original, ...patch }));
    await expect(execute(ready)).rejects.toMatchObject({ status: 409 });
    expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(block.content);
  }
  await writeFile(draftFile(), JSON.stringify(original));
  await expect(execute({ ...ready, expectedContentHash: 'stale-hash' })).rejects.toMatchObject({ status: 409 });
  await store.lockBlock(canvasId, block.id, 'another-editor', {});
  await expect(execute(ready)).rejects.toMatchObject({ status: 423 });
});

it('saves reviewed content and its real Git history, publishes the event and restores content through the trusted inverse', async () => {
  const mutation = await readyDraft(); const events: JevStoreEvent[] = [];
  subscribeJevStore(store, async event => { events.push(event); });
  const versions = new DocumentVersions(path.join(root, '.versions', block.id));
  const initialCount = (await versions.status()).commits.length;
  const committed = await execute(mutation);
  expect(await readFile(files.docFile(block.file), 'utf8')).toBe(mutation.content);
  expect((await readJevDraft(root, canvasId, block.id))?.state).toBe('applied');
  expect(committed.sourcesAfter[0]).toMatchObject({ blockId: block.id, contentHash: contentHash(mutation.content), sourceGeneration: block.sourceGeneration! + 1 });
  expect((await versions.status()).commits[0]).toMatchObject({ message: 'Apply reviewed agent draft', author: 'reviewer' });
  expect((await versions.status()).commits).toHaveLength(initialCount + 1);
  expect(events).toContainEqual({ workspaceId, canvasId, blockIds: [block.id], kind: 'source', actor: 'reviewer' });
  await execute(committed.before, { undo: true, ownership: committed.ownershipBefore });
  expect(await readFile(files.docFile(block.file), 'utf8')).toBe(block.content);
  expect((await versions.status()).commits).toHaveLength(initialCount + 2);
  expect((await store.getCanvasBlock(canvasId, sibling.id)).content).toBe(sibling.content);
});

it('requires durable preparation and rejects damaged artifact IDs or paths while preserving primary files', async () => {
  const metadata: JevMutation = { kind: 'document', canvasId, blockId: block.id, patch: { headline: 'A reviewed heading' } };
  const journal = path.join(root, 'blocked-journal'); await mkdir(journal);
  await expect(execute(metadata, { prepare: plan => writeFile(journal, JSON.stringify(plan)) })).rejects.toMatchObject({ code: 'EISDIR' });
  expect((await store.getCanvasBlock(canvasId, block.id)).headline).toBeUndefined();
  await expect(execute(metadata, { prepare: async plan => { await persist(plan); plan.artifacts[0].id = '../outside'; } }))
    .rejects.toMatchObject({ status: 503, message: 'Invalid recovery artifact' });
  expect((await store.getCanvasBlock(canvasId, block.id)).headline).toBeUndefined();
  const content = await readyDraft();
  await expect(execute(content, { prepare: async plan => {
    await persist(plan); const artifact = plan.artifacts.find(item => item.kind === 'content')!;
    if (artifact.kind === 'content') artifact.file = '../outside.md';
  } })).rejects.toMatchObject({ status: 503, message: 'Invalid recovery document path' });
  expect(await readFile(files.docFile(block.file), 'utf8')).toBe(block.content);
  const recorded = JSON.parse(await readFile(path.join(root, 'prepared.json'), 'utf8')) as JevCanonicalPreparation;
  await new CanvasStore(root).jevExecutor.recover(recorded.artifacts);
  expect(await readFile(files.docFile(block.file), 'utf8')).toBe(content.content);
  await expect(readFile(path.join(root, 'outside.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('recovers a genuinely prepared content journal from reserved state, including history, notification and idempotent replay', async () => {
  const mutation = await readyDraft();
  await expect(execute(mutation, { prepare: async plan => { await persist(plan); throw new Error('Process interrupted after prepare'); } }))
    .rejects.toThrow('Process interrupted after prepare');
  const recorded = JSON.parse(await readFile(path.join(root, 'prepared.json'), 'utf8')) as JevCanonicalPreparation;
  const reservation = recorded.artifacts.find(item => item.kind === 'canvas')!;
  if (reservation.kind !== 'canvas') throw new Error('Expected reserved canvas');
  await atomicJson(files.canvasFile(canvasId), reservation.reserved);
  const restarted = new CanvasStore(root); const events: JevStoreEvent[] = [];
  subscribeJevStore(restarted, async event => { events.push(event); });
  await restarted.jevExecutor.recover(recorded.artifacts); await restarted.jevExecutor.recovered(mutation, 'recovery-worker');
  expect((await restarted.getCanvasBlock(canvasId, block.id)).content).toBe(mutation.content);
  expect((await readJevDraft(root, canvasId, block.id))?.state).toBe('applied');
  expect(events).toContainEqual({ workspaceId, canvasId, blockIds: [block.id], kind: 'source', actor: 'recovery-worker' });
  const versions = new DocumentVersions(path.join(root, '.versions', block.id));
  expect((await versions.status()).commits[0]).toMatchObject({ message: 'Recover reviewed agent draft', author: 'Symbi Reflex' });
  const recoveredHistory = (await versions.status()).commits;
  await restarted.jevExecutor.recover(recorded.artifacts);
  expect((await versions.status()).commits).toEqual(recoveredHistory);
  await restarted.updateBlock(canvasId, block.id, { content: '# A newer manual edit' });
  await expect(restarted.jevExecutor.recover(recorded.artifacts)).rejects.toMatchObject({ status: 503 });
  expect((await restarted.getCanvasBlock(canvasId, block.id)).content).toBe('# A newer manual edit');
  const invalid: JevArtifact[] = [{ ...recorded.artifacts[0], id: '../outside' },
    { ...recorded.artifacts[0], file: '../outside.md' } as JevArtifact];
  for (const artifact of invalid) await expect(restarted.jevExecutor.recover([artifact])).rejects.toMatchObject({ status: 503 });
});

it('recovers missing task files and refuses corrupt or conflicting JSON artifacts before any overwrite', async () => {
  const mutation: JevMutation = { kind: 'task_create', canvasId, task: { title: 'Prepared task', detail: 'Reviewed preparation', blockIds: [block.id] } };
  await expect(execute(mutation, { prepare: async plan => { await persist(plan); throw new Error('Prepared only'); } })).rejects.toThrow('Prepared only');
  const recorded = JSON.parse(await readFile(path.join(root, 'prepared.json'), 'utf8')) as JevCanonicalPreparation;
  await new CanvasStore(root).jevExecutor.recover(recorded.artifacts);
  expect((await store.listTasks(canvasId))[0].title).toBe('Prepared task');
  await store.createTask(canvasId, { title: 'A newer independent task' }, 'user');
  await expect(store.jevExecutor.recover(recorded.artifacts)).rejects.toMatchObject({ status: 503 });
  expect(await store.listTasks(canvasId)).toHaveLength(2);
  await writeFile(files.tasksFile(canvasId), '{broken JSON');
  await expect(store.jevExecutor.recover(recorded.artifacts)).rejects.toBeInstanceOf(SyntaxError);
  expect(await readFile(files.tasksFile(canvasId), 'utf8')).toBe('{broken JSON');
});

it('rebuilds genuinely missing reviewed history and refuses later or unreadable Git source state', async () => {
  const mutation = await readyDraft();
  await expect(execute(mutation, { prepare: async plan => { await persist(plan); throw new Error('Journal persisted before commit'); } }))
    .rejects.toThrow('Journal persisted before commit');
  const recorded = JSON.parse(await readFile(path.join(root, 'prepared.json'), 'utf8')) as JevCanonicalPreparation;
  const historyRoot = path.join(root, '.versions', block.id);
  const versions = new DocumentVersions(historyRoot);
  await versions.commit('# A later independent Git change', 'Independent branch work', 'editor');
  await expect(store.jevExecutor.recover(recorded.artifacts)).rejects.toMatchObject({ status: 503, message: 'Reviewed content history conflicts with a later change' });
  expect(await readFile(files.docFile(block.file), 'utf8')).toBe(block.content);
  expect((await versions.status()).commits[0]).toMatchObject({ message: 'Independent branch work', author: 'editor' });
  await rm(path.join(historyRoot, 'source.md')); await mkdir(path.join(historyRoot, 'source.md'));
  await expect(store.jevExecutor.recover(recorded.artifacts)).rejects.toMatchObject({ code: 'EISDIR' });
  expect(await readFile(files.docFile(block.file), 'utf8')).toBe(block.content);
  await rm(historyRoot, { recursive: true });
  await store.jevExecutor.recover(recorded.artifacts);
  expect(await readFile(files.docFile(block.file), 'utf8')).toBe(mutation.content);
  expect((await versions.status()).commits[0]).toMatchObject({ message: 'Recover reviewed agent draft', author: 'Symbi Reflex' });
  expect((await versions.status()).commits).toHaveLength(2);
});

it('moves documents with native links, tasks and locks, notifies recovered moves, and rejects cross-workspace moves', async () => {
  await store.updateBlock(canvasId, sibling.id, { links: [block.id], linkTypes: { [block.id]: 'related' } });
  await store.createTask(canvasId, { title: 'Attached work', blockIds: [block.id] }, 'user');
  await store.lockBlock(canvasId, block.id, 'reviewer', {});
  const move: JevMutation = { kind: 'move', canvasId, blockId: block.id, targetCanvasId };
  const result = await execute(move);
  expect(result.sourcesAfter[0].canvasId).toBe(targetCanvasId);
  expect((await store.getCanvas(canvasId, true)).blocks.some(item => item.id === block.id)).toBe(false);
  expect((await store.getCanvasBlock(targetCanvasId, block.id)).lock?.owner).toBe('reviewer');
  expect((await store.listTasks(targetCanvasId))[0]).toMatchObject({ title: 'Attached work', blockIds: [block.id] });
  const events: JevStoreEvent[] = []; subscribeJevStore(store, async event => { events.push(event); });
  await store.jevExecutor.recovered(move, 'recovery-worker');
  expect(events).toContainEqual({ workspaceId, canvasId: targetCanvasId, blockIds: [block.id], kind: 'move', actor: 'recovery-worker' });
  await new StorageJevExecutor(context).recovered(move, 'recovery-without-listener');
  await store.jevExecutor.recovered({ kind: 'derived', values: {} }, 'ignored');
  const foreignWorkspace = await store.createWorkspace({ name: 'Another workspace' });
  const foreignCanvas = await store.createCanvas(foreignWorkspace.id, { name: 'Foreign source' });
  await expect(execute({ ...move, canvasId: targetCanvasId, targetCanvasId: foreignCanvas.id })).rejects.toMatchObject({ status: 400 });
  expect((await store.getCanvasBlock(targetCanvasId, block.id)).content).toBe(block.content);
});

it('writes explicit ownership for a native legacy source without revision metadata', async () => {
  const saved = await files.readJson<{ blocks: Array<Record<string, unknown>> }>(files.canvasFile(canvasId));
  const legacy = saved.blocks.find(item => item.id === block.id)!; delete legacy.metadataRevision; delete legacy.jevOwnership;
  await atomicJson(files.canvasFile(canvasId), saved);
  const ownership = { pins: ['group'], managed: [], removedLabels: [], removedLinks: [] };
  expect(await store.jevExecutor.setOwnership(canvasId, block.id, ownership)).toMatchObject({ metadataRevision: 1, jevOwnership: ownership });
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, block.id)).jevOwnership).toEqual(ownership);
});

it('creates, revises, deletes and restores actual task artifacts, including trusted null-field inverses', async () => {
  const created = await execute({ kind: 'task_create', canvasId, task: { id: 'jev-native-work', title: 'Native work', detail: 'Reviewed work', blockIds: [block.id] } });
  expect(created.after).toMatchObject({ task: { id: 'jev-native-work', createdBy: 'reviewer', revision: 1 } });
  const task = (await store.listTasks(canvasId))[0];
  const requirement = await store.createTask(canvasId, { title: 'Prerequisite' }, 'user');
  const findingRef = { id: 'native-finding', title: 'Native evidence', canvasId, blockIds: [block.id], detail: 'A declared delivery requirement.' };
  const updated = await execute({ kind: 'task_update', canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt,
    expectedRevision: task.revision, patch: { dependsOnTaskIds: [requirement.id], findingRef, priority: 'high' } });
  expect(updated.before).toMatchObject({ patch: { dependsOnTaskIds: null, findingRef: null, priority: null } });
  await execute(updated.before, { undo: true });
  const restored = (await store.listTasks(canvasId)).find(item => item.id === task.id)!;
  expect(restored.dependsOnTaskIds).toBeUndefined(); expect(restored.findingRef).toBeUndefined(); expect(restored.priority).toBeUndefined();
  const commented = await store.commentTask(canvasId, task.id, 'A retained review comment', 'user');
  const deleted = await execute({ kind: 'task_delete', canvasId, taskId: task.id, expectedUpdatedAt: commented.updatedAt, expectedRevision: commented.revision });
  expect((await store.listTasks(canvasId)).some(item => item.id === task.id)).toBe(false);
  await execute(deleted.before, { undo: true });
  expect((await new CanvasStore(root).listTasks(canvasId)).find(item => item.id === task.id)).toMatchObject({
    createdAt: task.createdAt, createdBy: task.createdBy, comments: commented.comments, revision: commented.revision! + 1 });
});

it('rejects task identity collisions, absent operations and stale task versions against the actual board', async () => {
  const created = await execute({ kind: 'task_create', canvasId, task: { title: 'Generated native identity', detail: 'Generated identity is valid' } });
  const task = (await store.listTasks(canvasId))[0];
  expect(created.after).toMatchObject({ task: { id: task.id } });
  for (const id of [task.id, 'invalid_task_id']) await expect(execute({ kind: 'task_create', canvasId, task: { id, title: 'Collision', detail: 'Rejected identity' } }))
    .rejects.toMatchObject({ status: 409 });
  const patch: Extract<JevMutation, { kind: 'task_update' }> = { kind: 'task_update', canvasId, taskId: task.id,
    expectedUpdatedAt: task.updatedAt, expectedRevision: task.revision, patch: { detail: 'Reviewed update' } };
  await expect(execute({ ...patch, expectedUpdatedAt: '2000-01-01T00:00:00Z' })).rejects.toMatchObject({ status: 409 });
  await expect(execute({ ...patch, expectedRevision: task.revision! + 1 })).rejects.toMatchObject({ status: 409 });
  await expect(execute({ ...patch, taskId: 'missing-task' })).rejects.toMatchObject({ status: 404 });
  await expect(new StorageJevTasks(context).plan({ kind: 'derived', values: {} }, 'invalid-operation', 'reviewer', false)).rejects.toMatchObject({ status: 400 });
  await execute({ ...patch, expectedRevision: undefined });
  expect((await store.listTasks(canvasId))[0].detail).toBe('Reviewed update');
});

it('rejects dependent deletion, directed task cycles and a 501st task without changing native task files', async () => {
  const prerequisite = await store.createTask(canvasId, { title: 'Prerequisite' }, 'user');
  const dependent = await store.createTask(canvasId, { title: 'Dependent', dependsOnTaskIds: [prerequisite.id] }, 'user');
  await expect(execute({ kind: 'task_delete', canvasId, taskId: prerequisite.id, expectedUpdatedAt: prerequisite.updatedAt, expectedRevision: prerequisite.revision }))
    .rejects.toMatchObject({ status: 409 });
  await expect(execute({ kind: 'task_update', canvasId, taskId: prerequisite.id, expectedUpdatedAt: prerequisite.updatedAt,
    expectedRevision: prerequisite.revision, patch: { dependsOnTaskIds: [dependent.id] } })).rejects.toMatchObject({ status: 400 });
  expect(await store.listTasks(canvasId)).toHaveLength(2);
  const board: CanvasTask[] = Array.from({ length: 500 }, (_, index) => ({ ...prerequisite, id: `existing-${index}` }));
  await atomicJson(files.tasksFile(canvasId), board);
  await expect(execute({ kind: 'task_create', canvasId, task: { title: 'Beyond the board limit', detail: 'A 501st task' } })).rejects.toMatchObject({ status: 400 });
  expect(await store.listTasks(canvasId)).toHaveLength(500);
});

it('checks and restores legacy task revisions without inventing creation provenance', async () => {
  const task = await store.createTask(canvasId, { title: 'Legacy task' }, 'legacy-user');
  const legacy = { ...task }; delete legacy.revision; await atomicJson(files.tasksFile(canvasId), [legacy]);
  await expect(execute({ kind: 'task_update', canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt,
    expectedRevision: 1, patch: { detail: 'Incorrect revision' } })).rejects.toMatchObject({ status: 409 });
  const deleted = await execute({ kind: 'task_delete', canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt, expectedRevision: 0 });
  await execute(deleted.before, { undo: true });
  expect((await store.listTasks(canvasId))[0]).toMatchObject({ createdAt: task.createdAt, createdBy: 'legacy-user', revision: 1, comments: [] });
  const restored = (await store.listTasks(canvasId))[0];
  const changed = await execute({ kind: 'task_update', canvasId, taskId: restored.id, expectedUpdatedAt: restored.updatedAt,
    expectedRevision: restored.revision, patch: { detail: 'A reviewed description' } });
  await execute(changed.before, { undo: true });
  expect((await store.listTasks(canvasId))[0].detail).toBe(task.detail);
});
