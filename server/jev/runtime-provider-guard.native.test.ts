import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { JevPrincipal, JevWorkspaceState } from '../../shared/jev-types.js';
import { createApiServer } from '../index.js';
import { CanvasStore } from '../storage.js';
import { automationPrincipal } from './authorization.js';
import { JevProposalExecutor } from './proposals.js';
import { JevRuntime } from './runtime.js';
import { enqueueJevJob } from './runtime-queue.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canConfigure: true, canApprove: true };

it('keeps startup and GET reads available without automatic provider work when provider calls are disabled', async () => {
  vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '1');
  vi.stubEnv('TYPESAFE_API_KEY', 'configured-offline-fixture-key');
  const root = await mkdtemp(path.join(tmpdir(), 'jev-provider-guard-'));
  let runtime: JevRuntime | undefined;
  let server: Server | undefined;
  try {
    const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
    const workspace = await store.createWorkspace({ name: 'Guarded startup' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
    const source = await store.createBlock(canvas.id, { title: 'Atlas', content: '# Atlas\nReal fixture source text.' });
    const files = new JevWorkspaceFiles(root);
    const queued = await files.serial(workspace.id, () => enqueueJevJob(store, files,
      new JevProposalExecutor(store, files), workspace.id,
      { action: 'profile', canvasId: canvas.id, blockIds: [source.id] }, automationPrincipal));
    const evaluated = vi.fn(async () => ({ result: { status: 'evaluated' }, proposals: [] }));
    runtime = new JevRuntime(store, { startTimer: false, apiKey: 'configured-offline-fixture-key', evaluate: evaluated });
    await runtime.idle();
    await runtime.tick(); await runtime.idle();
    const state = await runtime.read(workspace.id, owner);
    expect(state.settings.externalProcessing).toBe(true);
    expect(Object.values(state.settings.modes).every(mode => mode === 'auto')).toBe(true);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({ id: queued.id, state: 'queued' });
    expect(evaluated).not.toHaveBeenCalled();
    expect((await store.getCanvasBlock(canvas.id, source.id)).content).toBe(source.content);
    await expect(runtime.recheckDocument(workspace.id, canvas.id, source.id, source.contentHash!, owner))
      .rejects.toMatchObject({ status: 503, message: 'Jev checks are paused for this app session; saved decisions remain available' });
    expect((await runtime.read(workspace.id, owner)).jobs).toHaveLength(1);
    expect(evaluated).not.toHaveBeenCalled();
    await runtime.shutdown(); runtime = undefined;

    const providerFetch = vi.fn<typeof fetch>(async () => { throw new Error('Provider calls are forbidden in this fixture'); });
    server = await createApiServer({ dataDir: root, fetcher: providerFetch });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve(); });
    });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/jev/state?summary=1`);
    expect(response.status).toBe(200);
    const read = await response.json() as JevWorkspaceState;
    expect(read.jobs).toHaveLength(1);
    expect(read.jobs[0]).toMatchObject({ id: queued.id, state: 'queued' });
    expect(read.settings.externalProcessing).toBe(true);
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    await runtime?.shutdown();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15_000);
