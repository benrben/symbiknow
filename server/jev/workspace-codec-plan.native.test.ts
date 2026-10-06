import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import { automationPrincipal } from './authorization.js';
import { JevProposalExecutor, type StoredJevReceipt } from './proposals.js';
import { sourceSnapshot } from './stamps.js';
import { createJevWorkspaceDecodePlan, decodeJevWorkspace, encodeJevWorkspace } from './workspace-codec.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

let root: string; let files: JevWorkspaceFiles; let workspaceId: string; let canvasId: string; let blockId: string; let raw: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-private-decode-plan-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  const store = new CanvasStore(root); await store.init(); files = new JevWorkspaceFiles(root);
  workspaceId = (await store.createWorkspace({ name: 'Native decode proof' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Checked sources' })).id;
  const block = await store.createBlock(canvasId, { title: 'Source', content: '# Source\nKeep exact reviewed knowledge.', x: 17, y: 29 }); blockId = block.id;
  const source = sourceSnapshot(workspaceId, canvasId, block);
  const proposal: JevProposal = { id: randomUUID(), jobId: 'native-reviewed-source', action: 'file', title: 'File reviewed source',
    explanation: 'Exact source topic.', state: 'pending', createdAt: '2026-10-05T00:00:00Z', sources: [source],
    evidence: [{ source, start: 0, end: 8, quote: '# Source' }],
    mutation: { kind: 'document', canvasId, blockId, patch: { group: 'custom:source' } } };
  const state = emptyJevWorkspace(); state.proposals.push(proposal); await files.write(workspaceId, state);
  const executor = new JevProposalExecutor(store, files);
  await files.serial(workspaceId, () => executor.applyInside(workspaceId, proposal.id, automationPrincipal, true));
  const current = await store.getCanvasBlock(canvasId, blockId);
  const derived: JevProposal = { ...proposal, id: randomUUID(), action: 'profile', sources: [sourceSnapshot(workspaceId, canvasId, current)],
    mutation: { kind: 'derived', blockId, values: { role: 'reference', keyPassages: ['Exact reviewed excerpt. '.repeat(40)] } } };
  const ledger = await files.read(workspaceId); ledger.proposals.push(derived); await files.write(workspaceId, ledger);
  await files.serial(workspaceId, () => executor.applyInside(workspaceId, derived.id, automationPrincipal, true));
  raw = await readFile(files.file(workspaceId), 'utf8');
  expect(JSON.parse(raw)).toHaveProperty('version', 3);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function beforeCanvas(state: JevWorkspaceState) {
  const artifact = (state.receipts[0] as StoredJevReceipt).preparedArtifacts!.find(item => item.kind === 'canvas')!;
  if (artifact.kind !== 'canvas') throw new Error('Native metadata receipt requires canvas proofs');
  return artifact.before;
}

it('reuses private checked plans while every native read retains independent mutable source, artifact, derived and ordinary values', async () => {
  const decode = createJevWorkspaceDecodePlan(raw);
  const first = decode() as JevWorkspaceState; const second = decode() as JevWorkspaceState;
  const key = `${canvasId}:${blockId}`; const baseline = JSON.parse(JSON.stringify(decodeJevWorkspace(JSON.parse(raw))));
  const descriptor = Object.getOwnPropertyDescriptor(beforeCanvas(second), 'blocks');
  expect(descriptor?.get).toBeTypeOf('function');
  expect(Object.getOwnPropertyDescriptor(second.profiles[key], 'keyPassages')?.get).toBeTypeOf('function');
  expect(Object.getOwnPropertyDescriptor(second.receipts[0], 'sourcesAfter')?.get).toBeTypeOf('function');
  first.receipts[0].sourcesAfter[0].metadataRevision = 99;
  beforeCanvas(first).blocks[0].x = 999;
  (first.profiles[key].keyPassages as string[]).push('Caller edit');
  first.proposals[0].evidence[0].quote = 'Caller edit'; first.settings.people.push({ id: 'caller', name: 'Caller', role: 'Reviewer' });
  expect(second).toEqual(baseline); expect(decode()).toEqual(baseline);
  expect(await new JevWorkspaceFiles(root).read(workspaceId)).toEqual(baseline);
  expect(await readFile(files.file(workspaceId), 'utf8')).toBe(raw);
});

it('re-encodes unread plan snapshots without materializing artifact, source or derived slots and preserves every native proof', () => {
  const decode = createJevWorkspaceDecodePlan(raw); const state = decode() as JevWorkspaceState;
  const canvas = beforeCanvas(state); const key = `${canvasId}:${blockId}`;
  const descriptors = [Object.getOwnPropertyDescriptor(canvas, 'blocks'), Object.getOwnPropertyDescriptor(state.receipts[0], 'sourcesAfter'),
    Object.getOwnPropertyDescriptor(state.profiles[key], 'keyPassages')];
  expect(JSON.stringify(encodeJevWorkspace(state))).toBe(raw);
  expect(Object.getOwnPropertyDescriptor(canvas, 'blocks')).toEqual(descriptors[0]);
  expect(Object.getOwnPropertyDescriptor(state.receipts[0], 'sourcesAfter')).toEqual(descriptors[1]);
  expect(Object.getOwnPropertyDescriptor(state.profiles[key], 'keyPassages')).toEqual(descriptors[2]);
});

it('detects same-inode same-size external replacement after the mtime is restored while an old plan remains its captured snapshot', async () => {
  const decode = createJevWorkspaceDecodePlan(raw); const file = files.file(workspaceId); const fixed = new Date('2026-10-05T00:00:00Z');
  await utimes(file, fixed, fixed); await files.read(workspaceId); const before = await stat(file);
  const replaced = raw.replaceAll('"reference"', '"decisions"'); expect(replaced).not.toBe(raw); expect(Buffer.byteLength(replaced)).toBe(Buffer.byteLength(raw));
  await writeFile(file, replaced); await utimes(file, fixed, fixed); const after = await stat(file);
  expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size); expect(after.mtimeMs).toBe(before.mtimeMs);
  expect((decode() as JevWorkspaceState).profiles[`${canvasId}:${blockId}`].role).toBe('reference');
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).profiles[`${canvasId}:${blockId}`].role).toBe('decisions');
  const updated = createJevWorkspaceDecodePlan(await readFile(file, 'utf8'))() as JevWorkspaceState;
  expect(updated.profiles[`${canvasId}:${blockId}`].role).toBe('decisions');
});

it.each(['source', 'source reference', 'artifact', 'artifact reference', 'derived reference', 'duplicate derived reference'])
('rejects malformed %s before capturing a reusable plan and keeps native recovery errors visible', async failure => {
  const value = JSON.parse(raw);
  if (failure === 'source') value.sources[0].metadataRevision = -1;
  if (failure === 'source reference') value.references[0].path = ['settings', 'people'];
  if (failure === 'artifact') value.blocks[0].file = 99;
  if (failure === 'artifact reference') value.blockReferences[0].vector = 999;
  if (failure === 'derived reference') value.derivedValueReferences[0].value = 999;
  if (failure === 'duplicate derived reference') value.derivedValueReferences.push(value.derivedValueReferences[0]);
  const content = JSON.stringify(value);
  expect(() => createJevWorkspaceDecodePlan(content)).toThrowError(expect.objectContaining({ status: 503 }));
  await writeFile(files.file(workspaceId), content);
  await expect(files.read(workspaceId)).rejects.toMatchObject({ status: 503 });
});

it('preserves source-only and artifact-only version plans alongside independent legacy literal extensions', () => {
  const sourceOnly = emptyJevWorkspace(); sourceOnly.profiles.source = { scopedSources: (createJevWorkspaceDecodePlan(raw)() as JevWorkspaceState).receipts[0].sourcesAfter as never };
  const encodedSource = JSON.stringify(encodeJevWorkspace(sourceOnly)); expect(JSON.parse(encodedSource).version).toBe(1);
  expect(createJevWorkspaceDecodePlan(encodedSource)()).toEqual(sourceOnly);
  const artifactOnly = emptyJevWorkspace(); artifactOnly.receipts = [{ preparedArtifacts: [{ kind: 'canvas', id: canvasId,
    before: beforeCanvas(createJevWorkspaceDecodePlan(raw)() as JevWorkspaceState) }] }] as never;
  const encodedArtifact = JSON.stringify(encodeJevWorkspace(artifactOnly)); expect(JSON.parse(encodedArtifact).version).toBe(2);
  expect(createJevWorkspaceDecodePlan(encodedArtifact)()).toEqual(artifactOnly);
  const legacy = emptyJevWorkspace(); Object.assign(legacy, { codec: 'future literal', notes: { exact: ['Private retained value'] } });
  const decode = createJevWorkspaceDecodePlan(JSON.stringify(legacy)); const first = decode() as typeof legacy & { notes: { exact: string[] } };
  first.notes.exact.push('Caller edit'); expect(decode()).toEqual(legacy);
  expect(() => createJevWorkspaceDecodePlan('{broken')).toThrow(SyntaxError);
});
