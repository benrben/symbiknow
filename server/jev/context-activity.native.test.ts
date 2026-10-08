import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { JevMutation, JevPrincipal, JevProposal, JevReceipt, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { evaluationContext, type JevEvaluationContextOptions } from './context.js';
import { sourceSnapshot } from './stamps.js';
import { encodeJevWorkspace } from './workspace-codec.js';
import { unreadWorkspaceSourceVector } from './workspace-lazy-source-vectors.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'activity-reviewer', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const createdAt = '2026-10-05T00:00:00Z';
let root: string; let store: CanvasStore; let files: JevWorkspaceFiles;
let workspaceId: string; let canvasId: string; let sources: JevSourceSnapshot[]; let hidden: JevSourceSnapshot;
let baselineRoot: string;
let retainedBaseline: { file: string; expected: string };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-context-activity-'));
  baselineRoot = root;
  store = new CanvasStore(root); await store.init(); files = new JevWorkspaceFiles(root);
  workspaceId = (await store.createWorkspace({ name: 'Retained activity' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Checked release sources' })).id;
  const blocks = [];
  for (let index = 0; index < 8; index++) blocks.push(await store.createBlock(canvasId, {
    title: `Release source ${index}`, content: `# Release ${index}\r\nCanonical responsibility ${index} stays exact.`,
  }));
  await store.ensureJevStamps(canvasId);
  sources = await Promise.all(blocks.map(async block => sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, block.id))));
  const hiddenCanvas = (await store.createCanvas(workspaceId, { name: 'Private source' })).id;
  const block = await store.createBlock(hiddenCanvas, { title: 'Private responsibility', content: '# Private\nRestricted responsibility.' });
  await store.ensureJevStamps(hiddenCanvas);
  hidden = sourceSnapshot(workspaceId, hiddenCanvas, await store.getCanvasBlock(hiddenCanvas, block.id));
  const retained = await createRetainedLedger();
  const file = path.join(baselineRoot, 'retained-activity-baseline.json');
  await cp(files.file(workspaceId), file);
  retainedBaseline = { file, expected: retained.expected };
  await rm(files.file(workspaceId));
});
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-context-activity-copy-'));
  // Preserve a complete native Git/data baseline; each assertion still operates
  // on an independent directory, fresh store, and independently written ledger.
  await cp(baselineRoot, root, { recursive: true });
  store = new CanvasStore(root); await store.init(); files = new JevWorkspaceFiles(root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
afterAll(async () => { await rm(baselineRoot, { recursive: true, force: true }); });

function receipt(id: string, scopedSources = sources, after: JevMutation = { kind: 'derived', blockId: sources[0].blockId,
  values: { scopedSources: scopedSources as never, role: 'reference' } }): JevReceipt {
  return { id, proposalId: `proposal-${id}`, action: 'profile', actor: owner.id, state: 'applied', createdAt,
    before: { kind: 'derived', blockId: sources[0].blockId, values: {} }, after, sourcesAfter: scopedSources };
}
function context(state: JevWorkspaceState, options?: JevEvaluationContextOptions, principal = owner) {
  return evaluationContext(store, workspaceId, state, { action: 'profile', canvasId, blockIds: [sources[0].blockId] },
    principal, new AbortController().signal, options);
}
async function createRetainedLedger(): Promise<{ state: JevWorkspaceState; expected: string }> {
  const state = emptyJevWorkspace();
  for (let index = 0; index < 2428; index++) {
    const item = receipt(`retained-${index}`);
    state.receipts.push({ ...item, privateAudit: { original: 'Private retained evidence\r\nUnicode café',
      literal: { $jevSourceVector: 0 }, source: sources[0] } } as JevReceipt);
    const proposal: JevProposal = { id: item.proposalId, jobId: 'retained-profile', action: item.action,
      title: 'Checked retained profile', explanation: 'Retained exact source evidence', createdAt, state: 'applied',
      receiptId: item.id, evidence: [], sources, mutation: item.after };
    state.proposals.push(proposal);
  }
  await files.write(workspaceId, state);
  return { state: await new JevWorkspaceFiles(root).read(workspaceId), expected: JSON.stringify(encodeJevWorkspace(state)) };
}
async function retainedLedger(): Promise<{ state: JevWorkspaceState; expected: string }> {
  // The large packet was produced by the actual writer once. Copy its bytes
  // into this case's independent workspace and read through the native codec.
  await cp(retainedBaseline.file, files.file(workspaceId));
  return { state: await new JevWorkspaceFiles(root).read(workspaceId), expected: retainedBaseline.expected };
}

it('validates a retained disk ledger without reading pooled vectors or dropping saved history and private metadata', async () => {
  const { state, expected } = await retainedLedger();
  const bytes = await readFile(files.file(workspaceId));
  const first = state.receipts[0]; const last = state.receipts.at(-1)!;
  const firstDescriptor = Object.getOwnPropertyDescriptor(first, 'sourcesAfter');
  const lastDescriptor = Object.getOwnPropertyDescriptor(last, 'sourcesAfter');
  const plans = state.receipts.map(item => unreadWorkspaceSourceVector(item, 'sourcesAfter'));
  expect(plans.every(plan => plan?.indices.length === 8)).toBe(true);
  expect(plans.reduce((total, plan) => total + plan!.indices.length, 0)).toBe(19_424);
  const input = await context(state, { activity: 'validate' }, { ...owner, allowedCanvasIds: [canvasId] });
  expect(input.activity).toBeUndefined();
  expect(input.documents).toHaveLength(8);
  expect(state.receipts.every((item, index) => unreadWorkspaceSourceVector(item, 'sourcesAfter') === plans[index])).toBe(true);
  expect(state.proposals.every(item => unreadWorkspaceSourceVector(item, 'sources') !== undefined)).toBe(true);
  expect(Object.getOwnPropertyDescriptor(first, 'sourcesAfter')).toEqual(firstDescriptor);
  expect(Object.getOwnPropertyDescriptor(last, 'sourcesAfter')).toEqual(lastDescriptor);
  expect((await readFile(files.file(workspaceId))).equals(bytes)).toBe(true);
  expect(JSON.stringify(encodeJevWorkspace(state))).toBe(expected);
  expect(state.receipts.every((item, index) => unreadWorkspaceSourceVector(item, 'sourcesAfter') === plans[index])).toBe(true);
  expect(state.proposals.every(item => unreadWorkspaceSourceVector(item, 'sources') !== undefined)).toBe(true);
  const nextEncoded = JSON.parse(expected) as { state: JevWorkspaceState };
  nextEncoded.state.revision += 1;
  await files.write(workspaceId, state);
  expect(state.receipts.every((item, index) => unreadWorkspaceSourceVector(item, 'sourcesAfter') === plans[index])).toBe(true);
  expect(state.proposals.every(item => unreadWorkspaceSourceVector(item, 'sources') !== undefined)).toBe(true);
  expect(await readFile(files.file(workspaceId), 'utf8')).toBe(JSON.stringify(nextEncoded));
  const reopened = await files.read(workspaceId);
  expect(reopened.receipts).toHaveLength(2428);
  expect(reopened.receipts[0].sourcesAfter).toEqual(sources);
  expect(reopened.receipts.at(-1)!.sourcesAfter).toEqual(sources);
  expect(reopened.proposals[0].sources).toEqual(sources);
  expect(reopened.proposals.at(-1)!.sources).toEqual(sources);
  expect((reopened.receipts[0] as JevReceipt & { privateAudit: unknown }).privateAudit).toEqual({
    original: 'Private retained evidence\r\nUnicode café', literal: { $jevSourceVector: 0 }, source: sources[0],
  });
});

it('includes and hydrates complete retained activity by default with independently owned source occurrences', async () => {
  const { state } = await retainedLedger();
  expect(unreadWorkspaceSourceVector(state.receipts[0], 'sourcesAfter')).toBeDefined();
  const input = await context(state);
  expect(input.activity).toHaveLength(2428);
  expect(input.activity![0]).toEqual({ id: 'retained-0', action: 'profile', createdAt,
    summary: 'Applied profile', sources });
  expect(state.receipts.every(item => unreadWorkspaceSourceVector(item, 'sourcesAfter') === undefined)).toBe(true);
  expect(input.activity![0].sources).toBe(state.receipts[0].sourcesAfter);
  input.activity![0].sources[0].metadataRevision = 999;
  expect(input.activity![1].sources[0]).toEqual(sources[0]);
  expect(state.proposals[0].sources[0]).toEqual(sources[0]);
});

it.each([undefined, 'include'] as const)('preserves ordinary public scoped activity for mode %s', async mode => {
  const state = emptyJevWorkspace();
  const patch: JevMutation = { kind: 'document', canvasId, blockId: sources[0].blockId, patch: { headline: 'Checked responsibility' } };
  state.receipts = [receipt('visible', [sources[0]], patch), receipt('private', [hidden]), receipt('mixed', [sources[0], hidden])];
  const input = await context(state, mode === undefined ? undefined : { activity: mode }, { ...owner, allowedCanvasIds: [canvasId] });
  expect(input.activity).toEqual([{ id: 'visible', action: 'profile', createdAt, summary: 'Applied profile: headline', sources: [sources[0]] }]);
  expect(Object.keys(input)).toContain('activity');
  expect({ ...input }.activity).toBe(input.activity);
});

it.each([undefined, 'include', 'validate'] as const)('rejects malformed ordinary source history in mode %s', async mode => {
  const state = emptyJevWorkspace();
  for (const malformed of [undefined, null, 'invalid', [null]]) {
    state.receipts = [{ ...receipt('malformed'), sourcesAfter: malformed } as unknown as JevReceipt];
    await expect(context(state, mode === undefined ? undefined : { activity: mode })).rejects.toThrow(TypeError);
  }
});

it('validates externally replaced pooled fields as ordinary history instead of trusting a stale plan', async () => {
  const { state } = await retainedLedger();
  const first = state.receipts[0];
  Object.defineProperty(first, 'sourcesAfter', { value: null, writable: true, enumerable: true, configurable: true });
  expect(unreadWorkspaceSourceVector(first, 'sourcesAfter')).toBeUndefined();
  await expect(context(state, { activity: 'validate' })).rejects.toThrow(TypeError);
});

it.each(['include', 'validate'] as const)('preserves visible malformed-summary failures while excluding private history in mode %s', async mode => {
  const principal = { ...owner, allowedCanvasIds: [canvasId] };
  const state = emptyJevWorkspace();
  const malformed = [undefined, null,
    { kind: 'document', canvasId, blockId: sources[0].blockId, patch: undefined },
    { kind: 'document', canvasId, blockId: sources[0].blockId, patch: null }];
  for (const after of malformed) {
    state.receipts = [{ ...receipt('visible'), after } as unknown as JevReceipt];
    await expect(context(state, { activity: mode }, principal)).rejects.toThrow(TypeError);
    state.receipts = [{ ...receipt('private', [hidden]), after } as unknown as JevReceipt];
    const input = await context(state, { activity: mode }, principal);
    expect(input.activity).toEqual(mode === 'include' ? [] : undefined);
  }
});

it('checks the exact scoped visibility of pooled snapshots without exposing source slots, including mixed private history', async () => {
  const state = emptyJevWorkspace();
  state.receipts = [receipt('visible'), { ...receipt('private', [hidden]), after: null } as unknown as JevReceipt,
    { ...receipt('mixed', [sources[0], hidden]), after: { kind: 'document', canvasId, blockId: sources[0].blockId,
      patch: null } } as unknown as JevReceipt];
  await files.write(workspaceId, state);
  const pooled = await files.read(workspaceId);
  const plans = pooled.receipts.map(item => unreadWorkspaceSourceVector(item, 'sourcesAfter'));
  expect(plans.every(plan => plan !== undefined)).toBe(true);
  const scoped = { ...owner, allowedCanvasIds: [canvasId] };
  expect((await context(pooled, { activity: 'validate' }, scoped)).activity).toBeUndefined();
  expect(pooled.receipts.every((item, index) => unreadWorkspaceSourceVector(item, 'sourcesAfter') === plans[index])).toBe(true);
  await expect(context(pooled, { activity: 'validate' })).rejects.toThrow(TypeError);
  expect(pooled.receipts.every((item, index) => unreadWorkspaceSourceVector(item, 'sourcesAfter') === plans[index])).toBe(true);
  const included = await context(await files.read(workspaceId), { activity: 'include' }, scoped);
  expect(included.activity?.map(item => item.id)).toEqual(['visible']);
});
