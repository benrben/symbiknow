import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const fixtures: Array<{ server: Server; root: string }> = [];
afterEach(async () => {
  for (const { server, root } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-api-documents-'));
  const server = await createApiServer({ dataDir: root });
  fixtures.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native API address');
  return { base: `http://127.0.0.1:${address.port}`, root, store: new CanvasStore(root) };
}

function request(base: string, route: string, method = 'GET', input?: unknown, headers: Record<string, string> = {}) {
  return fetch(base + route, { method, headers: { ...headers, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
    body: input === undefined ? undefined : JSON.stringify(input) });
}

it.each(['POST', 'PUT', 'PATCH'])('rejects unsupported canvas %s requests without changing persisted documents or revision evidence', async method => {
  const { base, root, store } = await fixture();
  const canvasId = 'product-roadmap';
  const route = `/api/canvases/${canvasId}`;
  const before = await store.getCanvas(canvasId);
  const file = path.join(root, 'canvases', canvasId + '.json');
  const saved = await readFile(file, 'utf8');
  const etag = (await request(base, route)).headers.get('etag');
  const rejected = await request(base, route, method, { name: 'Unreviewed rename', blocks: [] });
  expect(rejected.status).toBe(404);
  expect(await rejected.json()).toEqual({ error: 'Route not found' });
  expect(await readFile(file, 'utf8')).toBe(saved);
  expect(await new CanvasStore(root).getCanvas(canvasId)).toEqual(before);
  const read = await request(base, route);
  expect(read.status).toBe(200);
  expect(read.headers.get('etag')).toBe(etag);
});

it('returns an empty conditional 304 with the same ETag and detects an outside Markdown edit through HTTP and a fresh store', async () => {
  const { base, root, store } = await fixture();
  const route = '/api/canvases/product-roadmap';
  const first = await request(base, route);
  const before = await first.json() as CanvasDocument;
  const etag = first.headers.get('etag')!;
  expect(etag).toMatch(/^"[a-f0-9]+"$/);
  const unchanged = await request(base, route, 'GET', undefined, { 'if-none-match': etag });
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get('etag')).toBe(etag);
  expect(unchanged.headers.get('cache-control')).toBe('no-store');
  expect(unchanged.headers.get('content-type')).toBeNull();
  expect(unchanged.headers.get('content-length')).toBeNull();
  expect(await unchanged.text()).toBe('');
  const block = before.blocks[0];
  await writeFile(path.join(root, block.file), '# Native outside edit');
  const changed = await request(base, route, 'GET', undefined, { 'if-none-match': etag });
  expect(changed.status).toBe(200);
  const next = changed.headers.get('etag')!;
  expect(next).not.toBe(etag);
  expect((await changed.json() as CanvasDocument).blocks.find(item => item.id === block.id)?.content).toBe('# Native outside edit');
  expect((await new CanvasStore(root).getCanvas('product-roadmap')).blocks.find(item => item.id === block.id)?.content).toBe('# Native outside edit');
  expect(await store.getCanvasRevision('product-roadmap')).toBe(next);
  const cached = await request(base, route, 'GET', undefined, { 'if-none-match': next });
  expect(cached.status).toBe(304);
  expect(await cached.text()).toBe('');
});

it.each([undefined, {}, { targetCanvasId: null }, { targetCanvasId: 42 }])
  ('refuses a missing or malformed move destination %j before writes and retries a real move with task context intact', async input => {
    const { base, root, store } = await fixture();
    const canvasId = 'product-roadmap';
    const target = await store.createCanvas('acme-team', { name: 'Move destination' });
    const block = await store.createBlock(canvasId, { title: 'Move proof', content: '# Stable native source' });
    const task = await store.createTask(canvasId, { title: 'Follow document', blockIds: [block.id] }, 'Task owner');
    const file = path.join(root, 'canvases', canvasId + '.json');
    const targetFile = path.join(root, 'canvases', target.id + '.json');
    const before = await readFile(file, 'utf8');
    const destination = await readFile(targetFile, 'utf8');
    const history = await store.documentHistory(canvasId, block.id);
    const route = `/api/canvases/${canvasId}/blocks/${block.id}/move`;
    const failed = await request(base, route, 'POST', input);
    expect(failed.status).toBe(input === undefined ? 415 : 400);
    expect(await failed.json()).toEqual({ error: input === undefined ? 'Send the request body as application/json' : 'targetCanvasId is required' });
    if (input === undefined) {
      const emptyJson = await request(base, route, 'POST', undefined, { 'content-type': 'application/json' });
      expect(emptyJson.status).toBe(400);
      expect(await emptyJson.json()).toEqual({ error: 'Expected a JSON object' });
    }
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readFile(targetFile, 'utf8')).toBe(destination);
    expect(await readFile(path.join(root, block.file), 'utf8')).toBe(block.content);
    expect(await store.listTasks(canvasId)).toEqual([task]);
    expect(await store.documentHistory(canvasId, block.id)).toEqual(history);
    const retried = await request(base, route, 'POST', { targetCanvasId: target.id }, { 'x-symbiknow-actor': 'Move reviewer' });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ fromCanvasId: canvasId, toCanvasId: target.id, blockId: block.id });
    const fresh = new CanvasStore(root);
    await fresh.init();
    expect((await fresh.getCanvas(canvasId)).blocks.some(item => item.id === block.id)).toBe(false);
    expect((await fresh.getCanvas(target.id)).blocks[0]).toMatchObject({ id: block.id, content: block.content, file: block.file });
    expect(await fresh.documentHistory(target.id, block.id)).toEqual(history);
    expect((await fresh.listTasks(canvasId))[0]).toMatchObject({ id: task.id, blockIds: [] });
    expect((await fresh.listTasks(target.id))[0]).toMatchObject({ title: task.title, blockIds: [block.id], createdBy: 'Move reviewer' });
  });

it('does not dispatch unsupported move methods and remains usable after an absent target canvas is corrected', async () => {
  const { base, root, store } = await fixture();
  const canvasId = 'product-roadmap';
  const block = await store.createBlock(canvasId, { title: 'Reviewed move' });
  const route = `/api/canvases/${canvasId}/blocks/${block.id}/move`;
  const file = path.join(root, 'canvases', canvasId + '.json');
  const before = await readFile(file, 'utf8');
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await request(base, route, method);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Route not found' });
  }
  const missing = await request(base, route, 'POST', { targetCanvasId: 'missing-destination' });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'Canvas not found' });
  expect(await readFile(file, 'utf8')).toBe(before);
  const target = await store.createCanvas('acme-team', { name: 'Repaired destination' });
  expect((await request(base, route, 'POST', { targetCanvasId: target.id })).status).toBe(200);
  expect((await new CanvasStore(root).getCanvas(target.id)).blocks[0].id).toBe(block.id);
});

it('serves native document downloads and website setup responses with the existing redirects, headers and method boundaries', async () => {
  const { base, store } = await fixture();
  const block = await store.createBlock('product-roadmap', { title: 'Download source', content: '# Complete native document' });
  const route = `/api/canvases/product-roadmap/blocks/${block.id}/download`;
  const download = await request(base, route);
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${path.basename(block.file)}"`);
  expect(download.headers.get('cache-control')).toBe('no-store');
  expect(download.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await download.text()).toBe(block.content);
  expect((await request(base, route, 'POST')).status).toBe(404);
  expect((await request(base, '/api/canvases/product-roadmap/blocks/missing-document/download')).status).toBe(404);
  const website = await store.createBlock('product-roadmap', { title: 'Unconfigured website', kind: 'website', content: '# Website source' });
  const site = `/api/canvases/product-roadmap/blocks/${website.id}/site`;
  const redirect = await fetch(base + site, { redirect: 'manual' });
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get('location')).toBe(site + '/');
  expect(await redirect.text()).toBe('');
  for (const suffix of ['/', '/?static=1', '/guide/']) {
    const response = await request(base, site + suffix);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain('Website setup needed');
  }
  expect((await request(base, site + '/', 'POST')).status).toBe(404);
  const document = await request(base, `/api/canvases/product-roadmap/blocks/${block.id}`, 'GET');
  expect(document.status).toBe(200);
  expect(await document.json()).toMatchObject({ id: block.id, content: block.content, file: block.file });
  const downloaded = await request(base, route);
  expect(await downloaded.text()).toBe(block.content);
  const untouched = await request(base, '/api/canvases/product-roadmap').then(response => response.json()) as { blocks: CanvasBlock[] };
  expect(untouched.blocks.find(item => item.id === block.id)?.content).toBe(block.content);
});

it('pages both metadata and complete ordinary-file canvases with guarded limits and stable source content', async () => {
  const { base, root, store } = await fixture();
  const route = '/api/canvases/product-roadmap';
  const added = await store.createBlock('product-roadmap', { title: 'Exact source', content: '# Exact source\nKeep the final newline.\n' });
  const summary = await request(base, `${route}?includeContent=false&limit=1`);
  expect(summary.status).toBe(200);
  const first = await summary.json() as CanvasDocument & { nextCursor?: string; totalBlocks: number };
  expect(first).toMatchObject({ totalBlocks: expect.any(Number), nextCursor: '1', blocks: [expect.objectContaining({ content: '' })] });
  const later = await request(base, `${route}?includeContent=false&cursor=1`);
  expect(later.status).toBe(200);
  const laterPage = await later.json() as typeof first;
  expect(laterPage.blocks.some(block => block.id === added.id)).toBe(true);
  expect(laterPage.blocks.find(block => block.id === added.id)?.content).toBe('');
  const compact = await request(base, `${route}?summary=1`);
  expect(compact.status).toBe(200);
  expect((await compact.json() as { blocks: Array<{ id: string }> }).blocks.some(block => block.id === added.id)).toBe(true);
  const full = await request(base, route);
  const etag = full.headers.get('etag')!;
  expect((await request(base, `${route}?limit=1`, 'GET', undefined, { 'if-none-match': etag })).status).toBe(200);
  const complete = await request(base, `${route}?limit=1&cursor=${first.totalBlocks - 1}`);
  expect(complete.status).toBe(200);
  expect(await complete.json()).toMatchObject({ totalBlocks: first.totalBlocks,
    blocks: [expect.objectContaining({ id: added.id, content: added.content })] });
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=bad', 'cursor=-1', 'cursor=1.5', 'cursor=bad']) {
    const invalid = await request(base, `${route}?${query}`);
    expect(invalid.status, query).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Invalid canvas pagination' });
  }
  expect(await readFile(path.join(root, added.file), 'utf8')).toBe(added.content);
});

it('validates link changes before mutation and preserves concurrent source bytes while acknowledging links', async () => {
  const { base, root, store } = await fixture();
  const from = await store.createBlock('product-roadmap', { title: 'Origin', content: '# Origin\nUnchanged source.\n' });
  const to = await store.createBlock('product-roadmap', { title: 'Target', content: '# Target\nUnchanged source.\n' });
  const route = '/api/canvases/product-roadmap/links';
  for (const input of [{}, { fromBlockId: from.id, toBlockId: to.id, action: 'unknown' },
    { fromBlockId: 42, toBlockId: to.id, action: 'link' }, { fromBlockId: from.id, toBlockId: null, action: 'link' }]) {
    const invalid = await request(base, route, 'POST', input);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Invalid link change' });
  }
  const linked = await request(base, route, 'POST', { fromBlockId: from.id, toBlockId: to.id, action: 'link' });
  expect(linked.status).toBe(200);
  expect(await linked.json()).toMatchObject({ fromBlockId: from.id, toBlockId: to.id, links: [to.id],
    metadataRevision: expect.any(Number) });
  const unlinked = await request(base, route, 'POST', { fromBlockId: from.id, toBlockId: to.id, action: 'unlink' });
  expect(unlinked.status).toBe(200);
  expect(await unlinked.json()).toMatchObject({ fromBlockId: from.id, toBlockId: to.id, links: [] });
  expect(await readFile(path.join(root, from.file), 'utf8')).toBe(from.content);
  expect(await readFile(path.join(root, to.file), 'utf8')).toBe(to.content);
  expect((await new CanvasStore(root).getCanvasBlock('product-roadmap', from.id)).links).toEqual([]);
});

it('validates version cursors and returns revision pages without affecting the visible source', async () => {
  const { base, root, store } = await fixture();
  const block = await store.createBlock('product-roadmap', { title: 'History source', content: '# Initial\n' });
  const route = `/api/canvases/product-roadmap/blocks/${block.id}/versions`;
  const before = await readFile(path.join(root, block.file), 'utf8');
  const first = await request(base, `${route}?limit=1`);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ commits: [expect.objectContaining({ id: expect.any(String) })],
    nextCursor: '1' });
  const after = await request(base, `${route}?cursor=1`);
  expect(after.status).toBe(200);
  expect((await after.json() as { commits: unknown[] }).commits.length).toBeGreaterThan(0);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=-1', 'cursor=bad']) {
    const invalid = await request(base, `${route}?${query}`);
    expect(invalid.status, query).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Invalid version pagination' });
  }
  expect(await readFile(path.join(root, block.file), 'utf8')).toBe(before);
});

it('returns the current hash for a stale source edit and keeps the ordinary file until a guarded delete succeeds', async () => {
  const { base, root, store } = await fixture();
  const block = await store.createBlock('product-roadmap', { title: 'Guarded source', content: '# Guarded source\nOriginal bytes.\n' });
  const route = `/api/canvases/product-roadmap/blocks/${block.id}`;
  const stale = await request(base, route, 'PUT', { content: '# Blind change\n', expectedContentHash: 'outdated-hash' });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ currentContentHash: block.contentHash });
  expect(await readFile(path.join(root, block.file), 'utf8')).toBe(block.content);
  const valid = await request(base, route, 'PUT', { content: '# Reviewed change\nRetain newline.\n',
    expectedContentHash: block.contentHash });
  expect(valid.status).toBe(200);
  const changed = await valid.json() as CanvasBlock;
  expect(await readFile(path.join(root, block.file), 'utf8')).toBe(changed.content);
  const rejectedDelete = await request(base, route, 'DELETE', { expectedContentHash: block.contentHash });
  expect(rejectedDelete.status).toBe(409);
  expect(await readFile(path.join(root, block.file), 'utf8')).toBe(changed.content);
  const deleted = await request(base, route, 'DELETE', { expectedContentHash: changed.contentHash });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ ok: true });
  expect((await request(base, route)).status).toBe(404);
});
