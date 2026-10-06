import { afterEach, expect, it } from 'vitest';
import type { JevMutation, JevProposal, JevVocabularyTerm } from '../../shared/jev-types.js';
import type { JevArtifact } from '../storage-jev-executor.js';
import { contentHash } from '../storage-shapes.js';
import { automationPrincipal } from './authorization.js';
import { evaluationContext } from './context.js';
import { advanceDocumentContext, assertDocumentContext, snapshotDocumentContext, type DocumentContextProof } from './runtime-document-context.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import type { StoredJevReceipt } from './proposals.js';
import { sourceSnapshot } from './stamps.js';

const fixtures: QueueBoundaryFixture[] = [];
afterEach(async () => { for (const native of fixtures.splice(0)) await native.close(); });
async function fixture() {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  const context = async () => evaluationContext(native.store, native.workspaceId, await native.files.read(native.workspaceId),
    { action: 'profile', canvasId: native.canvasId }, automationPrincipal, new AbortController().signal, { activity: 'validate' });
  const apply = async (mutation: JevMutation): Promise<StoredJevReceipt> => {
    const state = await native.files.read(native.workspaceId);
    const block = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
    const proposal: JevProposal = { id: `context-proposal-${state.proposals.length}`, jobId: 'context-proof', action: 'file',
      title: 'Native context transition', explanation: 'Exact canonical proof', evidence: [],
      sources: [sourceSnapshot(native.workspaceId, native.canvasId, block)], mutation, state: 'pending', createdAt: new Date().toISOString() };
    state.proposals.push(proposal); await native.files.write(native.workspaceId, state);
    return native.executor.applyInside(native.workspaceId, proposal.id, automationPrincipal, true);
  };
  return { native, context, apply };
}

it('keeps a durable order-independent source, task and canvas proof without sharing mutable context values', async () => {
  const { native, context } = await fixture();
  await native.store.createTask(native.canvasId, { title: 'Existing task', detail: 'Preserved dependency' }, 'Browser');
  const original = await context(); const proof = snapshotDocumentContext(original);
  const reloaded = JSON.parse(JSON.stringify(proof));
  assertDocumentContext(reloaded, { ...original, documents: [...original.documents].reverse(), canvases: [...original.canvases].reverse() });
  original.documents[0].snapshot.metadataRevision++;
  expect(() => assertDocumentContext(proof, original)).toThrow('The document context changed during automatic processing');
  assertDocumentContext(reloaded, await context());
});

it.each(['neighbor', 'new source', 'new task', 'canvas name'])('rejects a changed %s against the persisted prefix proof', async change => {
  const { native, context } = await fixture(); const proof = snapshotDocumentContext(await context());
  if (change === 'neighbor') await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { content: '# Later neighboring evidence' }, 'Browser');
  if (change === 'new source') await native.store.createBlock(native.canvasId, { title: 'Added evidence', content: '# Added evidence' });
  if (change === 'new task') await native.store.createTask(native.canvasId, { title: 'Added task', detail: 'Added work' }, 'Browser');
  const fresh = await context(); if (change === 'canvas name') fresh.canvases[0].name += ' renamed';
  expect(() => assertDocumentContext(JSON.parse(JSON.stringify(proof)), fresh)).toThrow('The document context changed during automatic processing');
});

it.each(['group', 'task', 'move'])('advances a crashed prefix only by its own durable %s artifacts and supports idempotent replay', async kind => {
  const { native, context, apply } = await fixture(); const proof = snapshotDocumentContext(await context());
  const mutation: JevMutation = kind === 'group'
    ? { kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { group: 'custom:atlas' } }
    : kind === 'task' ? { kind: 'task_create', canvasId: native.canvasId, task: { title: 'Own task', detail: 'Checked task' } }
      : { kind: 'move', canvasId: native.canvasId, blockId: native.primary.id, targetCanvasId: native.otherCanvasId };
  const receipt = await apply(mutation);
  const restored = JSON.parse(JSON.stringify(proof)); const durableReceipt = JSON.parse(JSON.stringify(receipt));
  const advanced = advanceDocumentContext(restored, [durableReceipt]);
  assertDocumentContext(advanced, await context());
  expect(advanceDocumentContext(advanced, [durableReceipt])).toEqual(advanced);
  expect(restored).toEqual(proof);
});

it('refuses an unrelated task captured before an own task artifact instead of silently adopting it', async () => {
  const { native, context, apply } = await fixture(); const proof = snapshotDocumentContext(await context());
  await native.store.createTask(native.canvasId, { title: 'Unrelated task', detail: 'New manual work' }, 'Browser');
  const receipt = await apply({ kind: 'task_create', canvasId: native.canvasId, task: { title: 'Own task', detail: 'Own checked work' } });
  expect(() => advanceDocumentContext(proof, [receipt])).toThrow('The document context changed during automatic processing');
});

it('refuses unrelated canvas membership captured in its own metadata artifact', async () => {
  const { native, context, apply } = await fixture(); const proof = snapshotDocumentContext(await context());
  await native.store.createBlock(native.canvasId, { title: 'Unrelated source', content: '# New manual source' });
  const receipt = await apply({ kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { group: 'custom:atlas' } });
  expect(() => advanceDocumentContext(proof, [receipt])).toThrow('The document context changed during automatic processing');
});

it('does not accept a later neighboring edit when replaying an exact own receipt', async () => {
  const { native, context, apply } = await fixture(); const proof = snapshotDocumentContext(await context());
  const receipt = await apply({ kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { group: 'custom:atlas' } });
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { content: '# Manual update after the own receipt' }, 'Browser');
  const fresh = await context();
  expect(() => assertDocumentContext(advanceDocumentContext(proof, [receipt]), fresh)).toThrow('The document context changed during automatic processing');
});

it('refuses a canonical receipt without checked artifacts and ignores workspace-only effects', async () => {
  const { native, context, apply } = await fixture(); const proof = snapshotDocumentContext(await context());
  const receipt = await apply({ kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { group: 'custom:atlas' } });
  expect(() => advanceDocumentContext(proof, [{ ...receipt, preparedArtifacts: undefined }])).toThrow();
  expect(advanceDocumentContext(proof, [{ ...receipt, after: { kind: 'derived', blockId: native.primary.id, values: {} } }])).toEqual(proof);
});

function vocabularyTerm(native: QueueBoundaryFixture): JevVocabularyTerm {
  return { id: 'native-context-label', kind: 'label', name: 'Native context', definition: 'Exact context dependency',
    aliases: [], state: 'active', version: 1, members: [{ canvasId: native.canvasId, blockId: native.primary.id }] };
}

it('rejects vocabulary changes while a durable document prefix is offline', async () => {
  const { native, context, apply } = await fixture(); const proof = snapshotDocumentContext(await context());
  await apply({ kind: 'vocabulary', operation: 'define', term: vocabularyTerm(native) });
  const fresh = await context();
  expect(() => assertDocumentContext(JSON.parse(JSON.stringify(proof)), fresh)).toThrow('The document context changed during automatic processing');
});

it('advances only exact own vocabulary definitions, retirements, removals and restoration receipts', async () => {
  const { native, context, apply } = await fixture(); let proof = snapshotDocumentContext(await context());
  const term = vocabularyTerm(native); const retired = { ...term, state: 'retired' as const, version: 2 };
  const mutations: JevMutation[] = [
    { kind: 'vocabulary', operation: 'define', term },
    { kind: 'vocabulary', operation: 'retire', term: retired },
    { kind: 'vocabulary', operation: 'remove', term: retired },
    { kind: 'vocabulary', operation: 'restore', term: { ...term, version: 3 } },
    { kind: 'vocabulary', operation: 'merge', term: { ...term, version: 4, aliases: ['Merged native term'] } },
  ];
  for (const mutation of mutations) {
    const receipt = await apply(mutation);
    proof = advanceDocumentContext(JSON.parse(JSON.stringify(proof)), [receipt]);
    assertDocumentContext(proof, await context());
    expect(advanceDocumentContext(proof, [receipt])).toEqual(proof);
  }
});

it('rejects an own vocabulary receipt whose inverse incorporates an unrelated definition edit', async () => {
  const { native, context, apply } = await fixture(); const term = vocabularyTerm(native);
  await apply({ kind: 'vocabulary', operation: 'define', term });
  const proof = snapshotDocumentContext(await context());
  const state = await native.files.read(native.workspaceId);
  state.vocabulary[0] = { ...term, definition: 'Human correction during interruption', version: 2 };
  await native.files.write(native.workspaceId, state);
  const receipt = await apply({ kind: 'vocabulary', operation: 'rename', term: { ...term, name: 'Own renamed term', version: 3 } });
  expect(() => advanceDocumentContext(proof, [receipt])).toThrow('The document context changed during automatic processing');
});

it('rejects duplicate task identities and malformed or unapplied durable checkpoints', async () => {
  const { native, context, apply } = await fixture();
  await native.store.createTask(native.canvasId, { title: 'One task' }, 'Browser');
  const current = await context();
  current.tasks.push({ ...current.tasks[0] });
  expect(() => snapshotDocumentContext(current)).toThrow('The document context changed during automatic processing');

  const proof = snapshotDocumentContext(await context());
  const receipt = await apply({ kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { group: 'custom:atlas' } });
  for (const invalid of [undefined, { ...proof, version: 2 }, { ...proof, vocabulary: null }] as unknown as DocumentContextProof[]) {
    expect(() => advanceDocumentContext(invalid, [receipt])).toThrow('The document context changed during automatic processing');
  }
  expect(() => advanceDocumentContext(proof, [{ ...receipt, state: 'undone' }])).toThrow('The document context changed during automatic processing');
});

it('rejects artifacts with foreign canvas, unknown task canvas, or intervening source counters', async () => {
  const { native, context, apply } = await fixture();
  const proof = snapshotDocumentContext(await context());
  const receipt = await apply({ kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { group: 'custom:atlas' } });
  const altered = (change: (artifacts: JevArtifact[]) => void): StoredJevReceipt => {
    const copy = structuredClone(receipt);
    change(copy.preparedArtifacts!);
    return copy;
  };
  expect(() => advanceDocumentContext(proof, [altered(artifacts => {
    const canvas = artifacts.find((item): item is Extract<JevArtifact, { kind: 'canvas' }> => item.kind === 'canvas')!;
    canvas.after.workspaceId = 'foreign-workspace';
  })])).toThrow('The document context changed during automatic processing');
  expect(() => advanceDocumentContext(proof, [altered(artifacts => {
    artifacts.push({ kind: 'tasks', id: 'unknown-canvas', before: [], after: [] });
  })])).toThrow('The document context changed during automatic processing');
  const stale = structuredClone(proof);
  stale.sources.find(item => item.blockId === native.primary.id)!.sourceGeneration += 2;
  expect(() => advanceDocumentContext(stale, [receipt])).toThrow('The document context changed during automatic processing');
});

it('uses checked content artifacts for source hashes and ignores unrelated content artifacts', async () => {
  const { native, context, apply } = await fixture();
  const proof = snapshotDocumentContext(await context());
  const receipt = await apply({ kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { group: 'custom:atlas' } });
  const unrelated = structuredClone(receipt);
  unrelated.preparedArtifacts!.push({ kind: 'content', id: 'different-block', file: 'different.md', before: 'Old', after: 'New' });
  expect(advanceDocumentContext(proof, [unrelated])).toEqual(advanceDocumentContext(proof, [receipt]));

  const revised = structuredClone(receipt);
  const block = (await native.store.getCanvasBlock(native.canvasId, native.primary.id));
  revised.preparedArtifacts!.push({ kind: 'content', id: block.id, file: block.file, before: block.content, after: '# Reviewed update' });
  const projected = advanceDocumentContext(proof, [revised]);
  expect(projected.sources.find(source => source.blockId === block.id)?.contentHash).toBe(contentHash('# Reviewed update'));
  expect(proof.sources.find(source => source.blockId === block.id)?.contentHash).toBe(contentHash(block.content));
});

it('rejects vocabulary receipts that change mutation kind or target term', async () => {
  const { native, context, apply } = await fixture();
  const proof = snapshotDocumentContext(await context());
  const receipt = await apply({ kind: 'vocabulary', operation: 'define', term: vocabularyTerm(native) });
  const wrongKind = { ...receipt, before: { kind: 'derived', blockId: native.primary.id, values: {} } as JevMutation };
  expect(() => advanceDocumentContext(proof, [wrongKind])).toThrow('The document context changed during automatic processing');
  const wrongTerm = structuredClone(receipt);
  if (wrongTerm.after.kind !== 'vocabulary') throw new Error('Expected vocabulary mutation');
  wrongTerm.after.term = { ...wrongTerm.after.term, id: 'different-term' };
  expect(() => advanceDocumentContext(proof, [wrongTerm])).toThrow('The document context changed during automatic processing');
});
