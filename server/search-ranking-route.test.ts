import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from './index.js';
import type { JevAnswer, JevDecider } from './jev.js';
import { automationDescriptions } from './chat-stream.js';

const opened: Array<{ server: Server; root: string }> = [];

async function fixture(decider: JevDecider): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-search-route-'));
  const server = await createApiServer({ dataDir: root, jevDecider: decider });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, root });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, route: string, body: unknown): Promise<Response> {
  return fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async ({ server, root }) => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }));
});

describe('Jev-ranked search route', () => {
  it('uses Jev only for rank=jev and keeps default substring order', async () => {
    const decider = vi.fn(async (_key, state, questions): Promise<Record<string, JevAnswer>> => {
      const hits = (state as { hits: Array<{ title: string }> }).hits;
      return Object.fromEntries(Object.keys(questions).map((id, index) => {
        const score = hits[index].title === 'Zeta needle' ? 4 : 0;
        return [id, { type: 'score', score, confidence: 1, probabilities: { [score]: 1 } }];
      }));
    }) as JevDecider & ReturnType<typeof vi.fn>;
    const base = await fixture(decider);
    expect((await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jevApiKey: 'test-key' }) })).status).toBe(200);
    for (const title of ['Alpha needle', 'Zeta needle']) {
      expect((await post(base, '/api/canvases/product-roadmap/blocks', { title, content: `# ${title}\nneedle` })).status).toBe(201);
    }
    const ordinary = await fetch(base + '/api/search?q=needle').then(response => response.json()) as Array<{ title: string }>;
    expect(ordinary.map(hit => hit.title)).toEqual(['Alpha needle', 'Zeta needle']);
    expect(decider).not.toHaveBeenCalled();

    const ranked = await fetch(base + '/api/search?q=needle&rank=jev').then(response => response.json()) as Array<{ title: string }>;
    expect(ranked.map(hit => hit.title)).toEqual(['Zeta needle', 'Alpha needle']);
    expect(decider).toHaveBeenCalledTimes(1);
    await fetch(base + '/api/search?q=needle&rank=jev');
    expect(decider).toHaveBeenCalledTimes(1);
  });

  it('rejects document targets for automation intent action values', async () => {
    const base = await fixture(async () => ({}));
    const action = automationDescriptions.purpose;
    expect((await post(base, '/api/chat/intents', { canvasId: 'product-roadmap', action,
      blockIds: ['roadmap-overview'] })).status).toBe(400);
    expect((await post(base, '/api/chat/intents', { canvasId: 'product-roadmap', action,
      blockIds: [] })).status).toBe(201);
  });

  it('dispatches task insights before task ID routes', async () => {
    const base = await fixture(async () => ({}));
    const response = await fetch(base + '/api/canvases/product-roadmap/tasks/insights');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], scores: {} });
  });
});
