import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { JevJob, JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import { storedBlock, type StoredCanvas } from '../storage-shapes.js';
import type { JevArtifact } from '../storage-jev-executor.js';
import { automationPrincipal } from './authorization.js';
import { pruneJevWorkspace, purgeJevOrphans } from './lifecycle.js';
import type { PreparedJevMutation, StoredJevReceipt } from './proposals.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

let history: QueueBoundaryFixture; let native: QueueBoundaryFixture;
async function checkedMetadata(fixture: QueueBoundaryFixture, index: number): Promise<StoredJevReceipt> {
  const document = await fixture.store.getCanvasBlock(fixture.canvasId, fixture.primary.id);
  const source = sourceSnapshot(fixture.workspaceId, fixture.canvasId, document);
  const proposal: JevProposal = { id: randomUUID(), jobId: `native-history-${index}`, action: 'label', title: 'Retain exact rollout evidence',
    explanation: 'The source explicitly describes delivery.', state: 'pending', confidence: .99, createdAt: new Date().toISOString(),
    sources: [source], evidence: [{ source, start: 0, end: 7, quote: '# Atlas' }],
    mutation: { kind: 'document', canvasId: fixture.canvasId, blockId: document.id, patch: { tags: [`Atlas ${index}`] } } };
  const state = await fixture.files.read(fixture.workspaceId); state.proposals.push(proposal); await fixture.files.write(fixture.workspaceId, state);
  return fixture.files.serial(fixture.workspaceId, () => fixture.executor.applyInside(fixture.workspaceId, proposal.id, automationPrincipal, true));
}
function proofCanvases(receipts: StoredJevReceipt[]): Array<{ blocks: unknown[] }> {
  return receipts.flatMap(receipt => (receipt.preparedArtifacts ?? []).flatMap((artifact: JevArtifact) =>
    artifact.kind === 'canvas' ? [artifact.before, artifact.after] : []));
}
function unreadProofs(receipts: StoredJevReceipt[]): number {
  return proofCanvases(receipts).filter(canvas => typeof Object.getOwnPropertyDescriptor(canvas, 'blocks')?.get === 'function').length;
}
beforeAll(async () => { history = await queueBoundaryFixture(); });
beforeAll(async () => {
  // This test measures lazy history proof reads, not the createBlock API. Seed
  // ordinary Markdown files and one canonical canvas snapshot in bulk so the
  // fixture does not pay 157 unrelated version-journal fsyncs under coverage.
  const canvasFile = path.join(history.root, 'canvases', `${history.canvasId}.json`);
  const canvas = JSON.parse(await readFile(canvasFile, 'utf8')) as StoredCanvas;
  const added = await Promise.all(Array.from({ length: 157 }, async (_, offset) => {
    const index = offset + 1;
    const id = randomUUID();
    const content = `# Delivery source ${index}\nKeep exact independent source ${index}.`;
    const file = `docs/${id}.md`;
    await writeFile(path.join(history.root, file), content);
    return storedBlock({ ...history.primary, id, file, title: `Delivery source ${index}`, content,
      incarnation: randomUUID(), sourceGeneration: 1, metadataRevision: 1, links: [],
      x: (index % 16) * 450, y: Math.floor(index / 16) * 370 });
  }));
  await atomicJson(canvasFile, { ...canvas, blocks: [...canvas.blocks, ...added] });
});
for (const [first, last] of [[0, 6], [6, 12]]) {
  beforeAll(async () => { for (let index = first; index < last; index++) await checkedMetadata(history, index); });
}
afterAll(async () => { await history.close(); });
beforeEach(async () => { native = await queueBoundaryFixture(); });
afterEach(async () => { await native.close(); });

it('keeps every pooled historical proof unread across unchanged pruning of 158 real native documents', async () => {
  const files = new JevWorkspaceFiles(history.root); const store = new CanvasStore(history.root);
  const disk = await readFile(files.file(history.workspaceId));
  const encoded = JSON.parse(disk.toString('utf8'));
  expect(encoded).toMatchObject({ codec: 'jev-source-vectors', version: 2 });
  expect(encoded.blockReferences).toHaveLength(24);
  const documents = (await store.getCanvas(history.canvasId, true)).blocks;
  expect(documents).toHaveLength(158);
  expect(documents.at(-1)).toMatchObject({ title: 'Delivery source 157',
    content: '# Delivery source 157\nKeep exact independent source 157.', sourceGeneration: 1 });
  const state = await files.read(history.workspaceId); const receipts = state.receipts as StoredJevReceipt[];
  expect(unreadProofs(receipts)).toBe(24);
  const sourceBytes = await readFile(path.join(history.root, history.primary.file));
  for (let cycle = 0; cycle < 3; cycle++) expect(await pruneJevWorkspace(store, history.workspaceId, state)).toBe(false);
  expect(unreadProofs(state.receipts as StoredJevReceipt[])).toBe(24);
  expect(await readFile(files.file(history.workspaceId))).toEqual(disk);
  expect(await readFile(path.join(history.root, history.primary.file))).toEqual(sourceBytes);
});

it('retains source-edit history and manual correction memory without reading checked native proof vectors', async () => {
  await checkedMetadata(native, 0);
  const before = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const saved = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  saved.commandPlans = [{ id: 'retained-command', workspaceId: native.workspaceId, state: 'completed', steps: [],
    createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' }];
  saved.suppressions = ['retained-correction'];
  (saved as JevWorkspaceState & { correctionMemory: unknown }).correctionMemory = {
    sourceRemovedLabel: 'manual reference', provenance: ['literal correction'],
  };
  await native.files.write(native.workspaceId, saved);
  const state = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const memory = (state as JevWorkspaceState & { correctionMemory: unknown }).correctionMemory;
  const commands = state.commandPlans; const settings = state.settings;
  const edited = await native.store.updateBlock(native.canvasId, native.primary.id,
    { content: '# Atlas\nA manual source correction.', tags: ['manual reference'] }, 'Browser');
  const canonical = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  expect(edited).toMatchObject({ incarnation: before.incarnation, sourceGeneration: before.sourceGeneration! + 1 });
  await expect(native.store.jevExecutor.checkSources(state.receipts[0].sourcesAfter)).rejects.toMatchObject({ status: 409 });
  expect(unreadProofs(state.receipts as StoredJevReceipt[])).toBe(2);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(false);
  expect(state.receipts).toHaveLength(1); expect(state.proposals).toHaveLength(1);
  expect(unreadProofs(state.receipts as StoredJevReceipt[])).toBe(2);
  expect(state.commandPlans).toBe(commands); expect(state.settings).toBe(settings);
  expect(state.suppressions).toEqual(['retained-correction']);
  expect((state as JevWorkspaceState & { correctionMemory: unknown }).correctionMemory).toBe(memory);
  expect(await native.store.getCanvasBlock(native.canvasId, native.primary.id)).toEqual(canonical);
  expect(edited.jevOwnership?.pins).toContain('tags');
});

async function selectedJob(): Promise<JevJob> {
  return native.admit({ action: 'profile', canvasId: native.canvasId, blockIds: [native.primary.id] }, automationPrincipal);
}

it('reports a jobs-only prune for a disappeared context source while preserving the live selected document', async () => {
  const job = await selectedJob(); const state = await native.files.read(native.workspaceId);
  (state.jobs[0] as JevJob & { contextSources: JevSourceSnapshot[] }).contextSources = [
    sourceSnapshot(native.workspaceId, native.otherCanvasId, await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id)),
  ];
  await native.store.deleteBlock(native.otherCanvasId, native.secondary.id);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(true);
  expect(state.jobs.some(item => item.id === job.id)).toBe(false);
  expect(state.proposals).toEqual([]); expect(state.receipts).toEqual([]);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(false);
});

it('reports a proposal-only prune when its job is absent and its selected source disappeared', async () => {
  await checkedMetadata(native, 0); const state = await native.files.read(native.workspaceId);
  const proposal = structuredClone(state.proposals[0]); proposal.id = 'detached-proposal'; proposal.jobId = 'absent-job';
  proposal.sources = [sourceSnapshot(native.workspaceId, native.otherCanvasId, native.secondary)];
  state.proposals = [proposal]; state.receipts = [];
  await native.store.deleteBlock(native.otherCanvasId, native.secondary.id);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(true);
  expect(state.proposals).toEqual([]); expect(state.jobs).toEqual([]);
});

it('reports a receipt-only prune while keeping its live proposal and unrelated history unread', async () => {
  await checkedMetadata(native, 0); await checkedMetadata(native, 1);
  const state = await native.files.read(native.workspaceId); const retained = state.receipts[1];
  state.receipts[0].sourcesAfter = [sourceSnapshot(native.workspaceId, native.otherCanvasId, native.secondary)];
  await native.store.deleteBlock(native.otherCanvasId, native.secondary.id);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(true);
  expect(state.receipts).toEqual([retained]); expect(state.proposals).toHaveLength(2);
  expect(unreadProofs(state.receipts as StoredJevReceipt[])).toBe(2);
});

it('reports an orphan prepared-proof prune and keeps a preparation with its retained proposal', async () => {
  await checkedMetadata(native, 0); const state = await native.files.read(native.workspaceId);
  const receipt = state.receipts[0] as StoredJevReceipt; const proposal = state.proposals[0];
  const retained: PreparedJevMutation = { id: 'retained-preparation', proposal, before: receipt.before, after: receipt.after,
    artifacts: receipt.preparedArtifacts };
  const orphan = { ...retained, id: 'orphan-preparation', proposal: { ...proposal, id: 'missing-proposal' } };
  state.prepared = [retained, orphan]; await native.files.write(native.workspaceId, state);
  const reloaded = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, reloaded)).toBe(true);
  expect(reloaded.prepared.map(record => record.id)).toEqual(['retained-preparation']);
  const artifact = (reloaded.prepared[0] as PreparedJevMutation).artifacts!.find(item => item.kind === 'canvas')!;
  expect(Object.getOwnPropertyDescriptor(artifact.before, 'blocks')).toMatchObject({ get: expect.any(Function) });
  expect(Object.getOwnPropertyDescriptor(artifact.after, 'blocks')).toMatchObject({ get: expect.any(Function) });
  expect(unreadProofs(reloaded.receipts as StoredJevReceipt[])).toBe(2);
});

it('reports only vocabulary deletion for a missing member and keeps empty and live memberships', async () => {
  const state = await native.files.read(native.workspaceId);
  const term = { id: 'live', kind: 'label' as const, name: 'Atlas', definition: 'Atlas delivery', aliases: [], state: 'active' as const,
    version: 1, members: [{ canvasId: native.canvasId, blockId: native.primary.id }] };
  state.vocabulary = [term, { ...term, id: 'empty', members: [] },
    { ...term, id: 'missing', members: [{ canvasId: native.otherCanvasId, blockId: native.secondary.id }] }];
  await native.store.deleteBlock(native.otherCanvasId, native.secondary.id);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(true);
  expect(state.vocabulary.map(item => item.id)).toEqual(['live', 'empty']);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(false);
});

it('prunes every dependent artifact after native source deletion without changing command or correction history', async () => {
  const job = await selectedJob(); await checkedMetadata(native, 0); const state = await native.files.read(native.workspaceId);
  state.proposals[0].jobId = job.id;
  const receipt = state.receipts[0] as StoredJevReceipt;
  state.prepared = [{ id: 'dependent-preparation', proposal: state.proposals[0], before: receipt.before, after: receipt.after,
    artifacts: receipt.preparedArtifacts } as PreparedJevMutation];
  state.profiles = { [`${native.canvasId}:${native.primary.id}`]: { source: { ...job.sources[0] } },
    'workspace:source': { source: { ...job.sources[0] } }, 'workspace:summary': { status: 'retained' } };
  state.suppressions = ['keep-correction-memory'];
  await native.store.deleteBlock(native.canvasId, native.primary.id);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(true);
  expect(state.jobs).toEqual([]); expect(state.proposals).toEqual([]); expect(state.receipts).toEqual([]); expect(state.prepared).toEqual([]);
  expect(state.profiles).toEqual({ 'workspace:summary': { status: 'retained' } });
  expect(state.suppressions).toEqual(['keep-correction-memory']);
  await native.files.write(native.workspaceId, state);
  expect((await new JevWorkspaceFiles(native.root).read(native.workspaceId)).receipts).toEqual([]);
  expect((await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id)).content).toBe(native.secondary.content);
});

async function checkedMove(): Promise<StoredJevReceipt> {
  const job = await selectedJob(); const source = job.sources[0];
  const proposal: JevProposal = { id: randomUUID(), jobId: job.id, action: 'suggest_home_canvas', title: 'Use the checked rollback home',
    explanation: 'Preserve the source and its exact evidence.', state: 'pending', createdAt: new Date().toISOString(), confidence: .99,
    sources: [source], evidence: [{ source, start: 0, end: 7, quote: '# Atlas' }],
    mutation: { kind: 'move', canvasId: native.canvasId, blockId: native.primary.id, targetCanvasId: native.otherCanvasId } };
  const state = await native.files.read(native.workspaceId); state.proposals.push(proposal); await native.files.write(native.workspaceId, state);
  return native.files.serial(native.workspaceId, () => native.executor.applyInside(native.workspaceId, proposal.id, automationPrincipal, true));
}

it('keeps live moved-source jobs, receipts and workspace evidence using the actual checked move lineage', async () => {
  const receipt = await checkedMove(); const state = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  const oldSource = state.jobs[0].sources[0];
  state.profiles = { 'workspace:moved-evidence': { scopedSources: [{ ...oldSource }] } };
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(false);
  expect(state.jobs).toHaveLength(1); expect(state.proposals).toHaveLength(1); expect(state.receipts[0].id).toBe(receipt.id);
  expect(state.profiles['workspace:moved-evidence']).toEqual({ scopedSources: [oldSource] });
  // The emptied source-canvas after proof stays a literal empty array; three nonempty vectors remain lazy.
  expect(unreadProofs(state.receipts as StoredJevReceipt[])).toBe(3);
  expect((await native.store.getCanvasBlock(native.otherCanvasId, native.primary.id)).content).toBe(native.primary.content);
  await native.store.deleteBlock(native.otherCanvasId, native.primary.id);
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(true);
  expect(state.jobs).toEqual([]); expect(state.proposals).toEqual([]); expect(state.receipts).toEqual([]); expect(state.profiles).toEqual({});
});

it('does not treat undone or unrelated move receipts as proof that a missing selected incarnation is live', async () => {
  await checkedMove(); const state = await native.files.read(native.workspaceId);
  const original = structuredClone(state.receipts[0]);
  state.receipts = [{ ...original, state: 'undone' },
    { ...original, id: 'wrong-canvas', after: { ...original.after, canvasId: native.otherCanvasId } as typeof original.after },
    { ...original, id: 'wrong-block', after: { ...original.after, blockId: native.secondary.id } as typeof original.after }];
  expect(await pruneJevWorkspace(native.store, native.workspaceId, state)).toBe(true);
  expect(state.jobs).toEqual([]); expect(state.proposals).toEqual([]); expect(state.receipts).toEqual([]);
  expect((await native.store.getCanvasBlock(native.otherCanvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('forgets an old native incarnation while preserving the recreated identity, member and source bytes', async () => {
  const job = await selectedJob(); await checkedMetadata(native, 0);
  const state = await native.files.read(native.workspaceId);
  state.profiles = { [`${native.canvasId}:${native.primary.id}`]: { source: { ...job.sources[0] } } };
  state.vocabulary = [{ id: 'retained-member', kind: 'label', name: 'Atlas', definition: 'Atlas delivery', aliases: [], state: 'active',
    version: 1, members: [{ canvasId: native.canvasId, blockId: native.primary.id }] }];
  const file = path.join(native.root, 'canvases', `${native.canvasId}.json`);
  const canvas = JSON.parse(await readFile(file, 'utf8'));
  canvas.blocks.find((block: { id: string }) => block.id === native.primary.id).incarnation = randomUUID();
  await atomicJson(file, canvas);
  const store = new CanvasStore(native.root); const recreated = await store.getCanvasBlock(native.canvasId, native.primary.id);
  expect(recreated.incarnation).not.toBe(job.sources[0].incarnation);
  expect(recreated.content).toBe(native.primary.content);
  expect(await pruneJevWorkspace(store, native.workspaceId, state)).toBe(true);
  expect(state.jobs).toEqual([]); expect(state.proposals).toEqual([]); expect(state.receipts).toEqual([]); expect(state.profiles).toEqual({});
  expect(state.vocabulary[0].members).toEqual([{ canvasId: native.canvasId, blockId: native.primary.id }]);
  expect(await store.getCanvasBlock(native.canvasId, native.primary.id)).toEqual(recreated);
});

it('removes an orphan parent Undo journal for a deleted workspace while retaining unknown journal files', async () => {
  const directory = path.join(native.root, 'jev', 'parent-undo'); await mkdir(directory, { recursive: true });
  const missing = path.join(directory, `${randomUUID()}.json`);
  await writeFile(missing, JSON.stringify({ workspaceId: 'removed-workspace', canvasId: native.canvasId }));
  await writeFile(path.join(directory, 'unknown.json'), 'opaque journal bytes');
  await purgeJevOrphans(native.store, native.files);
  await expect(readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(directory, 'unknown.json'), 'utf8')).toBe('opaque journal bytes');
});
