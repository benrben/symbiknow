import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SymbiPassage } from '../shared/symbi-contract.js';
import type { RouteContext } from './api-context.js';
import { searchAndChat } from './api-chat.js';
import { sendJson } from './api-http.js';
import { ApiError } from './errors.js';
import { CanvasStore } from './storage.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-api-search-boundary-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const workspace = (await store.listWorkspaces())[0];
  const canvas = await store.createCanvas(workspace.id, { name: 'Public search' });
  const body = await store.createBlock(canvas.id, { title: 'Runbook', content: '# Runbook\nExact rollback instructions.' });
  const title = await store.createBlock(canvas.id, { title: 'Release title', content: '# General\nOther guidance.' });
  const stale = await store.createBlock(canvas.id, { title: 'Stale rollback source', content: '# Stale\nOld procedure.' });
  const whitespace = await store.createBlock(canvas.id, { title: 'Blank passage', content: '# Blank\n   \n' });
  const privateCanvas = await store.createCanvas(workspace.id, { name: 'Private' });
  await store.createBlock(privateCanvas.id, { title: 'Private rollback', content: '# Private rollback\nRestricted.' });
  const { token } = await store.createMcpToken('Scoped search', 'read', { allowedCanvasIds: [canvas.id] });
  return { root, store, canvas, body, title, stale, whitespace, privateCanvas, token };
}

async function route(f: Awaited<ReturnType<typeof fixture>>, index?: RouteContext['symbiIndex']) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const context: RouteContext = { store: f.store, request, response, method: request.method ?? 'GET', route: url.pathname,
      url, actor: 'Scoped searcher', signal: new AbortController().signal, symbiIndex: index };
    void searchAndChat(context).then(handled => { if (!handled) sendJson(response, 404, { error: 'Route not found' }); })
      .catch(error => sendJson(response, error instanceof ApiError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error) }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return async (query: string, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/search${query}`, {
      headers: authenticated ? { authorization: `Bearer ${f.token}` } : {},
    });
    return { status: response.status, value: await response.json() as unknown };
  };
}

function passage(canvasId: string, block: { id: string; content: string; contentHash?: string }, text: string,
  hash = block.contentHash!): SymbiPassage {
  const startOffset = block.content.indexOf(text);
  return { canvasId, blockId: block.id, contentHash: hash, startOffset, endOffset: startOffset + text.length, excerpt: text };
}

it('serves exact current indexed passages, retains title matches, and rejects stale or removed sources', async () => {
  const f = await fixture();
  const expectedDocumentIds = vi.fn(async () => [f.body.id, f.title.id, f.stale.id, f.whitespace.id]);
  const search = vi.fn(async () => ({ version: 1 as const, passages: [
    passage(f.canvas.id, f.body, 'Exact rollback instructions.'),
    passage(f.canvas.id, f.title, 'Other guidance.'),
    passage(f.canvas.id, f.stale, 'Old procedure.', 'outdated-hash'),
    { canvasId: f.canvas.id, blockId: 'removed-source', contentHash: 'old', startOffset: 0, endOffset: 4, excerpt: 'gone' },
    passage(f.canvas.id, f.body, 'Exact rollback instructions.'),
  ], coverage: { status: 'ready' as const, checkedDocuments: 4, eligibleDocuments: 4, pendingDocuments: 0 } }));
  const get = await route(f, { expectedDocumentIds, search } as unknown as RouteContext['symbiIndex']);
  const response = await get('?q=Release%20title&canvasId=' + encodeURIComponent(f.canvas.id));
  expect(response.status).toBe(200);
  expect(response.value).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: f.title.id, matchIn: 'title' })]));
  expect((response.value as Array<{ blockId: string }>).map(hit => hit.blockId)).not.toContain(f.stale.id);
  expect((response.value as Array<{ blockId: string }>).map(hit => hit.blockId)).not.toContain('removed-source');
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'Release title', mode: 'hybrid',
    canvasId: f.canvas.id, allowedCanvasIds: [f.canvas.id], allowedDocumentIds: await expectedDocumentIds(),
    expectedDocumentIds: await expectedDocumentIds(), limit: 100 }));
  const bodyResponse = await get('?q=rollback%20instructions&canvasId=' + encodeURIComponent(f.canvas.id));
  expect(bodyResponse.status).toBe(200);
  expect(bodyResponse.value).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: f.body.id,
    retrieval: { kind: 'semantic', matchedTerms: [] }, evidence: expect.objectContaining({ passageKind: 'exact' }) })]));
  expect((bodyResponse.value as Array<{ blockId: string }>).filter(hit => hit.blockId === f.body.id)).toHaveLength(1);

  const blank = await route(f, { expectedDocumentIds, search: async () => ({ version: 1,
    passages: [passage(f.canvas.id, f.whitespace, '   ')],
    coverage: { status: 'ready', checkedDocuments: 1, eligibleDocuments: 1, pendingDocuments: 0 } }),
  } as unknown as RouteContext['symbiIndex']);
  expect(await blank('?q=unmatched-query')).toEqual({ status: 200, value: [] });
});

it('keeps lexical fallback scoped and reports invalid paging and unexpected source-read failures', async () => {
  const f = await fixture();
  const get = await route(f);
  const scoped = await get('?q=rollback');
  expect(scoped.status).toBe(200);
  expect((scoped.value as Array<{ canvasId: string }>).every(hit => hit.canvasId === f.canvas.id)).toBe(true);
  const unscoped = await get('?q=rollback', false);
  expect(unscoped.status).toBe(200);
  expect((unscoped.value as Array<{ canvasId: string }>).some(hit => hit.canvasId === f.privateCanvas.id)).toBe(true);
  const narrowed = await get('?q=rollback&canvasId=' + encodeURIComponent(f.canvas.id), false);
  expect((narrowed.value as Array<{ canvasId: string }>).every(hit => hit.canvasId === f.canvas.id)).toBe(true);
  const first = await get('?q=rollback&limit=1');
  expect(first.value).toMatchObject({ items: [expect.any(Object)], nextCursor: '1' });
  const page = await get('?q=rollback&limit=1&cursor=1');
  expect(page.status).toBe(200);
  expect(page.value).toMatchObject({ items: [expect.any(Object)] });
  expect(page.value).not.toHaveProperty('nextCursor');
  for (const query of ['?q=rollback&limit=0', '?q=rollback&limit=101', '?q=rollback&limit=abc',
    '?q=rollback&cursor=-1', '?q=rollback&cursor=1.5']) {
    expect(await get(query)).toMatchObject({ status: 400, value: { error: 'Invalid search pagination' } });
  }
  expect(await get('?q=rollback&canvasId=' + encodeURIComponent(f.privateCanvas.id)))
    .toEqual({ status: 200, value: [] });

  const readFailure = vi.spyOn(f.store, 'getCanvasBlock').mockRejectedValueOnce(new Error('Source disk unavailable'));
  const indexed = await route(f, { expectedDocumentIds: async () => [f.body.id],
    search: async () => ({ version: 1, passages: [passage(f.canvas.id, f.body, 'Exact rollback instructions.')],
      coverage: { status: 'ready', checkedDocuments: 1, eligibleDocuments: 1, pendingDocuments: 0 } }),
  } as unknown as RouteContext['symbiIndex']);
  expect(await indexed('?q=rollback')).toEqual({ status: 500, value: { error: 'Source disk unavailable' } });
  readFailure.mockRestore();
});

it('stops lexical fallback after forty current indexed hits while retaining the bounded response', async () => {
  const f = await fixture();
  const indexed: Array<typeof f.body> = [];
  for (let index = 0; index < 40; index++) indexed.push(await f.store.createBlock(f.canvas.id, {
    title: `Indexedbulk ${index}`, content: `# Indexedbulk ${index}\nCurrent indexed evidence ${index}.`,
  }));
  const lexicalOnly = await f.store.createBlock(f.canvas.id, { title: 'Indexedbulk lexical-only',
    content: '# Indexedbulk lexical-only\nNot in the index response.' });
  const get = await route(f, { expectedDocumentIds: async () => indexed.map(block => block.id),
    search: async () => ({ version: 1,
      passages: indexed.map(block => passage(f.canvas.id, block, `Current indexed evidence ${indexed.indexOf(block)}.`)),
      coverage: { status: 'ready', checkedDocuments: 40, eligibleDocuments: 40, pendingDocuments: 0 } }),
  } as unknown as RouteContext['symbiIndex']);
  const response = await get('?q=indexedbulk');
  expect(response.status).toBe(200);
  expect(response.value).toHaveLength(40);
  expect((response.value as Array<{ blockId: string }>).map(hit => hit.blockId)).not.toContain(lexicalOnly.id);
}, 20000);
