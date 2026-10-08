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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProjectMcpServer } from './mcp.js';

it('serves current six-action progress and scoped on-demand inspection without exposing another canvas', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-progress-api-'));
  let server: Server | undefined;
  let client: Client | undefined;
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
    const { token } = await store.createMcpToken('Progress reader', 'read', { allowedCanvasIds: [allowed.id], tools: ['jev_job', 'jev_activity'] });
    server = await createApiServer({ dataDir: root });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const api = `http://127.0.0.1:${address.port}/api`;
    const base = `${api}/canvases/${allowed.id}/jev/agent`;
    const mcp = createProjectMcpServer(api, fetch, { localFiles: false, headers: { authorization: `Bearer ${token}` } });
    client = new Client({ name: 'progress-inspector', version: '1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
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
    const jobRead = await client.callTool({ name: 'jev_job', arguments: { canvasId: allowed.id, jobId: 'progress-root' } });
    expect(jobRead.isError, JSON.stringify(jobRead)).not.toBe(true);
    expect(JSON.parse((jobRead.content as Array<{ text: string }>)[0].text)).toMatchObject({
      job: { id: 'progress-root', state: 'completed' }, progress: { jobId: 'progress-root', durable: true },
    });
    expect((await get(`/progress?canvasId=${denied.id}`)).status).toBe(403);
    const inspected = await get('/inspect?jobId=progress-root&action=profile');
    expect(inspected.value).toMatchObject({ jobId: 'progress-root', action: 'profile', state: 'completed' });
    const canonical = await client.callTool({ name: 'jev_job', arguments: { canvasId: allowed.id, jobId: 'progress-root', action: 'profile' } });
    expect(canonical.isError, JSON.stringify(canonical)).not.toBe(true);
    expect(JSON.parse((canonical.content as Array<{ text: string }>)[0].text)).toMatchObject({ jobId: 'progress-root', action: 'profile', state: 'completed' });
    expect((await client.callTool({ name: 'jev_job', arguments: { canvasId: allowed.id, jobId: 'progress-root', action: 'unknown' } })).isError).toBe(true);
    const activityOnly = await store.createMcpToken('Activity without inspection', 'read', { allowedCanvasIds: [allowed.id], tools: ['jev_activity'] });
    expect((await fetch(base + '/inspect?jobId=progress-root&action=profile', {
      headers: { authorization: `Bearer ${activityOnly.token}` },
    })).status).toBe(403);
    expect((await get('/inspect?jobId=missing&action=profile')).status).toBe(404);
    expect((await get('/inspect?jobId=progress-root&action=unknown')).status).toBe(400);
    expect((await get('/inspect?action=profile')).status).toBe(400);
    const workspaceRoute = `${api}/workspaces/${workspace.id}/jev/progress`;
    expect((await fetch(workspaceRoute, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    const workspaceProgress = await fetch(workspaceRoute).then(response => response.json()) as { documents: Array<{ canvasId: string }> };
    expect(workspaceProgress.documents.map(item => item.canvasId)).toEqual([allowed.id]);
    expect((await get('/state?view=jev_activity&limit=0')).status).toBe(400);
    expect((await get('/state?view=jev_activity&limit=1&cursor=-1')).status).toBe(400);
    expect((await get('/state?view=jev_activity&limit=1&cursor=0')).status).toBe(200);
    await writeFile(path.join(root, block.file), '# Runbook\nChanged service.');
    expect((await get(`/progress?canvasId=${allowed.id}`)).value.documents).toEqual([]);
    const historic = await client.callTool({ name: 'jev_job', arguments: { canvasId: allowed.id, jobId: 'progress-root' } });
    expect(historic.isError, JSON.stringify(historic)).not.toBe(true);
    expect(JSON.parse((historic.content as Array<{ text: string }>)[0].text)).toMatchObject({
      job: { id: 'progress-root', state: 'completed' }, progress: null,
    });
    const staleInspection = await client.callTool({ name: 'jev_job', arguments: { canvasId: allowed.id, jobId: 'progress-root', action: 'profile' } });
    expect(staleInspection.isError).toBe(true);
    const stale = await get('/inspect?jobId=progress-root&action=profile');
    expect([404, 409]).toContain(stale.status);
    expect(stale.value).toHaveProperty('error');
    expect(stale.value).not.toHaveProperty('proposals');
  } finally {
    await client?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
