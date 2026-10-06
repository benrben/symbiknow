import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import type { JevEvaluator } from './actions/context.js';
import { JevWorkspaceFiles } from './workspace.js';
import { JevProposalExecutor, type StoredJevReceipt } from './proposals.js';
import { reconcileApprovedOwnership } from './approval-origin.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string; let blockId: string; let group: string; let headline: boolean; let automaticProvider: boolean;
const evaluate: JevEvaluator = async context => {
  if (automaticProvider) context.apiKey = 'native-policy-provider';
  const document = context.documents.find(item => item.block.id === blockId)!;
  return { result: {}, proposals: [{ action: 'file', title: 'File Atlas', explanation: 'Source-backed filing', confidence: 0.99,
    evidence: [{ source: document.snapshot, start: 0, end: 7, quote: '# Atlas' }], sources: [document.snapshot],
    mutation: { kind: 'document', canvasId, blockId, patch: headline ? { headline: '# Atlas source' } : { group } } }] };
};
beforeEach(async () => {
  headline = false; automaticProvider = false; group = 'custom:atlas'; root = await mkdtemp(path.join(tmpdir(), 'reflex-approval-origin-'));
  store = new CanvasStore(root); await store.init(); workspaceId = (await store.createWorkspace({ name: 'Approval origin' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' })).id;
  runtime = new JevRuntime(store, { evaluate, startTimer: false });
  await runtime.configure(workspaceId, { modes: { file: 'auto' } as never }, owner);
});
afterEach(async () => { runtime.close(); await runtime.idle(); await rm(root, { recursive: true, force: true }); });
async function propose() {
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId] }, owner); await runtime.idle();
  return (await runtime.read(workspaceId, owner)).proposals.find(proposal => proposal.jobId === job.id)!;
}
async function legacyApproval() {
  const proposal = await propose(); const execute = store.jevExecutor.execute.bind(store.jevExecutor);
  // Reproduce the prior native approval policy, including its real persisted artifact and exact source clocks.
  store.jevExecutor.execute = (mutation, sources, id, actor, _managed, prepare, ownership, undo) =>
    execute(mutation, sources, id, actor, false, prepare, ownership, undo);
  try { return await runtime.apply(workspaceId, proposal.id, owner); }
  finally { store.jevExecutor.execute = execute; }
}
it('keeps accepted Reflex filing managed so later owner Auto can refile without inventing an automatic approval', async () => {
  const receipt = await runtime.apply(workspaceId, (await propose()).id, owner);
  expect(receipt.automatic).toBe(false);
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).not.toContain('group');
  automaticProvider = true;
  group = 'custom:delivery'; await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as never }, owner);
  await propose();
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBe(group);
  await runtime.reconcile(workspaceId);
});
it('keeps direct corrections and reviewer-edited proposal values manually pinned', async () => {
  const pending = await propose();
  await runtime.revise(workspaceId, pending.id, { kind: 'document', canvasId, blockId, patch: { group: 'custom:edited' } }, owner);
  await runtime.apply(workspaceId, pending.id, owner);
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).toContain('group');
  await runtime.setMetadata(workspaceId, canvasId, blockId, { tags: ['manual'] }, owner);
  await runtime.reconcile(workspaceId);
  const current = await store.getCanvasBlock(canvasId, blockId);
  expect(current.jevOwnership?.pins).toEqual(expect.arrayContaining(['group', 'tags']));
  expect(current.tags).toEqual(['manual']);
});
it('repairs only the exact untouched legacy approval, advances its clock, and preserves the original checked Undo', async () => {
  const receipt = await legacyApproval(); const before = await store.getCanvasBlock(canvasId, blockId);
  expect(before.jevOwnership?.pins).toContain('group');
  await runtime.reconcile(workspaceId);
  const repaired = await new CanvasStore(root).getCanvasBlock(canvasId, blockId);
  expect(repaired.group).toBe('custom:atlas'); expect(repaired.jevOwnership?.pins).not.toContain('group');
  expect(repaired.jevOwnership?.managed).toContain('group'); expect(repaired.metadataRevision).toBeGreaterThan(before.metadataRevision!);
  expect(repaired.sourceGeneration).toBe(before.sourceGeneration);
  await runtime.reconcile(workspaceId);
  const raw = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(raw.proposals.filter(proposal => proposal.jobId.startsWith('origin-migration:'))).toHaveLength(1);
  expect(raw.receipts.filter(item => item.automatic)).toEqual([]);
  expect((await runtime.read(workspaceId, owner)).proposals.some(proposal => proposal.jobId.startsWith('origin-migration:'))).toBe(false);
  expect((await runtime.read(workspaceId, owner)).receipts).toHaveLength(1);
  await runtime.undo(workspaceId, receipt.id, owner);
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
it('preserves legacy pins after any untracked manual metadata correction and skips missing native artifacts', async () => {
  const receipt = await legacyApproval();
  await store.updateBlock(canvasId, blockId, { tags: ['manual later'] }, 'Browser');
  await runtime.reconcile(workspaceId);
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).toEqual(expect.arrayContaining(['group', 'tags']));
  const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
  const saved = state.receipts.find(item => item.id === receipt.id)!;
  delete (saved as { preparedArtifacts?: unknown }).preparedArtifacts; await files.write(workspaceId, state);
  await runtime.reconcile(workspaceId);
  expect((await files.read(workspaceId)).proposals.some(proposal => proposal.jobId.startsWith('origin-migration:'))).toBe(false);
});
it('finishes an interrupted committed migration on restart without a duplicate repair or disabling the original Undo', async () => {
  const receipt = await legacyApproval();
  runtime.close(); await runtime.idle();
  const files = new JevWorkspaceFiles(root); const executor = new JevProposalExecutor(store, files);
  const state = await files.read(workspaceId); const current = await store.getCanvasBlock(canvasId, blockId);
  const proposal = state.proposals.find(item => item.id === receipt.proposalId)!;
  const migration = { ...proposal, id: 'interrupted-origin', jobId: `origin-migration:${receipt.id}`, state: 'pending' as const,
    mutation: { kind: 'document' as const, canvasId, blockId, patch: {} }, sources: receipt.sourcesAfter };
  state.proposals.push(migration); await files.write(workspaceId, state);
  const ownership = { ...current.jevOwnership!, pins: current.jevOwnership!.pins.filter(field => field !== 'group'),
    managed: [...current.jevOwnership!.managed, 'group'] };
  await files.serial(workspaceId, () => executor.applyInside(workspaceId, migration.id, { id: 'workspace-automation', kind: 'automation', access: 'write' }, true, ownership, undefined, false));
  runtime = new JevRuntime(new CanvasStore(root), { evaluate, startTimer: false }); await runtime.idle();
  expect((await files.read(workspaceId)).proposals.filter(item => item.jobId.startsWith('origin-migration:'))).toHaveLength(1);
  await runtime.undo(workspaceId, receipt.id, owner);
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});

async function reconcileRaw() {
  const files = new JevWorkspaceFiles(root); const executor = new JevProposalExecutor(store, files);
  await files.serial(workspaceId, () => store.jevExecutor.serialized(() => reconcileApprovedOwnership(store, files, executor, workspaceId)));
}
it.each(['missing-before-ownership', 'missing-after-artifact', 'changed-marker', 'changed-ownership', 'changed-group', 'missing-proposal', 'missing-source'] as const)(
  'declines a legacy ownership repair when its durable proof is %s', async boundary => {
    const receipt = await legacyApproval(); const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
    const saved = state.receipts.find(item => item.id === receipt.id) as StoredJevReceipt;
    const artifact = saved.preparedArtifacts!.find(item => item.kind === 'canvas')!;
    if (artifact.kind !== 'canvas') throw new Error('Native canvas artifact required');
    const block = artifact.after.blocks.find(item => item.id === blockId)!;
    if (boundary === 'missing-before-ownership') delete artifact.before.blocks.find(item => item.id === blockId)!.jevOwnership;
    if (boundary === 'missing-after-artifact') delete saved.preparedArtifacts;
    if (boundary === 'changed-marker') block.jevMutationId = 'different-native-write';
    if (boundary === 'changed-ownership') block.jevOwnership = { ...block.jevOwnership!, pins: [] };
    if (boundary === 'changed-group') saved.after = { kind: 'document', canvasId, blockId, patch: { group: null } };
    if (boundary === 'missing-proposal') state.proposals = state.proposals.filter(item => item.id !== receipt.proposalId);
    if (boundary === 'missing-source') saved.sourcesAfter = [];
    await files.write(workspaceId, state); await reconcileRaw();
    expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).toContain('group');
    expect((await files.read(workspaceId)).proposals.some(item => item.jobId.startsWith('origin-migration:'))).toBe(false);
  });
it('keeps pre-existing manual pins while repairing native approved typed connections', async () => {
  await store.updateBlock(canvasId, blockId, { tags: ['manual classification'] }, 'Browser');
  const target = await store.createBlock(canvasId, { title: 'Referenced source', content: '# Target reference' });
  runtime.close(); await runtime.idle();
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async (context, request) => {
    const result = await evaluate(context, request); result.proposals[0].mutation = { kind: 'document', canvasId, blockId,
      patch: { links: [target.id], linkTypes: { [target.id]: 'implements' } } };
    result.proposals[0].sources.push(context.documents.find(document => document.block.id === target.id)!.snapshot); return result;
  } });
  await legacyApproval(); await reconcileRaw();
  const current = await store.getCanvasBlock(canvasId, blockId);
  expect(current.links).toEqual([target.id]); expect(current.linkTypes).toEqual({ [target.id]: 'implements' });
  expect(current.jevOwnership?.pins).toEqual(['tags']); expect(current.jevOwnership?.managed).toContain('links');
});
it('retains an earlier manual group pin even when a later Reflex proposal was accepted unchanged', async () => {
  await store.updateBlock(canvasId, blockId, { group: 'custom:manual-before' }, 'Browser');
  await legacyApproval(); await reconcileRaw();
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).toContain('group');
});

it('retains a manual cleared group while ignoring derived analysis receipts in ownership provenance', async () => {
  await store.updateBlock(canvasId, blockId, { group: 'custom:manual-before' }, 'Browser');
  runtime.close(); await runtime.idle();
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async (context, request) => {
    const result = await evaluate(context, request);
    result.proposals[0].mutation = request.action === 'profile'
      ? { kind: 'derived', blockId, values: { role: 'note' } }
      : { kind: 'document', canvasId, blockId, patch: { group: null } };
    result.proposals[0].action = request.action; return result;
  } });
  await legacyApproval(); await reconcileRaw();
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).toContain('group');
  await runtime.configure(workspaceId, { modes: { profile: 'auto' } as never }, owner);
  await runtime.run(workspaceId, { action: 'profile', canvasId, blockIds: [blockId] }, owner); await runtime.idle();
  await reconcileRaw();
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).receipts.some(receipt => receipt.after.kind === 'derived')).toBe(true);
});
it('declines incomplete committed repair artifacts instead of marking the original native proof reconciled', async () => {
  const receipt = await legacyApproval(); await reconcileRaw();
  const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
  const original = state.receipts.find(item => item.id === receipt.id) as StoredJevReceipt & { ownershipReconciled?: boolean };
  delete original.ownershipReconciled; delete original.preparedArtifacts;
  await files.write(workspaceId, state); await reconcileRaw();
  expect((await files.read(workspaceId)).receipts.find(item => item.id === receipt.id)).not.toHaveProperty('ownershipReconciled');
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.managed).toContain('group');
});

it('repairs an older approved group through an exact native receipt chain while preserving a tracked unrelated manual correction', async () => {
  const original = await legacyApproval();
  headline = true; await runtime.apply(workspaceId, (await propose()).id, owner);
  await runtime.setMetadata(workspaceId, canvasId, blockId, { tags: ['manual unrelated classification'] }, owner);
  await reconcileRaw();
  const current = await store.getCanvasBlock(canvasId, blockId);
  expect(current.group).toBe('custom:atlas'); expect(current.headline).toBe('# Atlas source');
  expect(current.tags).toEqual(['manual unrelated classification']);
  expect(current.jevOwnership?.pins).toEqual(['tags']); expect(current.jevOwnership?.managed).toContain('group');
  await runtime.undo(workspaceId, original.id, owner);
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, blockId)).tags).toEqual(['manual unrelated classification']);
});
it('preserves an older approval pin when an untracked manual edit breaks the exact canonical chain', async () => {
  await legacyApproval(); await store.updateBlock(canvasId, blockId, { tags: ['untracked manual correction'] }, 'Browser');
  headline = true; await runtime.apply(workspaceId, (await propose()).id, owner);
  await reconcileRaw();
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).toEqual(expect.arrayContaining(['group', 'tags']));
});
it('preserves the last explicit write of a field even when its value matches an older Reflex approval', async () => {
  await legacyApproval();
  const pending = await propose(); await runtime.revise(workspaceId, pending.id, pending.mutation, owner);
  await runtime.apply(workspaceId, pending.id, owner); await reconcileRaw();
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBe('custom:atlas');
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).toContain('group');
});
it.each(['automatic', 'already-reconciled'] as const)('does not rewrite ownership for a %s historical approval', async boundary => {
  const receipt = await legacyApproval(); const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
  const original = state.receipts.find(item => item.id === receipt.id) as StoredJevReceipt & { ownershipReconciled?: boolean };
  if (boundary === 'automatic') original.automatic = true;
  else original.ownershipReconciled = true;
  await files.write(workspaceId, state); await reconcileRaw();
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.pins).toContain('group');
  expect((await files.read(workspaceId)).proposals.some(item => item.jobId.startsWith('origin-migration:'))).toBe(false);
});
it.each(['exact-native-before', 'later-native-before'] as const)('reads older migrated receipt history through %s without inventing a new repair', async boundary => {
  const receipt = await legacyApproval();
  if (boundary === 'later-native-before') { headline = true; await runtime.apply(workspaceId, (await propose()).id, owner); }
  await reconcileRaw();
  const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
  const original = state.receipts.find(item => item.id === receipt.id) as StoredJevReceipt & { ownershipOriginalAfter?: unknown };
  delete original.ownershipOriginalAfter;
  await files.write(workspaceId, state);
  headline = true; await runtime.apply(workspaceId, (await propose()).id, owner); await reconcileRaw();
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.managed).toContain('group');
  expect((await files.read(workspaceId)).proposals.filter(item => item.jobId.startsWith('origin-migration:'))).toHaveLength(1);
});
it('compares canonical cleared optional metadata while checking an unchanged group approval', async () => {
  runtime.close(); await runtime.idle();
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async (context, request) => {
    const result = await evaluate(context, request);
    result.proposals[0].mutation = { kind: 'document', canvasId, blockId, patch: { group, headline: null } };
    return result;
  } });
  await legacyApproval(); await reconcileRaw();
  expect((await store.getCanvasBlock(canvasId, blockId)).headline).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, blockId)).jevOwnership?.managed).toContain('group');
});
