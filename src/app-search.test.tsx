// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument, SearchHit } from '../shared/types';
import { normalizeEvidence } from '../shared/evidence';
import { useAppState } from './app-state';
import { useCanvasData } from './app-canvas-data';
import { useCanvasNavigationActions } from './app-navigation';
import { useDocumentActions } from './app-documents';
import { useCanvasSearch } from './app-search';
import { defaultSettings } from './app-state-helpers';

const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [
  { id: 'evidence', title: 'Evidence', content: '# Evidence', file: 'evidence.md', kind: 'markdown', x: 0, y: 0, width: 400, height: 290, links: [], contentHash: 'planning-hash' },
] };
const other: CanvasDocument = { ...canvas, id: 'delivery', name: 'Delivery' };
const hit: SearchHit = { canvasId: other.id, canvasName: other.name, blockId: 'evidence', title: 'Evidence', excerpt: 'Evidence', tags: [], kind: 'markdown', matchIn: 'body' };
type Intercept = (route: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function failure(message: string) { return Response.json({ error: message }, { status: 503 }); }
function summary(document: CanvasDocument): CanvasDocument {
  return { ...document, blocks: document.blocks.map(block => ({ ...block, content: '', contentHash: undefined, contentLoaded: false })) };
}
async function settle() { await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); }); }
async function fixture() {
  const requests: string[] = []; const calls: Array<{ route: string; cache: RequestCache | undefined }> = [];
  let intercept: Intercept | undefined;
  vi.stubGlobal('fetch', async (route: string, init?: RequestInit) => {
    requests.push(route); calls.push({ route, cache: init?.cache });
    const normalized = route.replace('?summary=1', '');
    const response = intercept?.(normalized, init); if (response) return response;
    if (route === '/api/workspaces') return Response.json([{ id: 'team', name: 'Team', canvases: [{ id: canvas.id, name: canvas.name }, { id: other.id, name: other.name }] }]);
    if (route === '/api/settings') return Response.json(defaultSettings);
    if (normalized === '/api/canvases/planning') return Response.json(route.includes('?summary=1') ? summary(canvas) : canvas);
    if (normalized === '/api/canvases/delivery') return Response.json(route.includes('?summary=1') ? summary(other) : other);
    if (route === '/api/canvases/planning/blocks/evidence') return Response.json(canvas.blocks[0]);
    if (route === '/api/canvases/delivery/blocks/evidence') return Response.json(other.blocks[0]);
    if (route.startsWith('/api/search')) return Response.json([hit]);
    return Response.json({ error: 'Missing' }, { status: 404 });
  });
  const hook = renderHook(() => {
    const state = useAppState(); const data = useCanvasData(state); const navigation = useCanvasNavigationActions(state);
    const documents = useDocumentActions(state, data, navigation);
    return { state, navigation, documents, actions: useCanvasSearch(state, navigation, documents) };
  });
  await settle();
  const query = async (text: string) => { act(() => hook.result.current.state.setSearchQuery(text)); await act(async () => { await vi.advanceTimersByTimeAsync(220); }); await settle(); };
  return { ...hook, requests, calls, query, intercept: (next?: Intercept) => { intercept = next; } };
}
beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); window.history.replaceState(null, '', '/?canvas=planning'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('search results and recovery', () => {
  it('debounces normalized lexical search, retries and clears an empty query', async () => {
    const { result, query, requests } = await fixture();
    act(() => result.current.state.setSearchQuery('  ship  '));
    expect(result.current.state.searching).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(219); }); expect(requests.some(route => route.startsWith('/api/search'))).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await settle();
    expect(result.current.state).toMatchObject({ searchHits: [hit], searchResultQuery: 'ship', searching: false, searchError: '' });
    expect(requests).toContain('/api/search?q=ship');
    act(() => result.current.state.setSearchRetry(value => value + 1)); await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    expect(requests.filter(route => route === '/api/search?q=ship')).toHaveLength(2);
    await query('  '); expect(result.current.state).toMatchObject({ searchHits: [], searching: false, searchResultQuery: '' });
  });

  it('uses only lexical search for a short query', async () => {
    const { query, requests } = await fixture(); await query('API');
    expect(requests.filter(route => route.startsWith('/api/search'))).toEqual(['/api/search?q=API']);
  });

  it('reports lexical failure and recovers on retry', async () => {
    const { result, query, intercept } = await fixture(); intercept(route => route.startsWith('/api/search') ? failure('Search unavailable') : undefined);
    await query('review'); expect(result.current.state).toMatchObject({ searchResultQuery: 'review', searching: false, searchError: 'Search unavailable' });
    intercept(); act(() => result.current.state.setSearchRetry(value => value + 1)); await act(async () => { await vi.advanceTimersByTimeAsync(220); }); await settle();
    expect(result.current.state).toMatchObject({ searchHits: [hit], searchError: '' });
  });

  it.each(['lexical', 'lexical failure'])('ignores an old %s after a new query', async stage => {
    const { result, query, intercept } = await fixture(); const reply = deferred<Response>();
    intercept(route => route.startsWith('/api/search?q=old') ? reply.promise : undefined);
    await query('old query'); await query('new query');
    const current = result.current.state.searchHits;
    reply.resolve(stage.includes('failure') ? failure('Old provider failure') : Response.json([{ ...hit, title: 'Old result' }])); await settle();
    expect(result.current.state).toMatchObject({ searchHits: current, searchResultQuery: 'new query', searching: false, searchError: '' });
  });

  it('cancels pending debounce work on unmount', async () => {
    const { result, requests, unmount } = await fixture(); act(() => result.current.state.setSearchQuery('review'));
    unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    expect(requests.some(route => route.startsWith('/api/search'))).toBe(false);
  });

  it('opens a fresh search result editor and preserves the request ownership when a result has been removed', async () => {
    const { result, calls } = await fixture(); act(() => result.current.state.setSearchOpen(true));
    await act(async () => { await result.current.actions.selectSearchHit(hit); });
    expect(result.current.state).toMatchObject({ canvasId: 'delivery', dialog: 'block', searchOpen: false,
      draftBlock: { id: 'evidence', title: 'Evidence', content: '# Evidence', contentHash: 'planning-hash' } });
    expect(calls).toContainEqual({ route: '/api/canvases/delivery?summary=1', cache: 'no-store' });
    expect(calls).toContainEqual({ route: '/api/canvases/delivery/blocks/evidence', cache: 'no-store' });
    act(() => result.current.state.setDialog(null));
    await act(async () => { await result.current.actions.selectSearchHit({ ...hit, blockId: 'removed' }); });
    expect(result.current.state.dialog).toBeNull();
  });

  it.each(['mismatch', 'failure'])('reports a selected result %s without opening an editor', async stage => {
    const { result, intercept } = await fixture();
    intercept(route => route === '/api/canvases/delivery' ? stage === 'mismatch' ? Response.json(canvas) : failure('Selection unavailable') : undefined);
    await act(async () => { await result.current.actions.selectSearchHit(hit); });
    expect(result.current.state.dialog).toBeNull();
    expect(result.current.state.error).toBe(stage === 'mismatch' ? 'The returned canvas does not match this search result. Search again.' : 'Selection unavailable');
  });

  it.each(['navigation', 'dialog', 'query', 'failure'])('ignores a selected result after newer %s ownership', async stage => {
    const { result, intercept, query } = await fixture(); const reply = deferred<Response>(); let first = true;
    intercept(route => { if (route === '/api/canvases/delivery' && first) { first = false; return reply.promise; } });
    let selecting!: Promise<void>; act(() => { selecting = result.current.actions.selectSearchHit(hit); });
    if (stage === 'query') await query('new query');
    else act(() => { if (stage === 'navigation') result.current.navigation.navigateTo({ canvasId: 'planning', canvasName: 'Planning' }); else result.current.documents.openNamedDialog('workspace'); });
    act(() => result.current.state.setError('Current message'));
    reply.resolve(stage === 'failure' ? failure('Old error') : Response.json(other)); await act(async () => { await selecting; });
    expect(result.current.state.dialog).toBe(stage === 'navigation' || stage === 'query' ? null : 'workspace'); expect(result.current.state.error).toBe('Current message');
  });

  it('reveals a current result and reports a removed document or failed read', async () => {
    const { result, intercept, calls, requests } = await fixture();
    await act(async () => { await result.current.actions.revealSearchHit(hit); });
    expect(result.current.state).toMatchObject({ canvasId: 'delivery', activeSearchId: 'evidence', searchOpen: false, focusRequest: { blockId: 'evidence' } });
    expect(calls).toContainEqual({ route: '/api/canvases/delivery?summary=1', cache: 'no-store' });
    expect(requests).not.toContain('/api/canvases/delivery/blocks/evidence');
    await act(async () => { await result.current.actions.revealSearchHit({ ...hit, blockId: 'removed' }); });
    expect(result.current.state.error).toBe('This document no longer exists on the canvas.');
    intercept(route => route === '/api/canvases/delivery' ? failure('Reveal unavailable') : undefined);
    await act(async () => { await result.current.actions.revealSearchHit(hit); });
    expect(result.current.state.error).toBe('Reveal unavailable');
  });

  it.each(['navigation', 'query', 'failure'])('ignores a delayed reveal after newer %s ownership', async stage => {
    const { result, intercept, query } = await fixture(); const reply = deferred<Response>();
    intercept(route => route === '/api/canvases/delivery' ? reply.promise : undefined);
    let revealing!: Promise<void>; act(() => { revealing = result.current.actions.revealSearchHit(hit); });
    if (stage === 'query') await query('new query');
    else act(() => result.current.navigation.navigateTo({ canvasId: 'planning', canvasName: 'Planning' }));
    act(() => result.current.state.setError('Current message'));
    reply.resolve(stage === 'failure' ? failure('Old reveal failure') : Response.json(other)); await act(async () => { await revealing; });
    expect(result.current.state.canvasId).toBe('planning'); expect(result.current.state.error).toBe('Current message');
    expect(result.current.state.focusRequest).toBeNull();
  });

  it('rejects a reveal response for a different canvas', async () => {
    const { result, intercept } = await fixture(); intercept(route => route === '/api/canvases/delivery' ? Response.json(canvas) : undefined);
    await act(async () => { await result.current.actions.revealSearchHit(hit); });
    expect(result.current.state.canvasId).toBe('planning'); expect(result.current.state.error).toBe('The returned canvas does not match this search result. Search again.');
  });

  it('keeps the latest reveal request when an older request finishes first', async () => {
    const { result, intercept } = await fixture(); const older = deferred<Response>(); const latest = deferred<Response>();
    intercept(route => route === '/api/canvases/delivery' ? older.promise : route === '/api/canvases/planning' ? latest.promise : undefined);
    let oldRequest!: Promise<void>; let newRequest!: Promise<void>;
    act(() => { oldRequest = result.current.actions.revealSearchHit(hit); newRequest = result.current.actions.revealSearchHit({ ...hit, canvasId: 'planning', canvasName: 'Planning' }); });
    older.resolve(Response.json(other)); await act(async () => { await oldRequest; });
    expect(result.current.state.canvasId).toBe('planning'); expect(result.current.state.focusRequest).toBeNull();
    latest.resolve(Response.json(canvas)); await act(async () => { await newRequest; });
    expect(result.current.state).toMatchObject({ canvasId: 'planning', activeSearchId: 'evidence', focusRequest: { blockId: 'evidence' } });
  });

  it('opens checked evidence and derives hashes only from the active canvas documents with a content hash', async () => {
    const { result } = await fixture();
    act(() => result.current.state.setCanvas(canvas));
    expect(result.current.actions.searchCurrentContentHashes).toEqual({ 'planning:evidence': 'planning-hash' });
    act(() => result.current.actions.openSearchEvidence(hit)); expect(result.current.state.readerId).toBe('');
    const evidence = normalizeEvidence({ claim: 'Claim', passage: 'Quoted evidence', sourceText: 'Quoted evidence', canvasId: 'delivery', documentId: 'evidence', checkedAt: '2026-10-01T00:00:00Z', contentHash: 'evidence-hash' })!;
    act(() => result.current.actions.openSearchEvidence({ ...hit, evidence }));
    expect(result.current.state).toMatchObject({ readerId: 'evidence', canvasId: 'delivery', sourceFocus: { excerpt: 'Quoted evidence', contentHash: 'evidence-hash', origin: 'Search' } });
    expect(result.current.actions.searchCurrentContentHashes).toEqual({});
    act(() => result.current.state.setCanvas({ ...other, blocks: [{ ...other.blocks[0], contentHash: undefined }] }));
    expect(result.current.actions.searchCurrentContentHashes).toEqual({});
    act(() => result.current.state.setCanvas(other));
    expect(result.current.actions.searchCurrentContentHashes).toEqual({ 'delivery:evidence': 'planning-hash' });
    act(() => result.current.state.setCanvas(null));
    expect(result.current.actions.searchCurrentContentHashes).toEqual({});
  });
});
