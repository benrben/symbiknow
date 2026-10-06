import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevMutation, JevProposal, JevVocabularyTerm, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import type { StoredCanvas } from '../storage-shapes.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';
import type { StoredJevReceipt } from './proposals.js';
import { sourceSnapshot } from './stamps.js';
import { stateMutation } from './proposal-state.js';
import { prepareJevReset, recoverJevResetInside, resetJevWorkspaceInside, withoutJevResetJournal,
  type JevResetJournal, type StoredJevResetWorkspace } from './reset.js';

let root: string; let store: CanvasStore; let files: JevWorkspaceFiles;
let workspaceId: string; let canvasId: string; let secondId: string; let blockId: string; let peerId: string; let remoteId: string;
let state: JevWorkspaceState; let sequence: number;
const canvasFile = (id = canvasId) => path.join(root, 'canvases', `${id}.json`);
const rawCanvas = async (id = canvasId) => JSON.parse(await readFile(canvasFile(id), 'utf8')) as StoredCanvas;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-reset-native-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Reset verification' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Native sources' })).id;
  secondId = (await store.createCanvas(workspaceId, { name: 'Other sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nA real source.', x: 83, y: 92 })).id;
  peerId = (await store.createBlock(canvasId, { title: 'Peer', content: '# Related Atlas source' })).id;
  remoteId = (await store.createBlock(secondId, { title: 'Remote', content: '# Related remote source' })).id;
  files = new JevWorkspaceFiles(root); state = emptyJevWorkspace(); sequence = 0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function proposal(mutation: JevMutation, automatic = true): JevProposal {
  const id = `proposal-${++sequence}`;
  return { id, jobId: automatic ? `native-${id}` : `override:${id}`, action: 'file', title: 'Source-backed native metadata',
    explanation: 'Saved native provenance', evidence: [], sources: [], mutation, state: 'applied', createdAt: '2026-10-04T00:00:00Z' };
}
async function apply(mutation: JevMutation, automatic = true): Promise<StoredJevReceipt> {
  const item = proposal(mutation, automatic);
  const block = await store.getCanvasBlock(canvasId, blockId);
  const source = sourceSnapshot(workspaceId, canvasId, block);
  item.sources = [source]; item.evidence = [{ source, start: 0, end: 7, quote: '# Atlas' }];
  const id = `receipt-${sequence}`;
  const plan = await store.jevExecutor.execute(mutation, [source], id, 'workspace-automation', automatic, async () => undefined);
  const receipt: StoredJevReceipt = { id, proposalId: item.id, action: item.action, createdAt: item.createdAt,
    actor: 'workspace-automation', before: plan.before, after: plan.after, sourcesAfter: plan.sourcesAfter,
    state: 'applied', automatic, preparedArtifacts: plan.artifacts };
  state.proposals.push(item); state.receipts.push(receipt); return receipt;
}
async function document(patch: Extract<JevMutation, { kind: 'document' }>['patch'], automatic = true) {
  return apply({ kind: 'document', canvasId, blockId, patch }, automatic);
}
function term(id: string, groupKey = `custom:${id}`): JevVocabularyTerm {
  return { id, kind: 'group', groupKey, name: id, definition: 'Atlas scope', aliases: [], state: 'active', version: 1,
    members: [{ canvasId, blockId }] };
}
function vocabulary(value: JevVocabularyTerm, operation = 'define', automatic = true): StoredJevReceipt {
  const item = proposal({ kind: 'vocabulary', operation, term: value }, automatic);
  const before = stateMutation(state, item);
  const receipt: StoredJevReceipt = { id: `receipt-${sequence}`, proposalId: item.id, action: 'file', createdAt: item.createdAt,
    actor: 'workspace-automation', before, after: item.mutation, sourcesAfter: [], state: 'applied', automatic };
  state.proposals.push(item); state.receipts.push(receipt); return receipt;
}
async function reset() {
  await files.write(workspaceId, state);
  return files.serial(workspaceId, () => resetJevWorkspaceInside(store, files, workspaceId));
}
function signed(journal: JevResetJournal): JevResetJournal {
  const payload = Object.fromEntries(Object.entries(journal).filter(([field]) => field !== 'checksum')) as Omit<JevResetJournal, 'checksum'>;
  return { ...payload, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
async function journalState(journal: JevResetJournal) {
  await files.write(workspaceId, { ...state, resetJournal: journal } as StoredJevResetWorkspace);
}

it('clears native Jev organization and indexes across all canvases while preserving content, layout, configuration and correction memory', async () => {
  const generatedPeer = (await store.createBlock(canvasId, { title: 'Generated connection', content: '# Atlas connection' })).id;
  await store.updateBlock(canvasId, blockId, { links: [peerId], purpose: 'Manual purpose', workArea: 'Manual area' });
  const ownership = (await store.getCanvasBlock(canvasId, blockId)).jevOwnership!;
  await store.jevExecutor.setOwnership(canvasId, blockId, { pins: ['purpose', 'workArea'], managed: [...ownership.managed, 'links'],
    removedLabels: ['Rejected'], removedLinks: ['removed-edge'] });
  const before = await rawCanvas(); const sourceBytes = await readFile(path.join(root, `docs/${blockId}.md`));
  await document({ group: 'custom:atlas', tags: ['Atlas'], headline: 'Automatic overview', freshness: { reviewAt: '2026-10-05' },
    links: [peerId, generatedPeer], linkTypes: { [peerId]: 'related', [generatedPeer]: 'same_topic' },
    crossLinks: [{ canvasId: secondId, blockId: remoteId, relation: 'same_topic', confidence: 0.95 }] });
  await document({ group: 'custom:platform' });
  vocabulary(term('atlas')); vocabulary(term('platform'));
  state.profiles = { [`${canvasId}:${blockId}`]: { role: 'specification', automaticOrganization: 'checkpoint' }, 'workspace:recall': { stale: true } };
  state.jobs = [{ id: 'old-index', request: { action: 'profile', canvasId, idempotencyKey: 'old-index' }, state: 'completed',
    createdAt: '2026-10-04', updatedAt: '2026-10-04', sources: [], result: { role: 'old' }, proposalIds: [] }];
  state.proposals.push(proposal({ kind: 'derived', values: { held: true } }));
  state.suppressions = ['manual-rejection']; state.settings.confidenceThresholds = { ...state.settings.confidenceThresholds, file: 0.83 };
  state.settings.paused = true; state.commandPlans = [];
  await atomicJson(path.join(root, 'jev-cache', `${canvasId}.json`), { oldGeneratedIndex: true });
  await atomicJson(path.join(root, 'jev-cache', `${secondId}.json`), { oldGeneratedIndex: true });
  await store.getCanvas(canvasId); await store.getCanvas(secondId);
  expect(store.similarityIndex(workspaceId).neighbors(blockId, 5).length).toBeGreaterThan(0);
  const plan = await reset();
  expect(plan.canvasIds).toEqual([canvasId, secondId]); expect(plan.documentCount).toBe(4);
  const after = await rawCanvas(); const cleared = after.blocks.find(block => block.id === blockId)!;
  const original = before.blocks.find(block => block.id === blockId)!;
  expect(cleared).toMatchObject({ ...original, metadataRevision: expect.any(Number) });
  expect(cleared.group).toBeUndefined(); expect(cleared.tags).toBeUndefined(); expect(cleared.headline).toBeUndefined();
  expect(cleared.freshness).toBeUndefined(); expect(cleared.crossLinks).toBeUndefined(); expect(cleared.linkTypes).toBeUndefined();
  expect(cleared.links).toEqual([peerId]); expect(cleared.jevMutationId).toBeUndefined();
  expect(cleared.jevOwnership).toEqual(original.jevOwnership);
  expect(await readFile(path.join(root, `docs/${blockId}.md`))).toEqual(sourceBytes);
  expect(store.similarityIndex(workspaceId).neighbors(blockId, 5)).toEqual([]);
  const saved = await files.read(workspaceId) as StoredJevResetWorkspace;
  expect(saved.profiles).toEqual({}); expect(saved.jobs).toEqual([]); expect(saved.vocabulary).toEqual([]);
  expect(saved.receipts).toEqual(state.receipts); expect(saved.proposals).toHaveLength(state.receipts.length);
  expect(saved.settings).toEqual({ ...state.settings, paused: false }); expect(saved.suppressions).toEqual(state.suppressions);
  expect(saved.resetJournal).toBeUndefined(); expect(saved.commandPlans).toBeUndefined();
  for (const id of [canvasId, secondId]) await expect(readFile(path.join(root, 'jev-cache', `${id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await recoverJevResetInside(store, files, workspaceId)).toBe(false);
});

it('keeps pinned mixed labels and edges, manual vocabulary and group definitions needed by preserved manual descendants', async () => {
  const manualPeer = (await store.createBlock(canvasId, { title: 'Manual connection', content: '# Manual connection' })).id;
  await document({ group: 'custom:parent/child', tags: ['Automatic'], links: [peerId], linkTypes: { [peerId]: 'related' } });
  vocabulary(term('parent', 'custom:parent'));
  const child = { ...term('child', 'custom:parent/child'), parentId: 'parent' }; vocabulary(child);
  const label = { ...term('automatic'), kind: 'label' as const, name: 'Automatic' }; delete label.groupKey; vocabulary(label);
  const free = term('free'); vocabulary(free);
  vocabulary({ ...free, version: 2, name: 'Renamed manually' }, 'rename', false);
  await store.updateBlock(canvasId, blockId, { group: 'custom:parent/child', tags: ['Automatic', 'Manual'], links: [peerId, manualPeer] });
  await store.jevExecutor.setOwnership(canvasId, blockId, { pins: ['group', 'tags', 'links'] });
  await reset();
  const saved = await files.read(workspaceId); const block = (await rawCanvas()).blocks.find(item => item.id === blockId)!;
  expect(block.group).toBe('custom:parent/child'); expect(block.tags).toEqual(['Automatic', 'Manual']);
  expect(block.links).toEqual([peerId, manualPeer]); expect(block.linkTypes).toEqual({ [peerId]: 'related' });
  expect(saved.vocabulary.map(item => item.id).sort()).toEqual(['automatic', 'child', 'free', 'parent']);
  expect(saved.vocabulary.find(item => item.id === 'free')?.name).toBe('Renamed manually');
});

it('restores the manual vocabulary baseline and keeps later edited terms or untracked document metadata', async () => {
  state.vocabulary = [term('manual')];
  vocabulary({ ...term('manual'), name: 'Automatic rename', version: 2 }, 'rename');
  vocabulary(term('edited'));
  state.vocabulary = state.vocabulary.map(value => value.id === 'edited' ? { ...value, definition: 'Changed manually', version: 2 } : value);
  await document({ group: 'custom:generated' });
  const native = await rawCanvas(); native.blocks.find(item => item.id === blockId)!.group = 'custom:untracked';
  delete native.blocks.find(item => item.id === peerId)!.jevOwnership;
  native.blocks.find(item => item.id === peerId)!.group = 'custom:legacy-manual'; await atomicJson(canvasFile(), native);
  await reset();
  expect((await files.read(workspaceId)).vocabulary).toEqual([term('manual'), expect.objectContaining({ id: 'edited', definition: 'Changed manually' })]);
  expect((await rawCanvas()).blocks.map(item => item.group)).toEqual(['custom:untracked', 'custom:legacy-manual']);
});

it('removes only trusted task attachments and responsibility, preserving task content and later manual updates', async () => {
  let task = await store.createTask(canvasId, { title: 'Ship Atlas', detail: 'Manual work', blockIds: [peerId], reviewer: 'manual-reviewer' }, 'Owner');
  const original = task;
  await apply({ kind: 'task_update', canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt, expectedRevision: task.revision,
    patch: { blockIds: [peerId, blockId] } });
  task = (await store.listTasks(canvasId))[0];
  await apply({ kind: 'task_update', canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt, expectedRevision: task.revision,
    patch: { assignee: 'automatic-owner', reviewer: 'automatic-reviewer' } });
  await apply({ kind: 'task_create', canvasId, task: { id: 'legacy-created', title: 'Keep this work', detail: 'Generated task content stays',
    assignee: 'automatic-owner', blockIds: [blockId] } });
  const manual = await store.createTask(canvasId, { title: 'Manual correction' }, 'Owner');
  await apply({ kind: 'task_update', canvasId, taskId: manual.id, expectedUpdatedAt: manual.updatedAt, expectedRevision: manual.revision,
    patch: { assignee: 'generated-owner', blockIds: [blockId] } });
  const corrected = await store.updateTask(canvasId, manual.id, { assignee: 'manual-owner', title: 'Corrected manually' }, 'Owner');
  await reset();
  const saved = await new CanvasStore(root).listTasks(canvasId);
  expect(saved.find(item => item.id === original.id)).toMatchObject({ ...original, revision: expect.any(Number), updatedAt: expect.any(String), updatedBy: 'workspace-automation' });
  expect(saved.find(item => item.id === original.id)?.jevMutationId).toBeUndefined();
  expect(saved.find(item => item.id === 'legacy-created')).toMatchObject({ title: 'Keep this work', detail: 'Generated task content stays', blockIds: [] });
  expect(saved.find(item => item.id === 'legacy-created')?.assignee).toBeUndefined();
  expect(saved.find(item => item.id === manual.id)).toEqual(corrected);
});

it('preserves saved stale references instead of writing the filtered canvas projection', async () => {
  const native = await rawCanvas(); const block = native.blocks.find(item => item.id === blockId)!;
  block.crossLinks = [{ canvasId: 'missing-canvas', blockId: 'missing-source', relation: 'related' }];
  await atomicJson(canvasFile(), native);
  await document({ group: 'custom:auto' });
  expect((await store.getCanvasBlock(canvasId, blockId)).crossLinks).toBeUndefined();
  await reset();
  expect((await rawCanvas()).blocks.find(item => item.id === blockId)?.crossLinks).toEqual(block.crossLinks);
});

it('recovers an interrupted multi-artifact reset on restart and keeps the partial workspace paused', async () => {
  await document({ group: 'custom:auto', tags: ['Auto'] });
  const task = await store.createTask(canvasId, { title: 'Source work' }, 'Owner');
  await apply({ kind: 'task_update', canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt, expectedRevision: task.revision, patch: { blockIds: [blockId] } });
  await files.write(workspaceId, state);
  const recover = store.jevExecutor.recover.bind(store.jevExecutor);
  store.jevExecutor.recover = async artifacts => { await recover(artifacts.slice(0, 1)); throw new Error('Process interrupted after native artifact write'); };
  await expect(files.serial(workspaceId, () => resetJevWorkspaceInside(store, files, workspaceId))).rejects.toThrow('Process interrupted');
  const interrupted = await files.read(workspaceId) as StoredJevResetWorkspace;
  expect(interrupted.resetJournal?.artifacts).toHaveLength(2); expect(interrupted.settings.paused).toBe(true);
  expect((await rawCanvas()).blocks.find(item => item.id === blockId)?.group).toBeUndefined();
  expect((await store.listTasks(canvasId))[0].blockIds).toEqual([blockId]);
  expect(withoutJevResetJournal(interrupted)).not.toHaveProperty('resetJournal'); expect(interrupted).toHaveProperty('resetJournal');
  const restarted = new CanvasStore(root); const restartedFiles = new JevWorkspaceFiles(root);
  await restartedFiles.serial(workspaceId, () => resetJevWorkspaceInside(restarted, restartedFiles, workspaceId));
  expect((await restarted.listTasks(canvasId))[0].blockIds).toEqual([]);
  expect((await restartedFiles.read(workspaceId)).settings.paused).toBe(false);
});

it('detects a later native correction before recovery writes and preserves the durable reset journal', async () => {
  await document({ group: 'custom:auto' }); await files.write(workspaceId, state);
  const journal = await prepareJevReset(store, workspaceId, state); await journalState(journal);
  await store.updateBlock(canvasId, blockId, { tags: ['Later manual correction'] });
  const before = await rawCanvas();
  await expect(recoverJevResetInside(new CanvasStore(root), files, workspaceId)).rejects.toMatchObject({ status: 503 });
  expect(await rawCanvas()).toEqual(before); expect((await files.read(workspaceId) as StoredJevResetWorkspace).resetJournal).toEqual(journal);
});

it('retains the durable plan when the final workspace commit fails and completes it after restart', async () => {
  await document({ group: 'custom:auto' }); await files.write(workspaceId, state);
  const write = files.write.bind(files); let writes = 0;
  files.write = async (...args) => { if (++writes === 2) throw new Error('Workspace commit interrupted'); await write(...args); };
  await expect(resetJevWorkspaceInside(store, files, workspaceId)).rejects.toThrow('Workspace commit interrupted');
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).settings.paused).toBe(true);
  expect(await recoverJevResetInside(new CanvasStore(root), new JevWorkspaceFiles(root), workspaceId)).toBe(true);
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).settings.paused).toBe(false);
});

it('refuses unfinished canonical writes and unavailable workspace scopes before preparing a reset', async () => {
  state.prepared = [{ id: 'unfinished', proposal: proposal({ kind: 'derived', values: {} }), before: { kind: 'derived', values: {} }, after: { kind: 'derived', values: {} } }];
  await files.write(workspaceId, state);
  await expect(resetJevWorkspaceInside(store, files, workspaceId)).rejects.toMatchObject({ status: 409 });
  await expect(prepareJevReset(store, 'missing-workspace', state)).rejects.toMatchObject({ status: 404 });
  const native = await rawCanvas(); native.workspaceId = 'other-workspace'; await atomicJson(canvasFile(), native);
  await expect(prepareJevReset(store, workspaceId, emptyJevWorkspace())).rejects.toMatchObject({ status: 503 });
});

it('rejects malformed, corrupt or cross-scope recovery journals without changing native artifacts', async () => {
  await document({ group: 'custom:auto' }); const journal = await prepareJevReset(store, workspaceId, state); const native = await rawCanvas();
  const artifact = journal.artifacts[0]; expect(artifact.kind).toBe('canvas');
  const bad = [null, { ...journal, checksum: 'x'.repeat(64) }, signed({ ...journal, canvasIds: [] }),
    signed({ ...journal, artifacts: [{ ...artifact, before: { ...artifact.before, id: 'wrong-canvas' } } as typeof artifact] }),
    signed({ ...journal, artifacts: [{ ...artifact, after: { ...artifact.after, id: 'wrong-canvas' } } as typeof artifact] }),
    signed({ ...journal, artifacts: [{ ...artifact, before: { ...artifact.before, workspaceId: 'wrong-workspace' } } as typeof artifact] }),
    signed({ ...journal, artifacts: [{ ...artifact, after: { ...artifact.after, workspaceId: 'wrong-workspace' } } as typeof artifact] }),
    signed({ ...journal, vocabularyAfter: [{ id: 'malformed' } as JevVocabularyTerm] })];
  for (const value of bad) {
    await journalState(value as JevResetJournal);
    await expect(recoverJevResetInside(store, files, workspaceId)).rejects.toMatchObject({ status: 503 });
    expect(await rawCanvas()).toEqual(native);
  }
});

it('preserves rejected, edited, legacy and unproven metadata even when managed permissions are present', async () => {
  const reviewed = await document({ group: 'custom:reviewer-edited' });
  state.proposals.find(item => item.id === reviewed.proposalId)!.reviewerEdited = true;
  const noArtifact = await apply({ kind: 'document', canvasId, blockId: peerId, patch: { group: 'custom:legacy' } });
  delete noArtifact.preparedArtifacts;
  const manual = await apply({ kind: 'document', canvasId: secondId, blockId: remoteId, patch: { headline: 'Explicit override' } }, false);
  await store.jevExecutor.setOwnership(secondId, remoteId, { pins: [] });
  expect(manual.automatic).toBe(false);
  await reset();
  expect((await rawCanvas()).blocks.map(item => item.group)).toEqual(['custom:reviewer-edited', 'custom:legacy']);
  expect((await rawCanvas(secondId)).blocks[0].headline).toBe('Explicit override');
});

it('preserves fields explicitly removed from managed ownership even without a pin', async () => {
  await document({ group: 'custom:manual-control', tags: ['Generated'] });
  const ownership = (await store.getCanvasBlock(canvasId, blockId)).jevOwnership!;
  await store.jevExecutor.setOwnership(canvasId, blockId, { managed: ownership.managed.filter(field => field !== 'group') });
  await reset();
  const block = (await rawCanvas()).blocks[0];
  expect(block.group).toBe('custom:manual-control'); expect(block.tags).toBeUndefined();
  expect(block.jevOwnership?.pins).not.toContain('group'); expect(block.jevOwnership?.managed).not.toContain('group');
});

it('restores exact mixed manual baselines and retains their local and cross-canvas ownership markers', async () => {
  await store.updateBlock(canvasId, blockId, { tags: ['Manual baseline'], links: [peerId], linkTypes: { [peerId]: 'related' },
    crossLinks: [{ canvasId: secondId, blockId: remoteId, relation: 'related' }] });
  const native = await rawCanvas(); native.blocks[0].crossLinks!.push({ canvasId: 'missing-canvas', blockId: 'missing-source' });
  await atomicJson(canvasFile(), native);
  await store.jevExecutor.setOwnership(canvasId, blockId, { pins: [], managed: ['group', 'tags', 'links', 'crossLinks',
    `link:${canvasId}:${peerId}`, `link:${secondId}:${remoteId}`, 'link:missing-canvas:missing-source'] });
  const baseline = (await rawCanvas()).blocks.find(item => item.id === blockId)!;
  await document({ group: 'custom:auto', tags: ['Manual baseline', 'Generated label'], linkTypes: { [peerId]: 'same_topic' } });
  await reset();
  const after = (await rawCanvas()).blocks.find(item => item.id === blockId)!;
  expect(after.tags).toEqual(baseline.tags); expect(after.linkTypes).toEqual(baseline.linkTypes);
  expect(after.crossLinks).toEqual(baseline.crossLinks); expect(after.jevOwnership).toEqual(baseline.jevOwnership);
});

it('protects link-type pins and rebuilds the revision of legacy generated metadata without changing source identity', async () => {
  await document({ group: 'custom:auto', links: [peerId], linkTypes: { [peerId]: 'related' } });
  await store.jevExecutor.setOwnership(canvasId, blockId, { pins: ['linkTypes'] });
  const native = await rawCanvas(); delete native.blocks[0].metadataRevision; await atomicJson(canvasFile(), native);
  await reset();
  const block = (await rawCanvas()).blocks[0];
  expect(block.group).toBeUndefined(); expect(block.links).toEqual([peerId]); expect(block.linkTypes).toEqual({ [peerId]: 'related' });
  expect(block.metadataRevision).toBe(1); expect(block.incarnation).toBe(native.blocks[0].incarnation);
});

it('preserves tasks when their receipt kind, scope, snapshot or reviewer provenance does not establish ownership', async () => {
  const receipts: StoredJevReceipt[] = [];
  for (const title of ['kind', 'scope', 'snapshot', 'reviewer', 'missing-artifact']) {
    const task = await store.createTask(canvasId, { title }, 'Owner');
    receipts.push(await apply({ kind: 'task_update', canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt,
      expectedRevision: task.revision, patch: { assignee: 'automatic-owner' } }));
  }
  receipts[0].after = { kind: 'derived', values: {} };
  (receipts[1].after as Extract<JevMutation, { kind: 'task_update' }>).canvasId = secondId;
  const artifact = receipts[2].preparedArtifacts![0]; if (artifact.kind === 'tasks') artifact.after.find(task => task.title === 'snapshot')!.detail = 'Different snapshot';
  state.proposals.find(item => item.id === receipts[3].proposalId)!.reviewerEdited = true;
  delete receipts[4].preparedArtifacts;
  const before = await store.listTasks(canvasId); await reset();
  expect(await store.listTasks(canvasId)).toEqual(before);
});

it('handles legacy task revisions and removed vocabulary, retaining required ancestors and unrelated entities', async () => {
  const created = await apply({ kind: 'task_create', canvasId, task: { id: 'legacy-revision', title: 'Legacy work', detail: 'Keep the content', assignee: 'generated' } });
  const taskFile = path.join(root, 'tasks', `${canvasId}.json`);
  const tasks = JSON.parse(await readFile(taskFile, 'utf8')); delete tasks[0].revision; await atomicJson(taskFile, tasks);
  const artifact = created.preparedArtifacts![0]; if (artifact.kind === 'tasks') delete artifact.after[0].revision;
  state.vocabulary = [term('restored')]; vocabulary(term('restored'), 'remove');
  vocabulary(term('parent'));
  vocabulary({ ...term('child', 'custom:parent/child'), parentId: 'parent' }, 'define', false);
  const entity = { ...term('entity'), kind: 'entity' as const }; delete entity.groupKey; vocabulary(entity, 'define', false);
  const missingParent = { ...term('orphan'), parentId: 'missing-parent' }; state.vocabulary.push(missingParent);
  const legacyGroup = term('legacy-without-path'); delete legacyGroup.groupKey; state.vocabulary.push(legacyGroup);
  await store.updateBlock(canvasId, peerId, { group: 'custom:manual' });
  await reset();
  expect((await store.listTasks(canvasId))[0]).toMatchObject({ revision: 1, title: 'Legacy work', detail: 'Keep the content' });
  expect((await files.read(workspaceId)).vocabulary.map(value => value.id).sort()).toEqual(['child', 'entity', 'legacy-without-path', 'orphan', 'parent', 'restored']);
});

it('keeps failed legacy-cache cleanup recoverable and refuses unreadable or invalid native targets', async () => {
  await document({ group: 'custom:auto' }); await files.write(workspaceId, state);
  const cache = path.join(root, 'jev-cache', `${canvasId}.json`); await mkdir(cache, { recursive: true });
  await expect(resetJevWorkspaceInside(store, files, workspaceId)).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' });
  expect((await files.read(workspaceId) as StoredJevResetWorkspace).resetJournal).toBeDefined();
  await rm(cache, { recursive: true }); expect(await recoverJevResetInside(store, files, workspaceId)).toBe(true);
  await mkdir(path.join(root, 'tasks', `${secondId}.json`), { recursive: true });
  await expect(prepareJevReset(store, workspaceId, state)).rejects.toMatchObject({ code: 'EISDIR' });
  const workspaces = await store.listWorkspaces(); workspaces.find(item => item.id === workspaceId)!.canvases[0].id = '../outside';
  await atomicJson(path.join(root, 'workspaces.json'), workspaces);
  await expect(prepareJevReset(store, workspaceId, state)).rejects.toMatchObject({ status: 503 });
});
