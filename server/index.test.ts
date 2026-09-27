import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiServer, reportStartupFailure, start } from './index.js';
import type { JevDecider } from './jev.js';

const opened: Array<{ server: Server; dataDir: string }> = [];

async function serverFixture(jevDecider?: JevDecider): Promise<{ base: string; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-routes-'));
  const server = await createApiServer({ dataDir, jevDecider });
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
});

describe('HTTP route dispatch', () => {
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
  it('reruns Jev connection checks after a reviewed merge and offers undo', async () => {
    const asked: string[] = [];
    const decider: JevDecider = async (_key, _state, questions) => {
      asked.push(...Object.keys(questions));
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'noul'
        ? { type: 'noul', noul: 0.1 }
        : question.type === 'score' ? { type: 'score', score: 0, confidence: 1,
          probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === 0)])) }
          : { type: 'choice', choice: Object.keys(question.criteria)[0], confidence: 1,
            probabilities: Object.fromEntries(Object.keys(question.criteria).map((value, index) => [value, Number(index === 0)])) }]));
    };
    const { base } = await serverFixture(decider);
    await request(base, '/api/settings', 'PUT', { jevApiKey: 'test-key' });
    const canvas = await request(base, '/api/canvases/product-roadmap').then(response => response.json()) as {
      blocks: { id: string; contentHash: string }[];
    };
    const [keeper, old] = canvas.blocks;
    const merged = await request(base, '/api/canvases/product-roadmap/merge', 'POST', {
      keepBlockId: keeper.id, mergeBlockIds: [old.id], content: '# Combined plan',
      expectedContentHashes: { [keeper.id]: keeper.contentHash, [old.id]: old.contentHash },
    });
    expect(merged.status).toBe(200);
    const result = await merged.json() as { mergeId: string; postMerge: { status: string } };
    expect(result.postMerge.status).toBe('complete');
    expect(asked.some(id => id.includes('_link'))).toBe(true);
    expect((await request(base, `/api/merges/${result.mergeId}/undo`, 'POST')).status).toBe(200);
  });

  it('serves Jev insights and persists accepted layout changes through public routes', async () => {
    const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([name, question]) => {
      if (question.type === 'noul') return [name, { type: 'noul', noul: 0.1 }];
      if (question.type === 'score') return [name, { type: 'score', score: 0, confidence: 1, probabilities: { '0': 1 } }];
      const choice = Object.keys(question.criteria)[0];
      return [name, { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } }];
    }));
    const { base } = await serverFixture(decider);
    const route = '/api/canvases/product-roadmap/insights';
    expect((await request(base, route, 'POST', { query: 'launch' })).status).toBe(400);
    expect((await request(base, '/api/settings', 'PUT', { model: 'openai/gpt-4o-mini', jevApiKey: 'test-key', reviewers: 'Product, Engineering' })).status).toBe(200);
    expect((await request(base, route, 'POST', {})).status).toBe(400);
    expect((await request(base, route, 'POST', { query: 'x'.repeat(501) })).status).toBe(400);
    const response = await request(base, route, 'POST', { query: 'launch' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canvasId: 'product-roadmap', query: 'launch', total: 5 });
    expect((await request(base, route)).status).toBe(404);
    const layoutRoute = '/api/canvases/product-roadmap/layout';
    expect((await request(base, layoutRoute, 'PUT', { positions: [{ blockId: 'roadmap-overview', x: -120, y: 450 }] })).status).toBe(200);
    expect((await request(base, '/api/canvases/product-roadmap').then(result => result.json()) as { blocks: Array<{ id: string; x: number; y: number }> }).blocks.find(block => block.id === 'roadmap-overview')).toMatchObject({ x: -120, y: 450 });
    expect((await request(base, layoutRoute, 'PUT', { positions: [] })).status).toBe(400);
    expect((await request(base, layoutRoute)).status).toBe(404);
    const automationRoute = '/api/canvases/product-roadmap/automations';
    expect((await request(base, automationRoute, 'POST', { kind: 'unknown' })).status).toBe(400);
    const disconnected = await request(base, automationRoute, 'POST', { kind: 'connection' });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({ kind: 'connection', applied: expect.any(Number) });
    const unlinked = await request(base, '/api/canvases/product-roadmap').then(result => result.json()) as { blocks: Array<{ links: string[] }> };
    expect(unlinked.blocks.every(block => block.links.length === 0)).toBe(true);
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
    expect((await request(base, `/api/canvases/${canvasId}/blocks/${blockId}`)).status).toBe(404);
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
