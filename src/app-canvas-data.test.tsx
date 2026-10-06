// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument, WorkspaceSummary } from '../shared/types';
import { useAppState } from './app-state';
import { useCanvasData } from './app-canvas-data';
import { defaultSettings } from './app-state-helpers';
import { authRequiredEvent } from './api';

const planning: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [
  { id: 'evidence', title: 'Evidence', content: '', contentLoaded: false, contentVersion: 'saved-body-v1', kind: 'markdown', file: 'evidence.md', x: 0, y: 0, width: 400, height: 290, links: [] },
] };
const delivery: CanvasDocument = { ...planning, id: 'delivery', name: 'Delivery' };
const workspaces: WorkspaceSummary[] = [{ id: 'team', name: 'Team', canvases: [
  { id: planning.id, name: planning.name }, { id: delivery.id, name: delivery.name },
] }];
type Intercept = (route: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function unavailable(message: string) { return Response.json({ error: message }, { status: 503 }); }
async function settle() { await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); }); }
async function fixture(options: { list?: WorkspaceSummary[]; intercept?: Intercept } = {}) {
  const documents = new Map<string, CanvasDocument>([[planning.id, structuredClone(planning)], [delivery.id, structuredClone(delivery)]]);
  const requests: Array<{ route: string; init?: RequestInit }> = [];
  let intercept = options.intercept;
  let list = options.list ?? structuredClone(workspaces);
  vi.stubGlobal('fetch', async (route: string, init?: RequestInit) => {
    requests.push({ route, init });
    const pathname = route.split('?')[0];
    const response = intercept?.(pathname, init); if (response) return response;
    if (pathname === '/api/workspaces') return Response.json(list);
    if (pathname === '/api/settings') return Response.json(defaultSettings);
    if (pathname === '/api/session') return Response.json({ ok: true });
    const id = decodeURIComponent(pathname.replace('/api/canvases/', ''));
    const document = documents.get(id);
    return document ? Response.json(document, { headers: { ETag: `"${id}-v1"` } }) : Response.json({ error: 'Missing canvas' }, { status: 404 });
  });
  const hook = renderHook(() => { const state = useAppState(); return { state, actions: useCanvasData(state) }; });
  await settle();
  return { ...hook, requests, documents, intercept: (next?: Intercept) => { intercept = next; }, setList: (next: WorkspaceSummary[]) => { list = next; } };
}
beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, '', '/?canvas=planning'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('canvas data and connection ownership', () => {
  it('loads fresh requested canvas and reader metadata while retaining an unchanged refresh identity', async () => {
    window.history.replaceState(null, '', '/?canvas=delivery&doc=evidence');
    const { result } = await fixture();
    expect(result.current.state).toMatchObject({ loading: false, canvasId: 'delivery', canvas: delivery, readerId: 'evidence' });
    const previous = result.current.state.canvas;
    await act(async () => { await result.current.actions.refreshAfterVersionChange(); });
    expect(result.current.state.canvas).toEqual(delivery);
    expect(result.current.state.canvas).toBe(previous);
    expect(result.current.state.preferredWorkspaceId.current).toBe('team');
  });

  it('falls back for an unknown canvas and clears a missing reader from a known canvas', async () => {
    window.history.replaceState(null, '', '/?canvas=deleted&doc=evidence');
    const { result } = await fixture();
    expect(result.current.state).toMatchObject({ canvasId: 'planning', readerId: '' });
    expect(window.location.search).toBe('?canvas=planning');
    window.history.replaceState(null, '', '/?canvas=delivery&doc=removed');
    act(() => result.current.state.setCanvasId('delivery')); await settle();
    expect(result.current.state.readerId).toBe('');
  });

  it.each([{ list: [] }, { list: [{ id: 'empty', name: 'Empty', canvases: [] }] }])('starts without an available canvas for $list', async ({ list }) => {
    const { result } = await fixture({ list });
    expect(result.current.state).toMatchObject({ loading: false, canvasId: '', canvas: null });
    expect(result.current.state.preferredWorkspaceId.current).toBe(list[0]?.id ?? '');
    await act(async () => { expect(await result.current.actions.loadCanvas()).toBeNull(); });
  });

  it('exposes failed bootstrap and canvas reads and recovers using Retry', async () => {
    const { result, intercept } = await fixture({ intercept: route => route === '/api/workspaces' ? unavailable('Workspace temporarily unavailable') : undefined });
    expect(result.current.state).toMatchObject({ loading: false, error: 'Workspace temporarily unavailable', canvas: null });
    intercept(route => route === '/api/canvases/planning' ? unavailable('Canvas read unavailable') : undefined);
    act(() => result.current.actions.retryConnection()); await settle();
    expect(result.current.state.error).toBe('Canvas read unavailable');
    intercept(); act(() => result.current.actions.retryConnection()); await settle();
    expect(result.current.state).toMatchObject({ loading: false, error: '', canvas: planning });
  });

  it('ignores bootstrap completion after unmount', async () => {
    const reply = deferred<Response>();
    const { result, unmount } = await fixture({ intercept: route => route === '/api/workspaces' ? reply.promise : undefined });
    const current = result.current; unmount(); reply.resolve(Response.json(workspaces)); await settle();
    expect(result.current).toBe(current); expect(current.state.loading).toBe(true);
  });

  it('ignores bootstrap failures after unmount', async () => {
    const reply = deferred<Response>();
    const { result, unmount } = await fixture({ intercept: route => route === '/api/workspaces' ? reply.promise : undefined });
    const current = result.current; unmount(); reply.resolve(unavailable('Late bootstrap failure')); await settle();
    expect(result.current).toBe(current); expect(current.state.error).toBe('');
  });

  it('requires authentication and returns sign-in errors to the form before a successful refresh', async () => {
    const { result, intercept, requests } = await fixture();
    act(() => window.dispatchEvent(new Event(authRequiredEvent)));
    expect(result.current.state.authRequired).toBe(true);
    intercept(route => route === '/api/session' ? Response.json({ error: 'Token rejected' }, { status: 401 }) : undefined);
    await act(async () => { expect(await result.current.actions.signIn('wrong-token')).toBe('Token rejected'); });
    expect(result.current.state.authRequired).toBe(true);
    intercept(); await act(async () => { expect(await result.current.actions.signIn('workspace-token')).toBe(''); }); await settle();
    expect(result.current.state).toMatchObject({ authRequired: false, error: '', session: 1, canvas: planning });
    expect(requests.filter(request => request.route === '/api/session').at(-1)?.init).toMatchObject({ method: 'POST', body: JSON.stringify({ token: 'workspace-token' }) });
  });

  it('keeps the latest concurrent response and returns null for superseded reads', async () => {
    const { result, intercept } = await fixture(); const older = deferred<Response>();
    let reads = 0;
    intercept(route => { if (route === '/api/canvases/planning' && ++reads === 1) return older.promise; });
    let oldLoad!: Promise<CanvasDocument | null>;
    act(() => { oldLoad = result.current.actions.loadCanvas('planning'); });
    await act(async () => { await result.current.actions.loadCanvas('planning'); });
    older.resolve(Response.json({ ...planning, name: 'Stale name' }));
    await act(async () => { expect(await oldLoad).toBeNull(); });
    expect(result.current.state.canvas?.name).toBe('Planning');
    const unpublished = deferred<Response>();
    let unpublishedReads = 0;
    const document = { ...delivery, id: 'unpublished' };
    intercept(route => {
      if (route !== '/api/canvases/unpublished') return;
      return ++unpublishedReads === 1 ? unpublished.promise : Response.json({ ...document, name: 'Latest unpublished' });
    });
    act(() => { oldLoad = result.current.actions.loadCanvas('unpublished'); });
    await act(async () => { expect(await result.current.actions.loadCanvas('unpublished')).toEqual({ ...document, name: 'Latest unpublished' }); });
    unpublished.resolve(Response.json(document));
    await act(async () => { expect(await oldLoad).toBeNull(); });
    expect(result.current.state.canvas).toEqual(planning);
  });

  it('reports an unexpected bodyless conditional response rather than replacing the current canvas', async () => {
    const { result, intercept } = await fixture();
    intercept(route => route === '/api/canvases/planning' ? new Response(null, { status: 304 }) : undefined);
    const current = result.current.state.canvas;
    await act(async () => { await expect(result.current.actions.loadCanvas()).rejects.toThrow('Request failed (304)'); });
    expect(result.current.state.canvas).toBe(current);
  });

  it('requests fresh metadata on every load without conditional headers or browser caching', async () => {
    const { result, documents, requests } = await fixture();
    for (const title of ['Evidence updated once', 'Evidence updated again']) {
      documents.set('planning', { ...planning, blocks: [{ ...planning.blocks[0], title }] });
      await act(async () => { await result.current.actions.loadCanvas(); });
      expect(result.current.state.canvas?.blocks[0]).toMatchObject({ title, content: '', contentLoaded: false });
    }
    const reads = requests.filter(request => request.route.startsWith('/api/canvases/'));
    expect(reads).toHaveLength(3);
    for (const request of reads) {
      expect(request.route).toBe('/api/canvases/planning?summary=1');
      expect(request.init?.cache).toBe('no-store');
      expect(new Headers(request.init?.headers).has('If-None-Match')).toBe(false);
    }
  });

  it('keeps body reads fresh when older summary responses provide no source version', async () => {
    const { result, documents } = await fixture();
    documents.set('planning', { ...planning, blocks: [{ ...planning.blocks[0], contentVersion: undefined }] });
    await act(async () => { await result.current.actions.loadCanvas(); });
    const before = result.current.state.canvas!;
    await act(async () => { await result.current.actions.loadCanvas(); });
    expect(result.current.state.canvas?.blocks[0]).not.toBe(before.blocks[0]);
    expect(result.current.state.canvas).toEqual(before);
  });

  it('refreshes canvas details without rebuilding unchanged document nodes', async () => {
    const { result, documents } = await fixture();
    const before = result.current.state.canvas!;
    documents.set('planning', { ...planning, name: 'Planning with a fresh saved name' });
    await act(async () => { await result.current.actions.loadCanvas(); });
    expect(result.current.state.canvas?.name).toBe('Planning with a fresh saved name');
    expect(result.current.state.canvas?.blocks).toBe(before.blocks);
  });

  it('reloads server changes when returning to a previously visited canvas', async () => {
    const { result, documents } = await fixture();
    act(() => result.current.state.setCanvasId('delivery')); await settle();
    expect(result.current.state.canvas).toEqual(delivery);
    documents.set('planning', { ...planning, name: 'Planning changed while away' });
    act(() => result.current.state.setCanvasId('planning')); await settle();
    expect(result.current.state.canvas?.name).toBe('Planning changed while away');
  });

  it('loads fresh full content only for the active editor during a canvas refresh', async () => {
    const { result, intercept, requests } = await fixture();
    const edited = { ...planning.blocks[0], content: '# Fresh editor document', contentLoaded: true, contentHash: 'fresh-hash' };
    intercept(route => route === '/api/canvases/planning/blocks/evidence' ? Response.json(edited) : undefined);
    act(() => {
      result.current.state.setDraftBlock({ id: 'evidence', title: 'Evidence', kind: 'markdown', content: '# Existing draft' });
      result.current.state.setDialog('block');
    });
    await act(async () => { await result.current.actions.refreshAfterVersionChange(); });
    expect(result.current.state.canvas?.blocks[0]).toEqual(edited);
    expect(requests.at(-1)).toMatchObject({ route: '/api/canvases/planning/blocks/evidence', init: { cache: 'no-store' } });
    act(() => result.current.state.setDraftBlock({ id: 'removed', title: 'Removed', kind: 'markdown', content: '' }));
    await act(async () => { await result.current.actions.refreshAfterVersionChange(); });
    expect(result.current.state.canvas?.blocks[0]).toEqual(planning.blocks[0]);
    expect(requests.filter(request => request.route.includes('/blocks/'))).toHaveLength(1);
  });

  it('keeps inactive-canvas refreshes bodyless while an editor belongs to the current canvas', async () => {
    const { result, requests } = await fixture();
    act(() => {
      result.current.state.setDraftBlock({ id: 'evidence', title: 'Evidence', kind: 'markdown', content: '# Current draft' });
      result.current.state.setDialog('block');
    });
    await act(async () => { expect(await result.current.actions.loadCanvas('delivery')).toEqual(delivery); });
    expect(result.current.state.canvas?.id).toBe('planning');
    expect(requests.filter(request => request.route.includes('/blocks/'))).toHaveLength(0);
  });

  it('ignores superseded full-content hydration when a newer editor refresh finishes first', async () => {
    const { result, intercept } = await fixture();
    const older = deferred<Response>();
    const latest = { ...planning.blocks[0], content: '# Latest editor content', contentLoaded: true };
    let bodyReads = 0;
    intercept(route => {
      if (route !== '/api/canvases/planning/blocks/evidence') return;
      return ++bodyReads === 1 ? older.promise : Response.json(latest);
    });
    act(() => {
      result.current.state.setDraftBlock({ id: 'evidence', title: 'Evidence', kind: 'markdown', content: '' });
      result.current.state.setDialog('block');
    });
    let previous!: Promise<CanvasDocument | null>;
    act(() => { previous = result.current.actions.loadCanvas(); }); await settle();
    await act(async () => { await result.current.actions.loadCanvas(); });
    older.resolve(Response.json({ ...latest, content: '# Older editor content' }));
    await act(async () => { expect(await previous).toBeNull(); });
    expect(result.current.state.canvas?.blocks[0]).toEqual(latest);
  });

  it('refreshes workspace preferences from the server and preserves a previous preference when its canvas is absent', async () => {
    const { result, setList } = await fixture();
    await act(async () => { await result.current.actions.refreshWorkspaces('delivery'); });
    expect(result.current.state).toMatchObject({ canvasId: 'delivery', canvas: delivery });
    expect(result.current.state.preferredWorkspaceId.current).toBe('team');
    setList([]); await act(async () => { await result.current.actions.refreshWorkspaces('unknown'); });
    expect(result.current.state).toMatchObject({ canvasId: 'unknown', canvas: null });
    expect(result.current.state.preferredWorkspaceId.current).toBe('team');
  });

  it('does not publish a canvas that completed after navigation and ignores its reader and failures', async () => {
    const { result, intercept } = await fixture(); const reply = deferred<Response>();
    intercept(route => route === '/api/canvases/delivery' ? reply.promise : undefined);
    act(() => result.current.state.setCanvasId('delivery')); await settle();
    act(() => result.current.state.setCanvasId('planning')); await settle();
    reply.resolve(Response.json({ ...delivery, name: 'Old delivery' })); await settle();
    expect(result.current.state).toMatchObject({ canvasId: 'planning', canvas: planning, readerId: '', error: '' });
    const failed = deferred<Response>(); intercept(route => route === '/api/canvases/delivery' ? failed.promise : undefined);
    act(() => result.current.state.setCanvasId('delivery')); await settle();
    act(() => result.current.state.setCanvasId('planning')); await settle();
    failed.resolve(unavailable('Late read failure')); await settle();
    expect(result.current.state.error).toBe('');
  });

  it('loads cross-link labels from bodyless target metadata and tolerates missing documents', async () => {
    const { result, documents, requests } = await fixture();
    documents.set('target', { ...delivery, id: 'target', name: 'Target' });
    act(() => result.current.state.setCanvas({ ...planning, blocks: [{ ...planning.blocks[0], crossLinks: [
      { canvasId: 'delivery', blockId: 'evidence', relation: 'related' }, { canvasId: 'target', blockId: 'evidence', relation: 'related' },
      { canvasId: 'missing', blockId: 'evidence', relation: 'related' }, { canvasId: 'delivery', blockId: 'removed', relation: 'related' },
    ] }] })); await settle();
    expect(result.current.state.crossLinkLabels).toEqual({ 'delivery:evidence': 'Delivery · Evidence', 'target:evidence': 'Target · Evidence' });
    const targetReads = requests.filter(request => request.route.includes('/canvases/') && !request.route.includes('/planning'));
    expect(targetReads.map(request => request.route)).toEqual(['/api/canvases/delivery?summary=1', '/api/canvases/target?summary=1', '/api/canvases/missing?summary=1']);
    expect(targetReads.every(request => request.init?.cache === 'no-store')).toBe(true);
    expect(result.current.state.error).toBe('');
    act(() => result.current.state.setCanvas(null)); await settle(); expect(result.current.state.crossLinkLabels).toEqual({});
  });

  it('ignores cross-link label completion after the link set has changed', async () => {
    const { result, intercept } = await fixture(); const reply = deferred<Response>();
    intercept(route => route === '/api/canvases/delivery' ? reply.promise : undefined);
    act(() => result.current.state.setCanvas({ ...planning, blocks: [{ ...planning.blocks[0], crossLinks: [{ canvasId: 'delivery', blockId: 'evidence', relation: 'related' }] }] })); await settle();
    act(() => result.current.state.setCanvas(planning)); await settle(); reply.resolve(Response.json(delivery)); await settle();
    expect(result.current.state.crossLinkLabels).toEqual({});
  });

  it('polls visible idle canvases, pauses for active dialogs and recent input, and removes polling after unmount', async () => {
    vi.useFakeTimers(); const { result, requests, intercept, unmount } = await fixture();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const reads = () => requests.filter(request => request.route === '/api/canvases/planning?summary=1').length;
    const initial = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(reads()).toBe(initial + 1);
    act(() => result.current.state.setDialog('block'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(reads()).toBe(initial + 1);
    act(() => result.current.state.setDialog(null));
    act(() => window.dispatchEvent(new Event('pointerdown')));
    act(() => document.dispatchEvent(new Event('visibilitychange'))); await settle(); expect(reads()).toBe(initial + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })));
    act(() => document.dispatchEvent(new Event('visibilitychange'))); await settle(); expect(reads()).toBe(initial + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange'))); await settle(); expect(reads()).toBe(initial + 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    intercept(route => route === '/api/canvases/planning' ? unavailable('Polling unavailable') : undefined);
    act(() => document.dispatchEvent(new Event('visibilitychange'))); await settle(); expect(reads()).toBe(initial + 2);
    expect(result.current.state.error).toBe('');
    unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(reads()).toBe(initial + 2);
  });

  it('reconnects only after a successful health request and avoids overlapping checks', async () => {
    vi.useFakeTimers(); const { result, intercept, requests } = await fixture();
    const reply = deferred<Response>(); intercept(route => route === '/api/workspaces' ? reply.promise : undefined);
    act(() => result.current.state.setError('Canvas server is unavailable. Retry.'));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(requests.filter(request => request.route === '/api/workspaces')).toHaveLength(2);
    reply.resolve(new Response(null, { status: 503 })); await settle(); expect(result.current.state.session).toBe(0);
    intercept(route => route === '/api/workspaces' ? Promise.reject(new Error('Disconnected')) : undefined);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(result.current.state.session).toBe(0);
    intercept(); await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); await settle();
    expect(result.current.state).toMatchObject({ error: '', session: 1, loading: false, canvas: planning });
    const healthChecks = requests.filter(request => request.init?.cache === 'no-store' && request.route === '/api/workspaces');
    expect(healthChecks).toHaveLength(3);
  });
});
