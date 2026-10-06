import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JevMutation, JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevProposalExecutor } from './proposals.js';
import { sourceSnapshot } from './stamps.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';
import { decodeJevWorkspace, validateJevWorkspacePool } from './workspace-codec.js';
import { json } from './actions/context.js';

const owner: JevPrincipal = { id: 'native-history-owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const quote = 'Synthetic checked release responsibility remains grounded in this exact canonical source paragraph. '.repeat(4).trim();
const content = `# Checked release\n${quote}\nManual source content and delivery notes remain unchanged.`;
let root: string; let store: CanvasStore; let files: JevWorkspaceFiles; let executor: JevProposalExecutor;
let workspaceId: string; let canvasId: string; let blockId: string; let profileKey: string; let firstReceipt: string; let secondReceipt: string;
type Derived = Extract<JevMutation, { kind: 'derived' }>;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-derived-history-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Native historical analysis' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Checked delivery' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Checked release', content, group: 'custom:manual', tags: ['Manual'], x: 123, y: 456 })).id;
  await store.ensureJevStamps(canvasId); profileKey = `${canvasId}:${blockId}`;
  files = new JevWorkspaceFiles(root); executor = new JevProposalExecutor(store, files);
  await files.write(workspaceId, emptyJevWorkspace());
  firstReceipt = await apply('First exact recall'); secondReceipt = await apply('Second exact recall');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function apply(query: string): Promise<string> {
  const source = sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, blockId));
  const evidence = { source, quote, start: content.indexOf(quote), end: content.indexOf(quote) + quote.length };
  const sourceJson = json(source); const passageJson = { ...evidence, source: sourceJson };
  const state = await files.read(workspaceId);
  const proposal: JevProposal = { id: `proposal-${state.proposals.length}`, jobId: 'native-historical-fixture', action: 'profile',
    sources: [source], evidence: [evidence], title: 'Exact historical analysis', explanation: 'Preserve checked source evidence and prior results',
    createdAt: new Date().toISOString(), state: 'pending', mutation: { kind: 'derived', blockId, values: {
      recall: { query, passages: [passageJson], conflicts: [], evidenceFound: true }, keyPassages: [quote],
      qualityRubric: { clarity: { score: 1, evidence: passageJson }, completeness: { score: 2, evidence: passageJson } },
      linkRechecks: [{ source: sourceJson, quote, valid: true }], scopedSources: [sourceJson],
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
async function unchangedSource() {
  expect(await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).toMatchObject({ content, title: 'Checked release',
    group: 'custom:manual', tags: ['Manual'], x: 123, y: 456 });
}

describe('a native disk ledger with 2428 preserved receipts', () => {
  let legacy: string;
  beforeEach(async () => {
    const state = await files.read(workspaceId); const proposal = state.proposals[1]; const receipt = state.receipts[1];
    const mutation = proposal.mutation as Derived;
    // The seed receipts are real guarded commits; these independent older records exercise the reported ledger magnitude.
    for (let index = 2; index < 2428; index++) {
      const id = `historical-${index}`;
      const after: Derived = { ...mutation, values: { ...mutation.values,
        recall: { ...(mutation.values.recall as Record<string, unknown>), query: `Synthetic historical candidate ${index % 203}` } } };
      state.proposals.push({ ...proposal, id: `proposal-${id}`, receiptId: id, mutation: after });
      state.receipts.push({ ...receipt, id, proposalId: `proposal-${id}`, after });
    }
    legacy = JSON.stringify(state); await writeFile(files.file(workspaceId), legacy, { mode: 0o600 });
  });
  it('migrates full historical JSON to a smaller lossless native packet and rewrites unrelated metadata without reading historical bodies', async () => {
    const state = await files.read(workspaceId); expect(state.receipts).toHaveLength(2428); expect(state.proposals).toHaveLength(2428);
    await files.write(workspaceId, state);
    const encoded = await readFile(files.file(workspaceId), 'utf8'); const packet = JSON.parse(encoded);
    expect(packet.version).toBe(3); expect(packet.derivedValues.length).toBeGreaterThan(200);
    expect(packet.derivedValueReferences.length).toBeGreaterThan(10_000);
    expect(Buffer.byteLength(encoded)).toBeLessThan(Buffer.byteLength(legacy) * .5);
    expect(validateJevWorkspacePool(packet)).toBeUndefined();
    const restored = await files.read(workspaceId);
    const historical = (restored.receipts[2].before as Derived).values;
    const descriptor = Object.getOwnPropertyDescriptor(historical, 'recall'); expect(descriptor?.get).toBeTypeOf('function');
    restored.revision += 1;
    await files.write(workspaceId, restored);
    expect(Object.getOwnPropertyDescriptor(historical, 'recall')).toEqual(descriptor);
    const reopened = await new JevWorkspaceFiles(root).read(workspaceId);
    const expected = JSON.parse(legacy) as JevWorkspaceState; expected.revision = reopened.revision;
    expect(JSON.stringify(reopened)).toBe(JSON.stringify(expected));
    const source = sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, blockId));
    for (const item of [reopened.proposals[203], reopened.receipts[203]]) {
      const mutation = ('mutation' in item ? item.mutation : item.after) as Derived;
      const passage = ((mutation.values.recall as Record<string, unknown>).passages as Array<{ source: unknown; quote: string; start: number; end: number }>)[0];
      expect(passage.source).toEqual(source); expect(content.slice(passage.start, passage.end)).toBe(passage.quote);
    }
    expect(reopened.receipts[0].id).toBe(firstReceipt); expect(reopened.receipts[1].id).toBe(secondReceipt);
    await unchangedSource();
  });
});

it('keeps caller mutations independent, performs real checked Undo after reload, and rejects stale native sources', async () => {
  const bytes = await readFile(files.file(workspaceId), 'utf8'); const packet = JSON.parse(bytes);
  expect(packet.version).toBe(3);
  const state = await files.read(workspaceId); const after = (state.receipts[0].after as Derived).values;
  (after.recall as Record<string, unknown>).query = 'Only the caller changed this occurrence';
  expect(((state.proposals[0].mutation as Derived).values.recall as Record<string, unknown>).query).toBe('First exact recall');
  expect((state.profiles[profileKey].recall as Record<string, unknown>).query).toBe('Second exact recall');
  expect(await readFile(files.file(workspaceId), 'utf8')).toBe(bytes);
  const canonical = decodeJevWorkspace(packet) as JevWorkspaceState;
  expect(((canonical.receipts[0].after as Derived).values.recall as Record<string, unknown>).query).toBe('First exact recall');
  const undo = await new JevProposalExecutor(store, new JevWorkspaceFiles(root)).undoInside(workspaceId, secondReceipt, owner);
  expect(undo.before.kind).toBe('derived');
  const reopened = await new JevWorkspaceFiles(root).read(workspaceId);
  expect((reopened.profiles[profileKey].recall as Record<string, unknown>).query).toBe('First exact recall');
  expect(reopened.receipts.find(item => item.id === secondReceipt)?.state).toBe('undone');
  expect(reopened.receipts.find(item => item.id === firstReceipt)?.state).toBe('applied');
  await unchangedSource();
  const stale = { ...reopened.proposals[0], action: 'profile' as const, id: 'stale-native-derived', jobId: 'historical-stale', state: 'pending' as const, receiptId: undefined };
  reopened.proposals.push(stale); await files.write(workspaceId, reopened);
  await store.updateBlock(canvasId, blockId, { content: `${content}\nAn actual later source correction.` }, owner.id);
  await expect(executor.applyInside(workspaceId, stale.id, owner)).rejects.toMatchObject({ status: 409 });
  expect((await files.read(workspaceId)).proposals.find(item => item.id === stale.id)?.state).toBe('pending');
});
