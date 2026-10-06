import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';
import { documentActions } from './runtime-document.js';

it('retries a stale automatic checkpoint against newly queued workspace state without losing durable corrections', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  const root = await mkdtemp(path.join(tmpdir(), 'jev-checkpoint-retry-'));
  let runtime: JevRuntime | undefined;
  try {
    const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
    const workspace = await store.createWorkspace({ name: 'Checkpoint retry' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Source' });
    const source = await store.createBlock(canvas.id, { title: 'Atlas', content: '# Atlas\nDurable source.' });
    const files = new JevWorkspaceFiles(root);
    const evaluations = vi.fn(async (_context, request: { action: string }) => {
      if (request.action === 'profile' && evaluations.mock.calls.length === 1) {
        const concurrent = await files.read(workspace.id);
        concurrent.suppressions.push('human-retained-correction');
        await files.write(workspace.id, concurrent);
      }
      return { result: { checked: request.action }, proposals: [] };
    });
    runtime = new JevRuntime(store, { startTimer: false, documentExecution: true, apiKey: 'offline-fixture-key', evaluate: evaluations });
    await runtime.idle();
    const state = await files.read(workspace.id);
    const roots = state.jobs.filter(job => job.request.action === 'profile' && job.sources.some(item => item.blockId === source.id));
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ state: 'completed', attempts: 2 });
    expect((roots[0] as typeof roots[0] & { documentPlan?: { completedActions: string[] } }).documentPlan?.completedActions)
      .toEqual(documentActions);
    expect(state.suppressions).toContain('human-retained-correction');
    expect(evaluations.mock.calls.filter(([, request]) => request.action === 'profile')).toHaveLength(2);
    expect((await store.getCanvasBlock(canvas.id, source.id)).content).toBe('# Atlas\nDurable source.');
  } finally {
    await runtime?.shutdown();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
