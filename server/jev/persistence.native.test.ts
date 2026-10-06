import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevSourceSnapshot } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { sourceSnapshot } from './stamps.js';
import { hasActiveJevDraft, readJevDraft, setJevDraftState, stageJevDraft } from './drafts.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

let root: string;
let source: JevSourceSnapshot;
const input = { id: 'reviewed-edit', baseContent: '# Source', proposedContent: '# Reviewed source', instruction: 'Clarify the heading' };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-persistence-'));
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Review' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
  const block = await store.createBlock(canvas.id, { title: 'Source', content: input.baseContent });
  source = sourceSnapshot(workspace.id, canvas.id, block);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const draftFile = () => path.join(root, 'jev', 'drafts', source.canvasId, `${source.blockId}.json`);

it('protects an active agent draft even when another actor reuses its ID, while allowing explicit reviewer rebase', async () => {
  expect(await readJevDraft(root, source.canvasId, source.blockId)).toBeUndefined();
  expect(await hasActiveJevDraft(root, source.canvasId, source.blockId)).toBe(false);
  const first = await stageJevDraft(root, source, input, 'agent-a');
  expect(first).toMatchObject({ generation: 1, state: 'staged' });
  expect(await hasActiveJevDraft(root, source.canvasId, source.blockId)).toBe(true);
  expect((await stat(draftFile())).mode & 0o777).toBe(0o600);
  for (const id of [input.id, 'other-id']) {
    await expect(stageJevDraft(root, source, { ...input, id }, 'agent-b')).rejects.toMatchObject({ status: 409 });
    expect(await readJevDraft(root, source.canvasId, source.blockId)).toEqual(first);
  }
  const rebased = await stageJevDraft(root, source, input, 'reviewer', { reviewer: true });
  expect(rebased.generation).toBe(2);
  await setJevDraftState(root, source.canvasId, source.blockId, 'wrong-id', 'applied');
  await setJevDraftState(root, source.canvasId, source.blockId, input.id, 'applied', 1);
  expect((await readJevDraft(root, source.canvasId, source.blockId))?.state).toBe('staged');
  await setJevDraftState(root, source.canvasId, source.blockId, input.id, 'cancelled', 2);
  expect(await hasActiveJevDraft(root, source.canvasId, source.blockId)).toBe(false);
  const unchanged = await stageJevDraft(root, source, { ...input, proposedContent: input.baseContent }, 'agent-b');
  expect(unchanged).toMatchObject({ state: 'ready', generation: 3 });
  await setJevDraftState(root, source.canvasId, source.blockId, input.id, 'applied');
  expect(await hasActiveJevDraft(root, source.canvasId, source.blockId)).toBe(false);
  const next = await stageJevDraft(root, source, input, 'agent-c');
  expect(next.generation).toBe(4);
  await stageJevDraft(root, source, input, 'agent-c');
  await writeFile(draftFile(), JSON.stringify({ ...next, expiresAt: '2000-01-01T00:00:00Z' }));
  expect(await hasActiveJevDraft(root, source.canvasId, source.blockId)).toBe(false);
});

it('rejects malformed staged input before persisting an unreadable draft', async () => {
  for (const patch of [{ id: '' }, { id: 'a'.repeat(201) }, { proposedContent: 5 }, { instruction: 'a'.repeat(1_000_001) },
    { baseContent: 'a'.repeat(1_000_001) }]) {
    await expect(stageJevDraft(root, source, { ...input, ...patch } as typeof input, 'agent')).rejects.toMatchObject({ status: 400 });
  }
  await expect(stageJevDraft(root, source, input, '')).rejects.toMatchObject({ status: 400 });
  await expect(stageJevDraft(root, { ...source, incarnation: '' }, input, 'agent')).rejects.toMatchObject({ status: 400 });
  expect(await readJevDraft(root, source.canvasId, source.blockId)).toBeUndefined();
  await setJevDraftState(root, source.canvasId, source.blockId, input.id, 'cancelled');
  for (const target of [['../outside', source.blockId], [source.canvasId, '../outside']]) {
    await expect(readJevDraft(root, target[0], target[1])).rejects.toMatchObject({ status: 400 });
  }
});

it('surfaces corrupt, mismatched and unreadable draft journals without accepting them as absent', async () => {
  const draft = await stageJevDraft(root, source, input, 'agent');
  const corrupt = ['not JSON', 'null', JSON.stringify({ ...draft, generation: 0 }),
    JSON.stringify({ ...draft, expiresAt: 'not a date' }), JSON.stringify({ ...draft, source: { ...source, canvasId: 'other' } }),
    JSON.stringify({ ...draft, source: { ...source, blockId: 'other' } })];
  for (const content of corrupt) {
    await writeFile(draftFile(), content);
    await expect(readJevDraft(root, source.canvasId, source.blockId)).rejects.toMatchObject({ status: 503 });
    expect(await readFile(draftFile(), 'utf8')).toBe(content);
  }
  await rm(draftFile()); await mkdir(draftFile());
  await expect(readJevDraft(root, source.canvasId, source.blockId)).rejects.toMatchObject({ code: 'EISDIR' });
});

it('keeps workspace configuration and vocabulary corruption explicit and preserves the journal', async () => {
  const files = new JevWorkspaceFiles(root); const workspaceId = source.workspaceId;
  expect(await files.read(workspaceId)).toEqual(emptyJevWorkspace());
  const initial = emptyJevWorkspace(); await files.write(workspaceId, initial);
  expect(initial.revision).toBe(1);
  expect((await stat(files.file(workspaceId))).mode & 0o777).toBe(0o600);
  for (const content of ['not JSON', '{}', JSON.stringify({ ...initial, settings: { ...initial.settings, people: [null] } }),
    JSON.stringify({ ...initial, vocabulary: [{ id: 'broken' }] })]) {
    await writeFile(files.file(workspaceId), content);
    await expect(files.read(workspaceId)).rejects.toMatchObject({ status: 503 });
    expect(await readFile(files.file(workspaceId), 'utf8')).toBe(content);
  }
  await rm(files.file(workspaceId)); await mkdir(files.file(workspaceId));
  await expect(files.read(workspaceId)).rejects.toMatchObject({ code: 'EISDIR' });
  await expect(files.read('../outside')).rejects.toMatchObject({ status: 400 });
});

it('serializes independent workspace file instances through both failed and successful operations', async () => {
  const first = new JevWorkspaceFiles(root); const second = new JevWorkspaceFiles(root);
  const order: string[] = [];
  const failed = first.serial(source.workspaceId, async () => { order.push('failed'); throw new Error('Interrupted operation'); });
  const saved = second.serial(source.workspaceId, async () => { order.push('saved'); await second.write(source.workspaceId, emptyJevWorkspace()); });
  await expect(failed).rejects.toThrow('Interrupted operation'); await saved;
  await first.serial(source.workspaceId, async () => { order.push('read'); expect((await first.read(source.workspaceId)).revision).toBe(1); });
  expect(order).toEqual(['failed', 'saved', 'read']);
});
