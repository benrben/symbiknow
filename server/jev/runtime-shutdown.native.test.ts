import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string; let blockId: string;
let release: (() => void) | undefined;
const pending: Promise<unknown>[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-shutdown-native-'));
  store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Shutdown' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' })).id;
  runtime = new JevRuntime(store, { startTimer: false });
  await runtime.configure(workspaceId, { modes: { profile: 'auto' } as never }, owner);
  await store.updateBlock(canvasId, blockId, { freshness: { reviewAt: '2026-10-03' } }, 'Browser');
  await runtime.idle();
});
afterEach(async () => { release?.(); release = undefined; runtime.close(); await Promise.allSettled(pending.splice(0)); await runtime.shutdown(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function holdCanonicalWriter() {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writer = store.jevExecutor.serialized(async () => { entered(); await blocked; });
  pending.push(writer);
  await started;
  return { writer };
}

it('waits for an already running native maintenance write before reporting closed runtime idle', async () => {
  const { writer } = await holdCanonicalWriter();
  const tick = runtime.tick(new Date('2026-10-03T12:00:00Z'));
  pending.push(tick);
  runtime.close();
  let stopped = false;
  const idle = runtime.idle().then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(stopped).toBe(false);
  release!();
  await Promise.all([writer, tick, idle]);
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs).toEqual([]);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source');
});

it('awaits startup recovery before allowing immediate native directory removal and ignores later ticks', async () => {
  await runtime.shutdown();
  const { writer } = await holdCanonicalWriter();
  runtime = new JevRuntime(store, { startTimer: false });
  let stopped = false;
  const shutdown = runtime.shutdown().then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(stopped).toBe(false);
  release!(); await Promise.all([writer, shutdown]);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source');
  await rm(root, { recursive: true, force: true });
  await runtime.tick(); await runtime.shutdown();
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('awaits a saved source event without losing its independently completed canonical write', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const files = new JevWorkspaceFiles(root);
  const eventBarrier = files.serial(workspaceId, async () => { entered(); await blocked; });
  pending.push(eventBarrier); await started;
  await store.updateBlock(canvasId, blockId, { content: '# Saved before shutdown' }, 'Browser');
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Saved before shutdown');
  let stopped = false;
  const shutdown = runtime.shutdown().then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(stopped).toBe(false);
  release!(); await Promise.all([eventBarrier, shutdown]);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Saved before shutdown');
});

it('aborts an in-flight provider and persists its terminal state before shutdown resolves', async () => {
  await runtime.configure(workspaceId, { modes: { link: 'auto' } as never }, owner);
  await runtime.shutdown();
  let began!: () => void; let aborted = false;
  const started = new Promise<void>(resolve => { began = resolve; });
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async context => {
    began();
    await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return { result: {}, proposals: [] };
  } });
  const job = await runtime.run(workspaceId, { action: 'link', canvasId, blockIds: [blockId] }, owner);
  await started; await runtime.shutdown();
  expect(aborted).toBe(true);
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed', error: 'The action was cancelled or its policy changed' });
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source');
});

it('settles failed startup recovery without hiding the error or altering the readable native source', async () => {
  await runtime.shutdown();
  const files = new JevWorkspaceFiles(root); const original = await readFile(files.file(workspaceId), 'utf8');
  await writeFile(files.file(workspaceId), '{ corrupt shutdown journal');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  runtime = new JevRuntime(store, { startTimer: false });
  await runtime.shutdown();
  expect(errors).toHaveBeenCalledWith('Symbi Reflex startup requires recovery; ordinary knowledge remains available.');
  expect(await readFile(files.file(workspaceId), 'utf8')).toBe('{ corrupt shutdown journal');
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source');
  await writeFile(files.file(workspaceId), original);
});
