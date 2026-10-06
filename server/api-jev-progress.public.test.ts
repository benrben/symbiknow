import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect, it } from 'vitest';
import type { JevJob } from '../shared/jev-types.js';
import { CanvasStore } from './storage.js';
import { createApiServer } from './index.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './jev/workspace.js';
import { documentActions } from './jev/runtime-document.js';

it('serves current six-action progress and scoped on-demand inspection without exposing another canvas', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-progress-api-'));
  let server: Server | undefined;
  try {
    const store = new CanvasStore(root);
    await store.init();
    const workspace = (await store.listWorkspaces())[0];
    const allowed = await store.createCanvas(workspace.id, { name: 'Allowed' });
    const denied = await store.createCanvas(workspace.id, { name: 'Denied' });
    const block = await store.createBlock(allowed.id, { title: 'Runbook', content: '# Runbook\nRecover service.' });
    const source = { workspaceId: workspace.id, canvasId: allowed.id, blockId: block.id,
      incarnation: block.incarnation!, sourceGeneration: block.sourceGeneration!,
      metadataRevision: block.metadataRevision!, contentHash: block.contentHash! };
    const state = emptyJevWorkspace();
    state.settings.paused = true;
    state.jobs.push({ id: 'progress-root', request: { action: 'profile', canvasId: allowed.id, blockIds: [block.id] },
      state: 'completed', createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:01.000Z',
      sources: [source], proposalIds: [], principal: { id: 'automation', kind: 'automation', access: 'write' },
      authorizationFingerprint: 'fixture', settingsKey: 'fixture', attempts: 1, result: { status: 'profiled' },
      documentPlan: { version: 2, originalSources: [source], completedActions: [...documentActions],
        claimPreparedAt: '2026-10-06T00:00:00.000Z', completionPreparedAt: '2026-10-06T00:00:01.000Z', queueWaitMs: 0 },
    } as JevJob);
    await new JevWorkspaceFiles(root).write(workspace.id, state);
    const { token } = await store.createMcpToken('Progress reader', 'read', { allowedCanvasIds: [allowed.id] });
    server = await createApiServer({ dataDir: root });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/jev`;
    const get = async (route: string) => {
      const response = await fetch(base + route, { headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, value: await response.json() as Record<string, unknown> };
    };
    const progress = await get(`/progress?canvasId=${allowed.id}`);
    expect(progress.status).toBe(200);
    expect(progress.value).toMatchObject({ version: 1, documents: [expect.objectContaining({
      jobId: 'progress-root', canvasId: allowed.id, blockId: block.id, durable: true,
      checkpointId: 'progress-root', actions: expect.arrayContaining([
        expect.objectContaining({ action: 'profile' }), expect.objectContaining({ action: 'suggest_home_canvas' }),
      ]),
    })] });
    expect((progress.value.documents as Array<{ actions: unknown[] }>)[0].actions).toHaveLength(6);
    expect((await get(`/progress?canvasId=${denied.id}`)).status).toBe(404);
    const inspected = await get('/inspect?jobId=progress-root&action=profile');
    expect(inspected.value).toMatchObject({ jobId: 'progress-root', action: 'profile', state: 'completed' });
    expect((await get('/inspect?jobId=missing&action=profile')).status).toBe(404);
    expect((await get('/inspect?jobId=progress-root&action=unknown')).status).toBe(400);
    expect((await get('/inspect?action=profile')).status).toBe(400);
    const workspaceProgress = await get('/progress');
    expect((workspaceProgress.value.documents as Array<{ canvasId: string }>).map(item => item.canvasId)).toEqual([allowed.id]);
    expect((await get('/state?view=jev_activity&limit=0')).status).toBe(400);
    expect((await get('/state?view=jev_activity&limit=1&cursor=-1')).status).toBe(400);
    expect((await get('/state?view=jev_activity&limit=1&cursor=0')).status).toBe(200);
    await writeFile(path.join(root, block.file), '# Runbook\nChanged service.');
    expect((await get(`/progress?canvasId=${allowed.id}`)).value.documents).toEqual([]);
    const stale = await get('/inspect?jobId=progress-root&action=profile');
    expect([404, 409]).toContain(stale.status);
    expect(stale.value).toHaveProperty('error');
    expect(stale.value).not.toHaveProperty('proposals');
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
