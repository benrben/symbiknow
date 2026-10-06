import { randomUUID } from 'node:crypto';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevMutation, JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { automationPrincipal } from './authorization.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { JevProposalExecutor } from './proposals.js';
import type { StoredJevJob } from './runtime-queue.js';
import { sourceSnapshot } from './stamps.js';
import { validateJevWorkspacePool } from './workspace-codec.js';
import { JevWorkspaceFiles } from './workspace.js';

type Encoded = { state: JevWorkspaceState; references: Array<{ path: Array<string | number>; vector: number }> };
let native: QueueBoundaryFixture; let receiptId: string;
async function checkedProposal(mutation: JevMutation, action: JevProposal['action']) {
  const source = sourceSnapshot(native.workspaceId, native.canvasId, await native.store.getCanvasBlock(native.canvasId, native.primary.id));
  const proposal: JevProposal = { id: randomUUID(), jobId: 'native-source-reference-history', action, title: 'Keep checked native evidence',
    explanation: 'Use the exact current source.', state: 'pending', confidence: .99, createdAt: new Date().toISOString(), sources: [source],
    evidence: [{ source, start: 0, end: 7, quote: '# Atlas' }], mutation };
  const state = await native.files.read(native.workspaceId); state.proposals.push(proposal); await native.files.write(native.workspaceId, state);
  return native.files.serial(native.workspaceId, () => native.executor.applyInside(native.workspaceId, proposal.id, automationPrincipal, true));
}
beforeEach(async () => {
  native = await queueBoundaryFixture();
  await native.admit({ action: 'profile', canvasId: native.canvasId, blockIds: [native.primary.id] }, automationPrincipal);
  const receipt = await checkedProposal({ kind: 'document', canvasId: native.canvasId, blockId: native.primary.id,
    patch: { group: 'custom:atlas' } }, 'file'); receiptId = receipt.id;
  const sources = [sourceSnapshot(native.workspaceId, native.canvasId, await native.store.getCanvasBlock(native.canvasId, native.primary.id)),
    sourceSnapshot(native.workspaceId, native.otherCanvasId, native.secondary)];
  await checkedProposal({ kind: 'derived', blockId: native.primary.id, values: { role: 'reference', scopedSources: sources.map(source => ({ ...source })) } }, 'profile');
});
afterEach(async () => { await native.close(); });

it('visits real native job guards once while leaving unrelated result payloads and every encoded placeholder untouched', async () => {
  const encoded = JSON.parse(await readFile(native.files.file(native.workspaceId), 'utf8')) as Encoded;
  const job = encoded.state.jobs[0] as StoredJevJob; let reads = 0; let unrelated = 0;
  const sources = job.sources; const context = job.contextSources;
  Object.defineProperty(job, 'sources', { enumerable: true, configurable: true, get: () => { reads++; return sources; } });
  Object.defineProperty(job, 'contextSources', { enumerable: true, configurable: true, get: () => { reads++; return context; } });
  Object.defineProperty(job, 'result', { enumerable: true, configurable: true, get: () => { unrelated++; return { status: 'literal historical result' }; } });
  expect(validateJevWorkspacePool(encoded)).toBeUndefined(); expect(reads).toBe(2); expect(unrelated).toBe(0);
  expect(sources).toEqual([]); expect(context).toEqual([]);
  expect(Object.getOwnPropertyDescriptor(job, 'sources')?.get).toBeTypeOf('function');
  expect((await new JevWorkspaceFiles(native.root).read(native.workspaceId)).jobs[0].sources).toHaveLength(1);
});

it('restores independent mutable guards and derived history while preserving real checked Undo after restart', async () => {
  const files = new JevWorkspaceFiles(native.root); const saved = await readFile(files.file(native.workspaceId));
  const state = await files.read(native.workspaceId);
  const context = (state.jobs[0] as StoredJevJob).contextSources!;
  const profile = state.profiles[`${native.canvasId}:${native.primary.id}`].scopedSources as unknown as JevSourceSnapshot[];
  const receipt = state.receipts.find(item => item.action === 'profile')!;
  const after = (receipt.after as Extract<JevMutation, { kind: 'derived' }>).values.scopedSources as unknown as JevSourceSnapshot[];
  const proposal = state.proposals.find(item => item.action === 'profile')!;
  const proposed = (proposal.mutation as Extract<JevMutation, { kind: 'derived' }>).values.scopedSources as unknown as JevSourceSnapshot[];
  const original = structuredClone(profile);
  context[0].metadataRevision = 999; profile[0].contentHash = 'caller edit';
  expect(after).toEqual(original); expect(proposed).toEqual(original); expect(after).not.toBe(proposed);
  expect(after[0]).not.toBe(proposed[0]); expect(await readFile(files.file(native.workspaceId))).toEqual(saved);
  const reloaded = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(reloaded.profiles[`${native.canvasId}:${native.primary.id}`].scopedSources).toEqual(original);
  const bytes = await readFile(path.join(native.root, native.primary.file));
  const store = new CanvasStore(native.root);
  await store.updateBlock(native.canvasId, native.primary.id, { x: 404, y: 505 }, 'Browser');
  await native.files.serial(native.workspaceId, () => new JevProposalExecutor(store, files).undoInside(native.workspaceId, receiptId, boundaryOwner));
  const restored = await store.getCanvasBlock(native.canvasId, native.primary.id);
  expect(restored.group).toBeUndefined(); expect(restored).toMatchObject({ x: 404, y: 505, content: native.primary.content });
  expect(await readFile(path.join(native.root, native.primary.file))).toEqual(bytes);
});

const rejectedPaths: Array<Array<string | number>> = [['settings', 'people'], ['jobs', 0, 'result', 'sources'],
  ['jobs', 0, 'sources', 0], ['proposals', 0, 'evidence', 0, 'source'], ['profiles', 'literal', 'source'],
  ['prepared', 0, 'artifacts', 0, 'before', 'scopedSources']];
it.each(rejectedPaths.map(badPath => ({ badPath })))('retains canonical and public recovery failures for unsupported source reference path $badPath', async ({ badPath }) => {
  const file = native.files.file(native.workspaceId); const encoded = JSON.parse(await readFile(file, 'utf8')) as Encoded;
  encoded.references[0].path = badPath; const bytes = JSON.stringify(encoded); await writeFile(file, bytes);
  const files = new JevWorkspaceFiles(native.root);
  await expect(files.read(native.workspaceId)).rejects.toMatchObject({ status: 503 });
  await expect(files.readProgress(native.workspaceId)).rejects.toMatchObject({ status: 503 });
  await expect(files.readQueued(native.workspaceId)).rejects.toMatchObject({ status: 503 });
  expect(await readFile(file, 'utf8')).toBe(bytes);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('detects a same-inode equal-size corrupted placeholder with original mtime restored instead of serving cached progress', async () => {
  const files = new JevWorkspaceFiles(native.root); const file = files.file(native.workspaceId); const fixed = new Date('2026-10-04T00:00:00.000Z');
  await utimes(file, fixed, fixed); await files.readProgress(native.workspaceId); const before = await stat(file);
  const bytes = await readFile(file, 'utf8'); const encoded = JSON.parse(bytes) as Encoded;
  encoded.references[0].vector = 9;
  const corrupt = JSON.stringify(encoded); expect(corrupt.length).toBe(bytes.length);
  await writeFile(file, corrupt); await utimes(file, fixed, fixed); const after = await stat(file);
  expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size); expect(after.mtimeMs).toBe(before.mtimeMs);
  await expect(files.read(native.workspaceId)).rejects.toMatchObject({ status: 503 });
  await expect(files.readProgress(native.workspaceId)).rejects.toMatchObject({ status: 503 });
  await expect(files.readQueued(native.workspaceId)).rejects.toMatchObject({ status: 503 });
});
