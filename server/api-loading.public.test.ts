import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { createApiServer } from './index.js';
import { contentHash, type StoredCanvas } from './storage-shapes.js';
import { CanvasStore } from './storage.js';

const fixtures: Array<{ server: Server; root: string }> = [];
beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
});
afterEach(async () => {
  for (const { server, root } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-api-loading-'));
  const server = await createApiServer({ dataDir: root });
  fixtures.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native API address');
  return { base: `http://127.0.0.1:${address.port}`, root, store: new CanvasStore(root) };
}

const canvasRoute = '/api/canvases/product-roadmap';
async function denseCanvas(root: string) {
  const file = path.join(root, 'canvases', 'product-roadmap.json');
  const canvas = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
  const blocks = Array.from({ length: 600 }, (_, index) => ({ ...canvas.blocks[0],
    id: `document-${index}`, title: `Release plan ${index}`, file: `docs/document-${index}.md`,
    x: (index % 20) * 400, y: Math.floor(index / 20) * 280, width: 360, height: 240,
    links: index ? [`document-${index - 1}`] : [], group: `area:team-${index % 8}`,
    tags: ['release', `team-${index % 8}`], ...(index === 599 ? { archived: true } : {}) }));
  const saved = { ...canvas, blocks };
  await writeFile(file, JSON.stringify(saved));
  return { canvas: saved, file };
}

it('opens a 600-document canvas from fresh metadata while every Markdown body is absent', async () => {
  const { base, root } = await fixture();
  const { canvas, file } = await denseCanvas(root);
  const response = await fetch(base + canvasRoute + '?summary=1', { headers: { 'if-none-match': '"ignored"' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('etag')).toBeNull();
  const summary = await response.json() as CanvasDocument;
  expect(summary.blocks).toHaveLength(599);
  expect(summary.blocks[321]).toMatchObject({ ...canvas.blocks[321], content: '', contentLoaded: false });
  expect(summary.blocks.every(block => block.content === '' && block.contentLoaded === false && !block.contentHash)).toBe(true);
  expect(summary.blocks.some(block => block.archived)).toBe(false);
  canvas.blocks[321].title = 'Edited directly on disk';
  canvas.blocks[321].group = 'area:new-team';
  await writeFile(file, JSON.stringify({ ...canvas, name: 'Current canvas title' }));
  const fresh = await fetch(base + canvasRoute + '?summary=1');
  expect(fresh.status).toBe(200);
  expect(await fresh.json()).toMatchObject({ name: 'Current canvas title',
    blocks: expect.arrayContaining([expect.objectContaining({ id: 'document-321', title: 'Edited directly on disk', group: 'area:new-team' })]) });
});

it('keeps ordinary full canvas and conditional responses compatible and bypasses their ETag for summaries', async () => {
  const { base, store } = await fixture();
  const expected = await store.getCanvas('product-roadmap');
  for (const suffix of ['', '?summary=0', '?summary=true']) {
    const response = await fetch(base + canvasRoute + suffix);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^"[a-f0-9]+"$/);
    expect(await response.json()).toEqual(expected);
  }
  const etag = (await fetch(base + canvasRoute)).headers.get('etag')!;
  const conditional = await fetch(base + canvasRoute, { headers: { 'if-none-match': etag } });
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe('');
  const summary = await fetch(base + canvasRoute + '?summary=1', { headers: { 'if-none-match': etag } });
  expect(summary.status).toBe(200);
  expect(summary.headers.get('etag')).toBeNull();
  const payload = await summary.json() as CanvasDocument;
  expect(payload.blocks.map(block => block.id)).toEqual(expected.blocks.map(block => block.id));
  expect(payload.blocks.every(block => block.content === '' && block.contentLoaded === false)).toBe(true);
});

it('reads and downloads only the selected document among 600 entries and returns fresh outside edits', async () => {
  const { base, root } = await fixture();
  const { canvas } = await denseCanvas(root);
  const block = canvas.blocks[321];
  const bodyFile = path.join(root, block.file);
  const content = '# Selected release plan\n\n' + 'Current plan detail.\n'.repeat(5000);
  await writeFile(bodyFile, content);
  const route = `${canvasRoute}/blocks/${block.id}`;
  const response = await fetch(base + route);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('etag')).toBeNull();
  expect(await response.json()).toMatchObject({ ...block, content, contentLoaded: true, contentHash: contentHash(content) });
  const download = await fetch(base + route + '/download');
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  expect(download.headers.get('content-disposition')).toBe('attachment; filename="document-321.md"');
  expect(await download.text()).toBe(content);
  const nextContent = '# Latest release plan saved outside the app';
  await writeFile(bodyFile, nextContent);
  const changed = await fetch(base + route, { headers: { 'if-none-match': '"ignored"' } });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ content: nextContent, contentHash: contentHash(nextContent) });
  expect(await fetch(base + route + '/download').then(result => result.text())).toBe(nextContent);
});

it.each([
  ['/api/canvases/INVALID?summary=1', 400, 'Invalid canvas ID'],
  ['/api/canvases/missing-canvas?summary=1', 404, 'Canvas not found'],
  ['/api/canvases/INVALID/blocks/document-321', 400, 'Invalid canvas ID'],
  ['/api/canvases/missing-canvas/blocks/document-321', 404, 'Canvas not found'],
  [canvasRoute + '/blocks/INVALID', 400, 'Invalid block ID'],
  [canvasRoute + '/blocks/missing-document', 404, 'Document not found'],
  [canvasRoute + '/blocks/document-599', 404, 'Document not found'],
  [canvasRoute + '/blocks/document-599/download', 404, 'Document not found'],
] as const)('rejects invalid, missing or archived loading request %s', async (route, status, message) => {
  const { base, root } = await fixture();
  await denseCanvas(root);
  const response = await fetch(base + route);
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: message });
  expect((await fetch(base + canvasRoute + '?summary=1')).status).toBe(200);
});

it('surfaces a selected document read failure while the overview stays usable and recovers after the file is restored', async () => {
  const { base, root } = await fixture();
  const { canvas } = await denseCanvas(root);
  const route = `${canvasRoute}/blocks/document-321`;
  const missing = await fetch(base + route);
  expect(missing.status).toBe(500);
  expect(await missing.json()).toEqual({ error: 'Internal server error' });
  expect((await fetch(base + canvasRoute + '?summary=1')).status).toBe(200);
  const content = '# Repaired document';
  await writeFile(path.join(root, canvas.blocks[321].file), content);
  const repaired = await fetch(base + route);
  expect(repaired.status).toBe(200);
  expect(await repaired.json()).toMatchObject({ content, contentHash: contentHash(content) });
});

it('reports malformed canvas metadata and recovers on the next summary request', async () => {
  const { base, root } = await fixture();
  const { canvas, file } = await denseCanvas(root);
  await writeFile(file, '{broken');
  for (const suffix of ['?summary=1', '/blocks/document-321']) {
    const response = await fetch(base + canvasRoute + suffix);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  }
  await writeFile(file, JSON.stringify(canvas));
  const recovered = await fetch(base + canvasRoute + '?summary=1');
  expect(recovered.status).toBe(200);
  expect((await recovered.json() as CanvasDocument).blocks).toHaveLength(599);
});

it('keeps unsupported loading methods outside the document routes', async () => {
  const { base } = await fixture();
  for (const route of [canvasRoute + '?summary=1', canvasRoute + '/blocks/roadmap-overview']) {
    for (const method of ['HEAD', 'PATCH']) {
      expect((await fetch(base + route, { method })).status).toBe(404);
    }
  }
});

it('applies existing access control to summaries and individual documents and accepts a signed-in session', async () => {
  const { base, root } = await fixture();
  await denseCanvas(root);
  await writeFile(path.join(root, 'docs/document-321.md'), '# Authenticated document');
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'loading-access-test');
  const routes = [canvasRoute + '?summary=1', canvasRoute + '/blocks/document-321', canvasRoute + '/blocks/document-321/download'];
  for (const route of routes) {
    const denied = await fetch(base + route, { headers: { authorization: 'Bearer invalid' } });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'The agent token is no longer authorized' });
    expect((await fetch(base + route, { headers: { authorization: 'Bearer loading-access-test' } })).status).toBe(200);
  }
  const signedIn = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'loading-access-test' }) });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
  const response = await fetch(base + routes[1], { headers: { cookie } });
  expect(response.status).toBe(200);
  expect((await response.json() as CanvasBlock).content).toBe('# Authenticated document');
});
