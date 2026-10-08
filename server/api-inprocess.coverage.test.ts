import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore } from './storage.js';
import { createStoreApiFetcher } from './api-inprocess.js';

const roots: string[] = [];
beforeEach(() => {
  for (const key of ['SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'CANVAS_API_TOKEN', 'SYMBIKNOW_MCP_TOKEN', 'ALLTEAM_MCP_TOKEN']) vi.stubEnv(key, '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function inProcessApi() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-inprocess-api-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return createStoreApiFetcher(store);
}

describe('in-process API fetcher', () => {
  it('requires the workspace token when one is configured', async () => {
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'workspace-secret');
    const api = await inProcessApi();
    const response = await api('http://local/api/canvases/product-roadmap');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Workspace authentication is required' });
    expect((await api('http://local/api/canvases/product-roadmap', { headers: { authorization: 'Bearer workspace-secret' } })).status).toBe(200);
  });

  it('refuses writes from sandboxed documents but still serves their reads', async () => {
    const api = await inProcessApi();
    const write = await api('http://local/api/canvases/product-roadmap/blocks', { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Injected', content: '# Injected' }) });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: 'Requests from sandboxed documents are not allowed' });
    expect((await api('http://local/api/canvases/product-roadmap', { headers: { origin: 'null' } })).status).toBe(200);
  });

  it('answers unknown routes with 404 and an unchanged canvas with an empty 304', async () => {
    const api = await inProcessApi();
    const missing = await api('http://local/api/not-a-route');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Route not found' });
    const first = await api('http://local/api/canvases/product-roadmap');
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const unchanged = await api('http://local/api/canvases/product-roadmap', { headers: { 'if-none-match': etag } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('etag')).toBe(etag);
    expect(unchanged.body).toBeNull();
  });
});
