import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevEvaluation, JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-configuration-scope-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Configuration scope' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  // No action is run here; the evaluator only satisfies the runtime contract.
  runtime = new JevRuntime(store, { evaluate: async (): Promise<JevEvaluation> => ({ result: {}, proposals: [] }), startTimer: false });
});
afterEach(async () => { runtime.close(); await runtime.idle(); await rm(root, { recursive: true, force: true }); });

it('lets a canvas-scoped configurator change settings only while its scope covers every workspace canvas', async () => {
  const scoped: JevPrincipal = { ...owner, allowedCanvasIds: [canvasId] };
  expect((await runtime.configure(workspaceId, { paused: true }, scoped)).settings.paused).toBe(true);
  await store.createCanvas(workspaceId, { name: 'Beyond scope' });
  await expect(runtime.configure(workspaceId, { paused: false }, scoped)).rejects.toMatchObject({ status: 403 });
  await expect(runtime.configure('missing-workspace', { paused: false }, scoped)).rejects.toMatchObject({ status: 404 });
  expect((await runtime.read(workspaceId, owner)).settings.paused).toBe(true);
});
