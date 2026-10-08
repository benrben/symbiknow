import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiServer, reportStartupFailure, start } from './index.js';

const opened: Array<{ server: Server; dataDir: string }> = [];

async function serverFixture(): Promise<{ base: string; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-routes-'));
  const server = await createApiServer({ dataDir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, dataDir });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { base: `http://127.0.0.1:${address.port}`, dataDir };
}

async function request(base: string, route: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(base + route, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

afterEach(async () => {
  for (const { server, dataDir } of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('HTTP route dispatch', () => {
  it.each(['default', 'override'] as const)('loads offline embeddings from the %s model folder and reports missing artifacts without provider calls', async mode => {
    if (mode === 'override') vi.stubEnv('SYMBI_MODEL_ROOT', path.join(os.tmpdir(), 'symbiknow-explicit-model-root-missing'));
    const { base, dataDir } = await serverFixture();
    const expectedRoot = mode === 'override' ? process.env.SYMBI_MODEL_ROOT! : path.join(dataDir, 'models');
    let result: { coverage: { status: string; reason?: string }; providerUsage: { requests: number } } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await request(base, '/api/symbi/ask', 'POST', { question: 'product roadmap', mode: 'semantic',
        canvasId: 'product-roadmap', documentIds: ['roadmap-overview'], limit: 1 });
      expect(response.status).toBe(200); result = await response.json() as typeof result;
      if (result?.coverage.reason?.includes(expectedRoot)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(result?.coverage).toMatchObject({ status: 'degraded', reason: expect.stringContaining(expectedRoot) });
    expect(result?.providerUsage.requests).toBe(0);
  });
  it('previews, switches, merges, and restores document versions through HTTP', async () => {
    const { base } = await serverFixture();
    const blockRoute = '/api/canvases/product-roadmap/blocks/roadmap-overview';
    const versions = `${blockRoute}/versions`;
    const original = await request(base, '/api/canvases/product-roadmap').then(response => response.json()) as { blocks: Array<{ content: string }> };
    const initial = await request(base, versions).then(response => response.json()) as { commits: Array<{ id: string }> };
    expect((await request(base, `${versions}/branches`, 'POST', { name: 'agents/draft' })).status).toBe(201);
    expect((await request(base, `${versions}/switch`, 'POST', { name: 'agents/draft' })).status).toBe(200);
    await request(base, blockRoute, 'PUT', { content: '# Branch draft' });
    const preview = await request(base, `${versions}/preview?kind=switch&name=main`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ before: '# Branch draft', after: original.blocks[0].content });
    expect((await request(base, `${versions}/switch`, 'POST', { name: 'main' })).status).toBe(200);
    expect((await request(base, `${versions}/preview?kind=merge&name=agents%2Fdraft`)).status).toBe(200);
    expect((await request(base, `${versions}/merge`, 'POST', { name: 'agents/draft' })).status).toBe(200);
    const merged = await request(base, '/api/canvases/product-roadmap').then(response => response.json()) as { blocks: Array<{ content: string }> };
    expect(merged.blocks[0].content).toBe('# Branch draft');
    expect((await request(base, `${versions}/preview?kind=restore&revision=${initial.commits[0].id}`)).status).toBe(200);
    expect((await request(base, `${versions}/restore`, 'POST', { revision: initial.commits[0].id })).status).toBe(200);
    const restored = await request(base, '/api/canvases/product-roadmap').then(response => response.json()) as { blocks: Array<{ content: string }> };
    expect(restored.blocks[0].content).toBe(original.blocks[0].content);
  });

  it.each([
    ['preview', 'GET', undefined], ['preview?kind=invalid', 'GET', undefined],
    ['preview?kind=switch', 'GET', undefined], ['preview?kind=restore', 'GET', undefined],
    ['branches', 'POST', {}], ['switch', 'POST', { name: 42 }], ['merge', 'POST', {}], ['restore', 'POST', { revision: 42 }],
  ])('preserves client validation for versions/%s', async (suffix, method, body) => {
    const { base } = await serverFixture();
    const response = await request(base, `/api/canvases/product-roadmap/blocks/roadmap-overview/versions/${suffix}`, method as string, body);
    expect(response.status).toBe(400);
  });



  it('keeps session login and logout public while protecting authenticated API routes', async () => {
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'workspace-secret');
    const { base } = await serverFixture();
    expect(await request(base, '/api/session').then(response => response.json())).toEqual({ authRequired: true, authenticated: false });
    expect((await request(base, '/api/workspaces')).status).toBe(401);
    expect((await request(base, '/api/session', 'POST', { token: 'wrong' })).status).toBe(401);
    const login = await request(base, '/api/session', 'POST', { token: 'workspace-secret' });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(base + '/api/workspaces', { headers: { cookie } })).status).toBe(200);
    const logout = await request(base, '/api/session', 'DELETE');
    expect(await logout.json()).toEqual({ authRequired: true, authenticated: false });
    expect(logout.headers.get('set-cookie')).toContain('symbiknow_session=;');
    expect(logout.headers.get('set-cookie')).toContain('allteam_session=;');
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
    vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
    expect(await request(base, '/api/session', 'POST', {}).then(response => response.json()))
      .toEqual({ authRequired: false, authenticated: true });
  });

  it('preserves unsupported methods and diagnostics validation after endpoint extraction', async () => {
    const { base } = await serverFixture();
    const unsupported = [
      ['/api/session', 'PUT'], ['/api/canvases/product-roadmap/tasks', 'PUT'],
      ['/api/canvases/product-roadmap/tasks/insights/apply', 'GET'],
      ['/api/canvases/product-roadmap/blocks/roadmap-overview/versions/branches', 'GET'],
      ['/api/workspaces/acme-team/automations', 'GET'],
    ];
    for (const [route, method] of unsupported) expect((await request(base, route, method)).status).toBe(404);
    expect((await request(base, '/api/models?provider=invalid')).status).toBe(400);
    expect((await request(base, '/api/mcp/servers/test', 'POST', { url: 'file:///outside' })).status).toBe(400);
    expect((await request(base, '/api/canvases/product-roadmap/tasks/insights/apply', 'POST', {})).status).toBe(404);
  });



  it('deletes a workspace through the API', async () => {
    const { base } = await serverFixture();
    const created = await request(base, '/api/workspaces', 'POST', { name: 'Temporary' });
    const workspaceId = (await created.json() as { id: string }).id;
    const canvas = await request(base, `/api/workspaces/${workspaceId}/canvases`, 'POST', { name: 'Notes' });
    const canvasId = (await canvas.json() as { id: string }).id;
    expect((await request(base, `/api/workspaces/${workspaceId}`, 'DELETE')).status).toBe(200);
    expect((await request(base, `/api/canvases/${canvasId}`)).status).toBe(404);
    expect((await request(base, `/api/workspaces/${workspaceId}`, 'DELETE')).status).toBe(404);
    expect((await request(base, '/api/workspaces').then(response => response.json()) as Array<{ id: string }>).some(item => item.id === workspaceId)).toBe(false);
  });
  it('deletes a canvas through the API and keeps the workspace usable', async () => {
    const { base } = await serverFixture();
    const workspace = (await request(base, '/api/workspaces').then(response => response.json()) as Array<{ id: string }>)[0];
    const created = await request(base, `/api/workspaces/${workspace.id}/canvases`, 'POST', { name: 'Temporary' });
    const canvasId = (await created.json() as { id: string }).id;
    expect((await request(base, `/api/canvases/${canvasId}`, 'DELETE')).status).toBe(200);
    expect((await request(base, `/api/canvases/${canvasId}`)).status).toBe(404);
    expect((await request(base, `/api/canvases/${canvasId}`, 'DELETE')).status).toBe(404);
    expect((await request(base, '/api/canvases/product-roadmap')).status).toBe(200);
    expect((await request(base, `/api/canvases/%2e%2e%2foutside`, 'DELETE')).status).toBe(400);
  });
  it('uses a canvas ETag to skip unchanged polling responses and catches external edits', async () => {
    const { base, dataDir } = await serverFixture();
    const route = '/api/canvases/product-roadmap';
    const first = await request(base, route);
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^"[a-f0-9]+"$/);
    const unchanged = await fetch(base + route, { headers: { 'if-none-match': etag! } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    await writeFile(path.join(dataDir, 'docs', 'roadmap-overview.md'), '# Externally revised roadmap');
    const changed = await fetch(base + route, { headers: { 'if-none-match': etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect((await changed.json() as { blocks: Array<{ content: string }> }).blocks.some(block =>
      block.content === '# Externally revised roadmap')).toBe(true);
  });


  it('persists manual layout changes through public routes', async () => {
    const { base } = await serverFixture();
    const layoutRoute = '/api/canvases/product-roadmap/layout';
    expect((await request(base, layoutRoute, 'PUT', { positions: [{ blockId: 'roadmap-overview', x: -120, y: 450 }] })).status).toBe(200);
    expect((await request(base, '/api/canvases/product-roadmap').then(result => result.json()) as { blocks: Array<{ id: string; x: number; y: number }> }).blocks.find(block => block.id === 'roadmap-overview')).toMatchObject({ x: -120, y: 450 });
    expect((await request(base, layoutRoute, 'PUT', { positions: [] })).status).toBe(400);
    expect((await request(base, layoutRoute)).status).toBe(404);
  });
  it('creates workspaces, canvases, and Markdown files through their routes', async () => {
    const { base } = await serverFixture();
    const workspace = await request(base, '/api/workspaces', 'POST', { name: 'Research' });
    expect(workspace.status).toBe(201);
    const workspaceId = (await workspace.json() as { id: string }).id;
    const canvas = await request(base, `/api/workspaces/${workspaceId}/canvases`, 'POST', { name: 'Ideas' });
    expect(canvas.status).toBe(201);
    const canvasId = (await canvas.json() as { id: string }).id;
    const block = await request(base, `/api/canvases/${canvasId}/blocks`, 'POST', { title: 'Notes', content: '# Notes' });
    expect(block.status).toBe(201);
    const blockId = (await block.json() as { id: string }).id;
    const changed = await request(base, `/api/canvases/${canvasId}/blocks/${blockId}`, 'PUT', { content: '# Updated' });
    expect(changed.status).toBe(200);
    const downloaded = await request(base, `/api/canvases/${canvasId}/blocks/${blockId}/download`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toContain('text/markdown');
    expect(downloaded.headers.get('content-disposition')).toContain(`${blockId}.md`);
    expect(await downloaded.text()).toBe('# Updated');
    expect((await request(base, `/api/canvases/${canvasId}/blocks/missing/download`)).status).toBe(404);
    expect((await request(base, `/api/canvases/${canvasId}`).then(response => response.json()) as { blocks: Array<{ content: string }> }).blocks[0].content).toBe('# Updated');
    expect((await request(base, '/api/search?q=Updated').then(response => response.json()) as unknown[]).length).toBe(1);
    expect(await request(base, '/api/search').then(response => response.json())).toEqual([]);
    const loaded = await request(base, `/api/canvases/${canvasId}/blocks/${blockId}`);
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toMatchObject({ id: blockId, content: '# Updated', contentLoaded: true });
    expect((await request(base, `/api/canvases/${canvasId}/blocks/${blockId}`, 'DELETE')).status).toBe(200);
    expect((await request(base, `/api/canvases/${canvasId}/blocks/${blockId}/download`)).status).toBe(404);
    expect((await request(base, `/api/canvases/${canvasId}`).then(response => response.json()) as { blocks: unknown[] }).blocks).toEqual([]);
  });

  it('validates request bodies and distinguishes app routes from unknown API routes', async () => {
    const { base } = await serverFixture();
    expect((await request(base, '/api/workspaces', 'POST', [])).status).toBe(400);
    expect((await request(base, '/api/workspaces', 'POST', 'text')).status).toBe(400);
    expect((await request(base, '/api/workspaces', 'POST', { name: 'x' })).status).toBe(201);
    expect((await fetch(base + '/api/workspaces', { method: 'POST', body: '{' })).status).toBe(415);
    expect((await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2_000_001) })).status).toBe(413);
    expect((await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{"name":"x"}' })).status).toBe(403);
    expect((await request(base, '/api/no-such-route')).status).toBe(404);
    expect((await request(base, '/', 'POST')).status).toBe(404);
    expect((await request(base, '/missing.js')).status).toBe(404);
    expect((await request(base, '/..%2f..%2fetc%2fpasswd')).status).toBe(400);
    expect((await request(base, '/nested/page')).status).toBe(200);
    expect((await request(base, '/assets')).status).toBe(200);
    const asset = (await readdir(path.resolve('dist/assets'))).find(name => name.endsWith('.css'));
    if (!asset) throw new Error('Missing built CSS asset');
    const builtAsset = await request(base, `/assets/${asset}`);
    expect(builtAsset.headers.get('content-type')).toContain('text/css');
    expect(builtAsset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const font = await request(base, '/fonts/DM-Sans.ttf');
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/ttf');
    const home = await request(base, '/');
    expect(home.status).toBe(200);
    expect(home.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves unknown static extensions with a binary content type', async () => {
    const { base } = await serverFixture();
    const asset = path.resolve('dist/probe.unknown');
    await writeFile(asset, 'probe');
    try {
      const response = await request(base, '/probe.unknown');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(await response.text()).toBe('probe');
    } finally {
      await unlink(asset);
    }
  });

  it('does not disguise a static-file read failure as a missing asset', async () => {
    const { base } = await serverFixture();
    const asset = path.resolve('dist/probe-denied.txt');
    await writeFile(asset, 'private');
    await chmod(asset, 0);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(base, '/probe-denied.txt');
      expect(response.status).toBe(500);
      expect(error).toHaveBeenCalled();
    } finally {
      await chmod(asset, 0o644);
      await unlink(asset);
    }
  });

  it('returns a stable HTTP error when workspace data disappears', async () => {
    const { base, dataDir } = await serverFixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await unlink(path.join(dataDir, 'workspaces.json'));
    const response = await request(base, '/api/workspaces');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(error).toHaveBeenCalled();
  });

  it('starts on an ephemeral port and rejects an invalid port before writing data', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-start-'));
    try {
      await expect(start(-1, dataDir)).rejects.toThrow('PORT must be a valid TCP port');
      await expect(start(Number.NaN, dataDir)).rejects.toThrow('PORT must be a valid TCP port');
      await expect(start(65536, dataDir)).rejects.toThrow('PORT must be a valid TCP port');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const server = await start(0, dataDir);
      opened.push({ server, dataDir });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('SymbiKnow API listening'));
      const address = server.address();
      expect(address).toBeTruthy();
    } finally {
      if (!opened.some(item => item.dataDir === dataDir)) await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reports startup failure and sets a failing process status', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.exitCode;
    try {
      reportStartupFailure(new Error('Address in use'));
      expect(error).toHaveBeenCalledWith(expect.any(Error));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
    }
  });
});
