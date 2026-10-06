import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { createApiServer } from './index.js';

const opened: Array<{ server: Server; root: string }> = [];
async function app() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-coordination-'));
  const server = await createApiServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, root });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}
async function call<T>(base: string, route: string, method = 'GET', body?: unknown, actor = 'Reviewer') {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-symbiknow-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as T };
}
afterEach(async () => {
  for (const { server, root } of opened.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('public coordination HTTP requests', () => {
  it('rejects a conflicting edit, transfers the lease, and permits retry after release', async () => {
    const base = await app(); const doc = '/api/canvases/product-roadmap/blocks/launch-checklist';
    expect((await call(base, `${doc}/lock`, 'POST', { ttlSeconds: 29 }, 'Owner')).status).toBe(400);
    expect((await call(base, `${doc}/lock`, 'POST', { ttlSeconds: 30, note: 'Reviewing' }, 'Owner')).status).toBe(200);
    expect((await call(base, `${doc}/lock`, 'POST', {}, 'Other')).status).toBe(409);
    expect((await call(base, doc, 'PUT', { content: '# Conflicting draft' }, 'Other')).status).toBe(423);
    const takeover = await call<{ owner: string }>(base, `${doc}/lock`, 'POST', { force: true }, 'Other');
    expect(takeover.status).toBe(200); expect(takeover.data.owner).toBe('Other');
    expect((await call(base, `${doc}/lock`, 'DELETE', undefined, 'Owner')).status).toBe(409);
    expect((await call(base, `${doc}/lock?force`, 'DELETE', undefined, 'Owner')).status).toBe(200);
    const retried = await call<CanvasBlock>(base, doc, 'PUT', { content: '# Accepted retry' }, 'Reviewer');
    expect(retried.status).toBe(200);
    const saved = (await call<CanvasDocument>(base, '/api/canvases/product-roadmap')).data;
    expect(saved.blocks.find(block => block.id === 'launch-checklist')).toMatchObject({ content: '# Accepted retry' });
  });
});
