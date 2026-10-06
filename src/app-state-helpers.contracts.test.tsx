// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import type { AnswerCanvasTurn, ResearchLayout } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';
import { authRequiredEvent, browserActor } from './api';
import { errorText, readCanvas, replaceBlock, researchStorageKey, restoredResearch, sameCanvas } from './app-state-helpers';
import { emptyResearchEdits } from './research-edits';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root?: string }> = [];
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native port');
  return `http://127.0.0.1:${address.port}`;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-state-contracts-'));
  const store = new CanvasStore(root); await store.init();
  const canvas = await store.getCanvas('product-roadmap');
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  const base = await listen(server);
  vi.stubGlobal('fetch', (route: string, init?: RequestInit) => nativeFetch(base + route, init));
  return { root, store, canvas, server, base };
}
beforeEach(() => { localStorage.clear(); vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', ''); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', ''); });
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('native document snapshots and public replacement contracts', () => {
  it('compares all saved canvas fields, document metadata and ordered blocks without replacing equivalent snapshots', async () => {
    const { canvas } = await fixture(); const copy = structuredClone(canvas);
    expect(sameCanvas(null, canvas)).toBe(false); expect(sameCanvas(canvas, copy)).toBe(true);
    for (const field of ['id', 'name', 'workspaceId'] as const) expect(sameCanvas(canvas, { ...copy, [field]: 'different' })).toBe(false);
    expect(sameCanvas(canvas, { ...copy, blocks: copy.blocks.slice(1) })).toBe(false);
    expect(sameCanvas(canvas, { ...copy, blocks: [...copy.blocks].reverse() })).toBe(false);
    const changes: Partial<CanvasBlock> = { id: 'other', title: 'Changed', file: 'other.md', kind: 'slides', x: -100, y: 600, width: 800, height: 120,
      contentHash: 'changed', purpose: 'guide', reviewer: 'Owner', group: 'custom:test', workArea: 'Test', archived: true, stale: true };
    for (const [field, value] of Object.entries(changes)) {
      expect(sameCanvas(canvas, { ...copy, blocks: copy.blocks.map((block, index) => index ? block : { ...block, [field]: value }) })).toBe(false);
    }
    const structured: Partial<CanvasBlock> = { links: ['later'], linkTypes: { later: 'related' }, crossLinks: [{ canvasId: 'other', blockId: 'later' }],
      tags: ['reviewed'], quality: { score: .7, at: '2026-10-01T00:00:00.000Z' },
      lock: { owner: 'Human', expiresAt: '2026-10-01T00:05:00.000Z' } };
    for (const [field, value] of Object.entries(structured)) {
      expect(sameCanvas(canvas, { ...copy, blocks: copy.blocks.map((block, index) => index ? block : { ...block, [field]: value }) })).toBe(false);
    }
    const legacy = { ...canvas, blocks: canvas.blocks.map(block => ({ ...block, contentHash: undefined })) };
    expect(sameCanvas(legacy, structuredClone(legacy))).toBe(true);
    expect(sameCanvas(legacy, { ...legacy, blocks: legacy.blocks.map((block, index) => index ? block : { ...block, content: '# A newer legacy file' }) })).toBe(false);
    const updated = { ...canvas.blocks[0], title: 'Replacement' };
    expect(replaceBlock(null, canvas.id, updated.id, updated)).toBeNull();
    expect(replaceBlock(canvas, 'elsewhere', updated.id, updated)).toBe(canvas);
    const replaced = replaceBlock(canvas, canvas.id, updated.id, updated)!;
    expect(replaced.blocks[0]).toBe(updated); expect(replaced.blocks[1]).toBe(canvas.blocks[1]); expect(canvas.blocks[0].title).not.toBe(updated.title);
  });
  it('shows useful native errors and a safe message for non-Error failures', () => {
    expect(errorText(new Error('Native recovery guidance'))).toBe('Native recovery guidance');
    expect(errorText(null)).toBe('Something went wrong. Please try again.');
  });
});

describe('saved research public input boundaries', () => {
  const turn: AnswerCanvasTurn = { id: -1, query: 'Retained', answer: '# Legacy evidence', sources: [], status: 'complete' };
  it.each([null, {}, { turns: {} }, { turns: null }, 'old session'])('recovers safely from %j', value => {
    localStorage.setItem(researchStorageKey, JSON.stringify(value));
    expect(restoredResearch()).toEqual({ turns: [], edits: emptyResearchEdits(), layout: 'mindmap' });
  });
  it('recovers when the key is absent, JSON is damaged, or browser storage is inaccessible', () => {
    expect(restoredResearch().turns).toEqual([]);
    localStorage.setItem(researchStorageKey, '{broken'); expect(restoredResearch().turns).toEqual([]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    expect(restoredResearch()).toEqual({ turns: [], edits: emptyResearchEdits(), layout: 'mindmap' });
  });
  it.each(['mindmap', 'roadmap', 'kanban', 'architecture', undefined, 'obsolete'])('preserves valid layout %s and falls back safely', layout => {
    localStorage.setItem(researchStorageKey, JSON.stringify({ turns: [turn, { ...turn, id: 2, status: 'stopped' }], edits: emptyResearchEdits(), layout }));
    const restored = restoredResearch(); expect(restored.turns).toEqual([turn, { ...turn, id: 2, status: 'stopped' }]);
    expect(restored.layout).toBe(['mindmap', 'roadmap', 'kanban', 'architecture'].includes(layout ?? '') ? layout as ResearchLayout : 'mindmap');
  });
  it.each([undefined, null, [], { added: {}, changed: [], deleted: {}, addedEdges: {}, deletedEdges: {} }])('keeps answers when edit containers are unusable (%j)', edits => {
    localStorage.setItem(researchStorageKey, JSON.stringify({ turns: [turn], edits }));
    expect(restoredResearch()).toEqual({ turns: [turn], edits: emptyResearchEdits(), layout: 'mindmap' });
  });
  it('preserves legacy optional metadata and rejects unsafe nested research values', () => {
    const legacy = { ...turn, id: 9007199254740992, status: undefined, sources: [{ canvasId: 'c', blockId: 'b', title: 'Legacy', excerpt: 'Evidence' }], extra: { kept: true } };
    const bad = [null, { ...turn, id: 1.5 }, { ...turn, sources: [{ canvasId: {}, blockId: 'b', title: 'Unsafe', excerpt: '' }] },
      { ...turn, patch: { query: 'Unsafe', blocks: [null], edges: [] } }, { ...turn, patch: { query: 'Unsafe', blocks: [], edges: [null] } }];
    localStorage.setItem(researchStorageKey, JSON.stringify({ turns: [legacy, ...bad], edits: emptyResearchEdits() }));
    expect(restoredResearch().turns).toEqual([JSON.parse(JSON.stringify(legacy))]);
  });
});

describe('canvas reads through actual HTTP', () => {
  it('reads native ETags, retains 304 state and reads a later native revision', async () => {
    const current = await fixture(); const first = await readCanvas(current.canvas.id);
    expect(first.document).toEqual(current.canvas); expect(first.etag).toBeTruthy();
    expect(await readCanvas(current.canvas.id, first.etag)).toEqual({ etag: first.etag });
    await current.store.updateBlock(current.canvas.id, current.canvas.blocks[0].id, { tags: ['Human'] });
    const next = await readCanvas(current.canvas.id, first.etag); expect(next.etag).not.toBe(first.etag);
    expect(next.document!.blocks[0].tags).toEqual(['Human']);
    await expect(readCanvas('missing canvas/with reserved characters')).rejects.toThrow('Invalid canvas ID');
    await expect(readCanvas('missing-canvas')).rejects.toThrow('Canvas not found');
  });
  it('dispatches authentication guidance from the native protected API and recovers on an accessible server', async () => {
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'protected-state-contract'); await fixture();
    let notifications = 0; const listener = () => { notifications++; }; window.addEventListener(authRequiredEvent, listener);
    try { await expect(readCanvas('product-roadmap')).rejects.toThrow(/access token/); expect(notifications).toBe(1); }
    finally { window.removeEventListener(authRequiredEvent, listener); }
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', ''); const repaired = await fixture();
    expect((await readCanvas(repaired.canvas.id)).document).toEqual(repaired.canvas);
  });
  it.each([{ status: 502, body: '{}' }, { status: 503, body: '{}' }, { status: 504, body: '<html>Restarting</html>' },
    { status: 500, body: '{}' }, { status: 500, body: '<html>Failure</html>' }])('shows a useful $status transport error and recovers through the actual upstream', async ({ status, body }) => {
    const current = await fixture(); let damaged = true; const actors: string[] = [];
    const proxy = createServer(async (request, response) => {
      actors.push(String(request.headers['x-symbiknow-actor']));
      if (damaged) { response.writeHead(status, { 'content-type': body.startsWith('<') ? 'text/html' : 'application/json' }); response.end(body); return; }
      const upstream = await nativeFetch(current.base + request.url); response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(await upstream.text());
    });
    opened.push({ server: proxy }); const base = await listen(proxy);
    vi.stubGlobal('fetch', (route: string, init?: RequestInit) => nativeFetch(base + route, init));
    const expected = status === 500 ? 'Request failed (500)' : `Canvas server is unavailable or restarting (${status}). Retry in a moment.`;
    await expect(readCanvas(current.canvas.id)).rejects.toThrow(expected); damaged = false;
    expect(await readCanvas(current.canvas.id)).toEqual({ document: current.canvas, etag: undefined });
    expect(actors).toEqual([browserActor, browserActor]);
  });
  it('explains a disconnected native server and recovers after restart', async () => {
    const current = await fixture(); current.server.closeAllConnections(); await new Promise<void>(resolve => current.server.close(() => resolve()));
    await expect(readCanvas(current.canvas.id)).rejects.toThrow('Canvas server is unavailable. Check that it is running, then retry.');
    const base = await listen(current.server); vi.stubGlobal('fetch', (route: string, init?: RequestInit) => nativeFetch(base + route, init));
    expect((await readCanvas(current.canvas.id)).document).toEqual(current.canvas);
  });
});
