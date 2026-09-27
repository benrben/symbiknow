import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { CanvasBlock, CanvasDocument, WorkspaceSummary } from '../shared/types.js';
import { createApiServer } from './index.js';

const opened: Array<{ server: Server; dataDir: string }> = [];

async function app(fetcher?: typeof fetch): Promise<{ base: string; dataDir: string; server: Server }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-server-'));
  const server = await createApiServer({ dataDir, fetcher });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, dataDir });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { base: `http://127.0.0.1:${address.port}`, dataDir, server };
}

async function json<T = unknown>(base: string, route: string, method = 'GET', body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${base}${route}`, {
    method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as T };
}

afterEach(async () => {
  for (const item of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => item.server.close(error => error ? reject(error) : resolve()));
    await rm(item.dataDir, { recursive: true, force: true });
  }
});

describe('canvas HTTP API', () => {
  it('seeds a workspace and persists Markdown blocks and canvas layout across restart', async () => {
    const { base, dataDir, server } = await app();
    const workspaces = await json<WorkspaceSummary[]>(base, '/api/workspaces');
    expect(workspaces.data[0]).toMatchObject({ id: 'acme-team', name: 'Acme Team' });
    const created = await json<CanvasBlock>(base, '/api/canvases/product-roadmap/blocks', 'POST', {
      title: 'Research notes', content: '# Research notes\nA useful finding.', x: 123, y: -45,
    });
    expect(created.status).toBe(201);
    const blockId = created.data.id;
    const moved = await json(base, `/api/canvases/product-roadmap/blocks/${blockId}`, 'PUT', {
      content: '# Research notes\nUpdated.', x: 800, links: ['roadmap-overview'],
    });
    expect(moved.data).toMatchObject({ x: 800, links: ['roadmap-overview'] });
    expect((await json(base, '/api/search?q=Updated')).data).toEqual(expect.arrayContaining([expect.objectContaining({ blockId })]));
    expect(await readFile(path.join(dataDir, `docs/${blockId}.md`), 'utf8')).toBe('# Research notes\nUpdated.');
    const layout = JSON.parse(await readFile(path.join(dataDir, 'canvases/product-roadmap.json'), 'utf8')) as { blocks: Array<{ id: string; content?: string }> };
    expect(layout.blocks.find(item => item.id === blockId)?.content).toBeUndefined();
    await new Promise<void>(resolve => server.close(() => resolve()));
    opened.splice(opened.findIndex(item => item.server === server), 1);
    const restarted = await createApiServer({ dataDir });
    await new Promise<void>(resolve => restarted.listen(0, '127.0.0.1', resolve));
    opened.push({ server: restarted, dataDir });
    const address = restarted.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const canvas = await json<CanvasDocument>(`http://127.0.0.1:${address.port}`, '/api/canvases/product-roadmap');
    expect(canvas.data.blocks.find(item => item.id === blockId)).toMatchObject({ content: '# Research notes\nUpdated.', x: 800 });
  });

  it('keeps the OpenRouter key private and stores settings with restricted permissions', async () => {
    const { base, dataDir } = await app();
    const saved = await json(base, '/api/settings', 'PUT', { model: 'openai/gpt-4.1-mini', apiKey: 'secret-key', jevApiKey: 'jev-secret', systemPrompt: 'Help the team.' });
    expect(saved.data).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-4.1-mini', systemPrompt: 'Help the team.', reviewers: '', workAreas: '', hasApiKey: true, hasJevApiKey: true });
    expect(JSON.stringify(await json(base, '/api/settings'))).not.toContain('secret-key');
    expect(JSON.stringify(await json(base, '/api/settings'))).not.toContain('jev-secret');
    expect((await stat(path.join(dataDir, 'settings.json'))).mode & 0o777).toBe(0o600);
    expect((await json(base, '/api/chat', 'POST', { canvasId: 'product-roadmap', messages: [] })).status).toBe(400);
  });

  it('runs an OpenRouter tool loop and saves the model requested edit', async () => {
    let calls = 0;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      const body = JSON.parse(String(init.body)) as { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; tool_call_id?: string }> };
      expect(body.tools.some(tool => tool.function.name === 'edit_doc')).toBe(true);
      if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'edit_doc', arguments: JSON.stringify({ blockId: 'launch-checklist', content: '# Launch checklist\n- [x] Beta tested\n' }) } }] } }] }), { status: 200 });
      expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Updated the launch checklist.' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { base } = await app(fetcher);
    await json(base, '/api/settings', 'PUT', { apiKey: 'test-key', model: 'vendor/tool-model' });
    const reply = await json(base, '/api/chat', 'POST', { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Mark beta tested.' }] });
    expect(reply).toEqual({ status: 200, data: { message: 'Updated the launch checklist.', changed: true } });
    const canvas = await json<CanvasDocument>(base, '/api/canvases/product-roadmap');
    expect(canvas.data.blocks.find(item => item.id === 'launch-checklist')?.content).toContain('[x] Beta tested');
  });

  it('validates IDs, rejects path traversal, and shows website build guidance', async () => {
    const { base } = await app();
    const home = await fetch(base);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).toContain('<html');
    expect((await json(base, '/api/canvases/invalid%2Fid')).status).toBe(400);
    expect((await json(base, '/api/canvases/product-roadmap/blocks', 'POST', { title: 'Bad', kind: 'arbitrary' })).status).toBe(400);
    const site = await fetch(`${base}/api/canvases/product-roadmap/blocks/team-docs/site`);
    expect(site.headers.get('content-type')).toContain('text/html');
    expect(await site.text()).toMatch(/Website preview unavailable|Acme Team Docs/);
    const created = await json<CanvasBlock>(base, '/api/canvases/product-roadmap/blocks', 'POST', { title: 'New website', kind: 'website', content: '# Site' });
    const missing = await fetch(`${base}/api/canvases/product-roadmap/blocks/${created.data.id}/site`);
    expect(await missing.text()).toContain('Website setup needed');
    const outside = await json<CanvasBlock>(base, '/api/canvases/product-roadmap/blocks', 'POST', {
      title: 'Outside', kind: 'website', content: '---\ngenerator: hugo\nsource: ../../\n---\n',
    });
    const blocked = await fetch(`${base}/api/canvases/product-roadmap/blocks/${outside.data.id}/site`);
    expect(await blocked.text()).toContain('inside the data directory');
  });
});
