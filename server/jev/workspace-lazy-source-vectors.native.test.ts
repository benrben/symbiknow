import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevMutation, JevPrincipal, JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { json } from './actions/context.js';
import { JevProposalExecutor } from './proposals.js';
import { sourceSnapshot } from './stamps.js';
import { unreadWorkspaceSourceVector } from './workspace-lazy-source-vectors.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'native-history-owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const quote = 'Synthetic release responsibility stays grounded in this exact canonical paragraph. '.repeat(3).trim();
const content = `# Checked release\r\n${quote}\r\nManual source content remains unchanged.`;
type Derived = Extract<JevMutation, { kind: 'derived' }>;
let root: string; let store: CanvasStore; let files: JevWorkspaceFiles; let executor: JevProposalExecutor;
let workspaceId: string; let canvasId: string; let blockId: string; let secondReceipt: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-lazy-source-history-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Native retained history' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Checked sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Checked release', content, group: 'custom:manual', tags: ['Manual'], x: 123, y: 456 })).id;
  await store.ensureJevStamps(canvasId);
  files = new JevWorkspaceFiles(root); executor = new JevProposalExecutor(store, files);
  await files.write(workspaceId, emptyJevWorkspace()); await apply('First checked recall'); secondReceipt = await apply('Second checked recall');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function apply(query: string): Promise<string> {
  const source = sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, blockId));
  const evidence = { source, quote, start: content.indexOf(quote), end: content.indexOf(quote) + quote.length };
  const state = await files.read(workspaceId);
  const proposal: JevProposal = { id: `proposal-${state.proposals.length}`, jobId: 'native-history', action: 'profile',
    sources: [source], evidence: [evidence], title: 'Checked historical recall', explanation: 'Exact source evidence and prior results',
    createdAt: new Date().toISOString(), state: 'pending', mutation: { kind: 'derived', blockId, values: {
      recall: { query, passages: [{ ...evidence, source: json(source) }], conflicts: [] }, keyPassages: [quote], scopedSources: [json(source)],
    } } };
  state.proposals.push(proposal); await files.write(workspaceId, state);
  const receipt = await executor.applyInside(workspaceId, proposal.id, owner);
  // Produce checked native commits first, then retain their original historical action attribution.
  // Removed actions cannot be newly admitted or applied, but their saved receipts must remain lossless and undoable.
  const historical = await files.read(workspaceId);
  historical.proposals.find(item => item.id === proposal.id)!.action = 'recall';
  historical.receipts.find(item => item.id === receipt.id)!.action = 'recall';
  await files.write(workspaceId, historical);
  return receipt.id;
}
async function originalSource() {
  expect(await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).toMatchObject({ content, title: 'Checked release',
    group: 'custom:manual', tags: ['Manual'], x: 123, y: 456 });
}

describe('a real disk ledger retaining 2428 applied receipts', () => {
  let expected: JevWorkspaceState; let sources: JevSourceSnapshot[];
  beforeEach(async () => {
    const ids = [blockId];
    for (let index = 1; index < 8; index++) ids.push((await store.createBlock(canvasId,
      { title: `Synthetic checked source ${index}`, content: `# Source ${index}\nIndependent canonical responsibility ${index}.` })).id);
    await store.ensureJevStamps(canvasId);
    sources = await Promise.all(ids.map(async id => sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, id))));
    const state = await files.read(workspaceId); const proposal = state.proposals[1]; const receipt = state.receipts[1];
    const mutation = proposal.mutation as Derived;
    // Two seed receipts are guarded canonical commits. The preserved records use real checked eight-document scope.
    for (let index = 2; index < 2428; index++) {
      const id = `historical-${index}`; const scoped: Derived = { ...mutation, values: { ...mutation.values, scopedSources: json(sources) } };
      state.proposals.push({ ...proposal, id: `proposal-${id}`, receiptId: id, sources, mutation: scoped });
      state.receipts.push({ ...receipt, id, proposalId: `proposal-${id}`, before: scoped, after: scoped, sourcesAfter: sources });
    }
    expected = JSON.parse(JSON.stringify(state)) as JevWorkspaceState;
    await files.write(workspaceId, state); expected.revision = state.revision;
  });

  it('reads and rewrites unrelated metadata without restoring retained source vectors, then returns exact independent canonical JSON', async () => {
    const snapshotTexts = new Set(sources.map(source => JSON.stringify(source))); const parse = JSON.parse; let snapshotReads = 0;
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => { if (snapshotTexts.has(text)) snapshotReads++; return parse(text, reviver); });
    // Canonical profile-shape validation reads the one live scoped source; retained history must stay unread.
    const state = await files.read(workspaceId); expect(state.receipts).toHaveLength(2428); expect(snapshotReads).toBe(1);
    const historical = state.receipts[203]; const descriptor = Object.getOwnPropertyDescriptor(historical, 'sourcesAfter');
    expect(descriptor?.get).toBeTypeOf('function');
    const plan = unreadWorkspaceSourceVector(historical, 'sourcesAfter')!; expect(plan.indices).toHaveLength(8);
    let logicalSnapshots = 0;
    for (const receipt of state.receipts) {
      logicalSnapshots += unreadWorkspaceSourceVector(receipt, 'sourcesAfter')!.indices.length;
      for (const mutation of [receipt.before, receipt.after] as Derived[]) {
        logicalSnapshots += unreadWorkspaceSourceVector(mutation.values, 'scopedSources')?.indices.length ?? 0;
      }
    }
    expect(logicalSnapshots).toBeGreaterThan(58_000); expect(snapshotReads).toBe(1);
    const beforeWriteReads = snapshotReads;
    await files.write(workspaceId, state);
    expect(snapshotReads - beforeWriteReads).toBeLessThanOrEqual(sources.length);
    expect(Object.getOwnPropertyDescriptor(historical, 'sourcesAfter')).toEqual(descriptor);
    expect(unreadWorkspaceSourceVector(historical, 'sourcesAfter')).toBe(plan);
    vi.restoreAllMocks();
    const reopened = await new JevWorkspaceFiles(root).read(workspaceId); expected.revision = reopened.revision;
    expect(JSON.stringify(reopened)).toBe(JSON.stringify(expected));
    const first = reopened.receipts[203].sourcesAfter; first[0].incarnation = 'Only this returned occurrence';
    expect(reopened.receipts[204].sourcesAfter).toEqual(sources);
    expect(reopened.proposals[203].sources).toEqual(sources);
    await originalSource();
  });
});

it('keeps mutable guard values independent through reload, real checked Undo and a later stale-source rejection', async () => {
  const originalBytes = await readFile(path.join(root, (await store.getCanvasBlock(canvasId, blockId)).file));
  const before = await files.read(workspaceId); const source = before.proposals[0].sources[0];
  before.proposals[0].sources[0].metadataRevision = 99;
  expect(before.receipts[0].sourcesAfter[0].metadataRevision).not.toBe(99);
  expect((before.profiles[`${canvasId}:${blockId}`].scopedSources as unknown as JevSourceSnapshot[])[0].metadataRevision).not.toBe(99);
  const fresh = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(fresh.proposals[0].sources[0].metadataRevision).not.toBe(99);
  const undo = await new JevProposalExecutor(new CanvasStore(root), new JevWorkspaceFiles(root)).undoInside(workspaceId, secondReceipt, owner);
  expect(undo.before.kind).toBe('derived');
  const reverted = await files.read(workspaceId);
  expect((reverted.profiles[`${canvasId}:${blockId}`].recall as { query: string }).query).toBe('First checked recall');
  expect(reverted.receipts.find(receipt => receipt.id === secondReceipt)!.state).toBe('undone');
  expect(await readFile(path.join(root, (await store.getCanvasBlock(canvasId, blockId)).file))).toEqual(originalBytes);
  await originalSource();
  const stale: JevProposal = { ...reverted.proposals[0], action: 'profile', id: 'stale-native-source', jobId: 'stale-history', state: 'pending', receiptId: undefined };
  reverted.proposals.push(stale); await files.write(workspaceId, reverted);
  await store.updateBlock(canvasId, blockId, { content: `${content}\nAn actual later correction.` }, owner.id);
  await expect(executor.applyInside(workspaceId, stale.id, owner)).rejects.toMatchObject({ status: 409 });
  expect((await files.read(workspaceId)).proposals.find(proposal => proposal.id === stale.id)!.state).toBe('pending');
  expect(content.slice(stale.evidence[0].start, stale.evidence[0].end)).toBe(quote);
  expect(stale.sources[0].incarnation).toBe(source.incarnation);
});
