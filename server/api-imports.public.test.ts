import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('retries an import without duplicating the ordinary file or Git revision and isolates batch errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-imports-'));
  roots.push(root);
  const server = await createApiServer({ dataDir: root });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const route = '/api/canvases/product-roadmap/imports';
  const post = async (documents: unknown[]) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documents }) });
    return { status: response.status, data: await response.json() as { results: Array<Record<string, unknown>> } };
  };
  const input = { title: 'Imported rollback note', content: '# Rollback\nKeep the old release available.',
    kind: 'markdown', idempotencyKey: 'request-1' };
  const first = await post([input]);
  expect(first.status).toBe(200);
  expect(first.data.results[0]).toMatchObject({ ok: true, processing: 'pending', contentHash: expect.any(String), revision: expect.any(String) });
  const second = await post([input, { ...input, content: '# Changed', idempotencyKey: 'request-1' },
    { ...input, title: 'Second document', idempotencyKey: 'request-2' }, { title: 'Missing key' }]);
  expect(second.data.results).toMatchObject([{ ok: true, blockId: first.data.results[0].blockId },
    { ok: false, status: 409 }, { ok: true }, { ok: false }]);
  const store = new CanvasStore(root);
  const id = String(first.data.results[0].blockId);
  const block = await store.getCanvasBlock('product-roadmap', id);
  expect(block.content).toBe(input.content);
  expect(await readFile(path.join(root, block.file), 'utf8')).toBe(input.content);
  const history = await store.documentHistory('product-roadmap', id);
  expect(history.commits).toHaveLength(2);
  expect(history.commits[0].id).toBe(first.data.results[0].revision);
  expect((await store.getCanvasSummary('product-roadmap')).blocks.filter(item => item.title === input.title)).toHaveLength(1);
});

it('rejects malformed batch envelopes and isolates invalid items before a valid ordinary-file import', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-imports-boundary-'));
  roots.push(root);
  const server = await createApiServer({ dataDir: root });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const route = `http://127.0.0.1:${address.port}/api/canvases/product-roadmap/imports`;
  const post = async (body: unknown) => {
    const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  for (const documents of [undefined, null, {}, [], Array.from({ length: 21 }, () => ({}))]) {
    const response = await post({ documents });
    expect(response.status).toBe(400);
    expect(response.data).toEqual({ error: 'documents must contain 1 to 20 imports' });
  }
  const content = '# Exact import\nKeep final newline.\n';
  const response = await post({ documents: [null, 'text', [], {}, { idempotencyKey: 42 },
    { idempotencyKey: '', title: 'Empty key' }, { idempotencyKey: 'valid-last', title: 'Valid last', content }] });
  expect(response.status).toBe(200);
  const results = response.data.results as Array<{ ok: boolean; error?: string; blockId?: string }>;
  expect(results.map(item => item.ok)).toEqual([false, false, false, false, false, false, true]);
  expect(results.slice(0, 3).map(item => item.error)).toEqual(Array(3).fill('Invalid document import'));
  expect(results.slice(3, 6).map(item => item.error)).toEqual(Array(3).fill('idempotencyKey is required'));
  const block = await new CanvasStore(root).getCanvasBlock('product-roadmap', results[6].blockId!);
  expect(await readFile(path.join(root, block.file), 'utf8')).toBe(content);
});

it('returns a per-item failure receipt for an unexpected storage error and leaves later imports available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-imports-io-'));
  roots.push(root);
  const server = await createApiServer({ dataDir: root });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const route = `http://127.0.0.1:${address.port}/api/canvases/product-roadmap/imports`;
  const create = CanvasStore.prototype.createBlock;
  const failed = vi.spyOn(CanvasStore.prototype, 'createBlock').mockImplementationOnce(async () => {
    throw new Error('Offline storage failure');
  });
  try {
    const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documents: [{ idempotencyKey: 'io-first', title: 'Interrupted', content: '# Interrupted' }] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ index: 0, ok: false, error: 'Document import failed', status: 500 }] });
  } finally { failed.mockRestore(); }
  expect(CanvasStore.prototype.createBlock).toBe(create);
  const retry = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documents: [{ idempotencyKey: 'io-first', title: 'Recovered', content: '# Recovered' }] }) });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ results: [{ index: 0, ok: true, blockId: expect.any(String) }] });
});
