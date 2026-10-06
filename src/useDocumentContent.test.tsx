// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../shared/types';
import { authRequiredEvent } from './api';
import { useDocumentContent } from './useDocumentContent';

const full: CanvasBlock = { id: 'document', title: 'Document', file: 'doc.md', kind: 'markdown', content: '# Current content', x: 0, y: 0, width: 320, height: 240, links: [] };
const summary: CanvasBlock = { ...full, content: '', contentLoaded: false };

function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('document content loading', () => {
  it('loads only selected summary content with encoded IDs, bypassing HTTP caches', async () => {
    const pending = deferred();
    const fetcher = vi.fn<typeof fetch>(() => pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const block = { ...summary, id: 'doc/?' };
    const { result } = renderHook(() => useDocumentContent(block, 'canvas /?'));
    expect(result.current).toMatchObject({ block: undefined, loading: true, error: '' });
    expect(fetcher).toHaveBeenCalledWith('/api/canvases/canvas%20%2F%3F/blocks/doc%2F%3F', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    await act(async () => { pending.resolve(Response.json({ ...full, id: block.id })); });
    expect(result.current).toMatchObject({ block: { ...full, id: block.id }, loading: false, error: '' });
  });

  it.each([undefined, true])('uses full content immediately when contentLoaded is %s', async (contentLoaded) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const block = { ...full, contentLoaded };
    const { result } = renderHook(() => useDocumentContent(block, 'canvas'));
    expect(result.current).toMatchObject({ block, loading: false, error: '' });
    act(() => { result.current.retry(); });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts a genuinely empty full document', async () => {
    const empty = { ...full, content: '' };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(empty)));
    const { result } = renderHook(() => useDocumentContent(summary, 'canvas'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.block).toEqual(empty);
    expect(result.current.error).toBe('');
  });

  it('fetches fresh content each time the reader is mounted', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(full))
      .mockResolvedValueOnce(Response.json({ ...full, content: '# Changed on disk' }));
    vi.stubGlobal('fetch', fetcher);
    const first = renderHook(() => useDocumentContent(summary, 'canvas'));
    await waitFor(() => expect(first.result.current.block).toEqual(full));
    first.unmount();
    const second = renderHook(() => useDocumentContent(summary, 'canvas'));
    await waitFor(() => expect(second.result.current.block?.content).toBe('# Changed on disk'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports a fetch failure and retries the selected document', async () => {
    const pending = deferred();
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Disconnected')).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useDocumentContent(summary, 'canvas'));
    await waitFor(() => expect(result.current.error).toContain('Canvas server is unavailable'));
    expect(result.current.loading).toBe(false);
    expect(result.current.block).toBeUndefined();
    act(() => { result.current.retry(); });
    expect(result.current).toMatchObject({ block: undefined, loading: true, error: '' });
    await act(async () => { pending.resolve(Response.json(full)); });
    expect(result.current).toMatchObject({ block: full, loading: false, error: '' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('surfaces authorization errors through the shared API helper', async () => {
    const listener = vi.fn();
    window.addEventListener(authRequiredEvent, listener);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Workspace access token required' }, { status: 401 })));
    const { result } = renderHook(() => useDocumentContent(summary, 'canvas'));
    await waitFor(() => expect(result.current.error).toBe('Workspace access token required'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.block).toBeUndefined();
    window.removeEventListener(authRequiredEvent, listener);
  });

  it('never shows loaded content from the previous canvas, even for the same document ID', async () => {
    const pending = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(full)).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const renders: ReturnType<typeof useDocumentContent>[] = [];
    const { result, rerender } = renderHook(({ canvasId }) => {
      const current = useDocumentContent(summary, canvasId);
      renders.push(current);
      return current;
    }, { initialProps: { canvasId: 'first' } });
    await waitFor(() => expect(result.current.block).toEqual(full));
    const nextRender = renders.length;
    rerender({ canvasId: 'second' });
    expect(renders[nextRender]).toMatchObject({ block: undefined, loading: true, error: '' });
    expect(fetcher).toHaveBeenLastCalledWith('/api/canvases/second/blocks/document', expect.anything());
    await act(async () => { pending.resolve(Response.json({ ...full, content: '# Second canvas' })); });
    expect(result.current.block?.content).toBe('# Second canvas');
  });

  it.each(['resolve', 'reject'] as const)('ignores an aborted navigation request that later %ss', async (completion) => {
    const first = deferred();
    const second = deferred();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetcher);
    const { result, rerender } = renderHook(({ block }) => useDocumentContent(block, 'canvas'), { initialProps: { block: summary } });
    const firstSignal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
    rerender({ block: { ...summary, id: 'second' } });
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { second.resolve(Response.json({ ...full, id: 'second', content: '# Latest' })); });
    await act(async () => {
      if (completion === 'resolve') first.resolve(Response.json(full));
      else first.reject(new Error('Old request failed'));
    });
    expect(result.current).toMatchObject({ block: { id: 'second', content: '# Latest' }, loading: false, error: '' });
  });

  it('clears prior errors immediately when navigating and reloads refreshed summaries', async () => {
    const pending = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Document unavailable' }, { status: 404 })).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(Response.json({ ...full, content: '# Refreshed' }));
    vi.stubGlobal('fetch', fetcher);
    const renders: ReturnType<typeof useDocumentContent>[] = [];
    const { result, rerender } = renderHook(({ block, canvasId }) => {
      const current = useDocumentContent(block, canvasId);
      renders.push(current);
      return current;
    }, { initialProps: { block: summary, canvasId: 'first' } });
    await waitFor(() => expect(result.current.error).toBe('Document unavailable'));
    const nextRender = renders.length;
    rerender({ block: summary, canvasId: 'second' });
    expect(renders[nextRender]).toMatchObject({ block: undefined, loading: true, error: '' });
    await act(async () => { pending.resolve(Response.json(full)); });
    rerender({ block: { ...summary }, canvasId: 'second' });
    await waitFor(() => expect(result.current.block?.content).toBe('# Refreshed'));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('aborts on unmount even when the underlying request ignores cancellation', async () => {
    const pending = deferred();
    const fetcher = vi.fn<typeof fetch>(() => pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const { unmount } = renderHook(() => useDocumentContent(summary, 'canvas'));
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(Response.json(full)); });
  });

  it('refetches when returning to a document whose earlier result remains in local state', async () => {
    const other = deferred();
    const refreshed = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(full)).mockReturnValueOnce(other.promise).mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal('fetch', fetcher);
    const { result, rerender } = renderHook(({ canvasId }) => useDocumentContent(summary, canvasId), { initialProps: { canvasId: 'first' } });
    await waitFor(() => expect(result.current.block).toEqual(full));
    rerender({ canvasId: 'other' });
    rerender({ canvasId: 'first' });
    expect(result.current).toMatchObject({ block: undefined, loading: true, error: '' });
    await act(async () => { refreshed.resolve(Response.json({ ...full, content: '# Fresh return' })); });
    expect(result.current.block?.content).toBe('# Fresh return');
    await act(async () => { other.resolve(Response.json({ ...full, content: '# Old other' })); });
    expect(result.current.block?.content).toBe('# Fresh return');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('immediately uses new full content and ignores the previous summary request', async () => {
    const pending = deferred();
    const fetcher = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const { result, rerender } = renderHook(({ block }) => useDocumentContent(block, 'canvas'), { initialProps: { block: summary } });
    rerender({ block: full });
    expect(result.current).toMatchObject({ block: full, loading: false, error: '' });
    await act(async () => { pending.resolve(Response.json({ ...full, content: '# Old pending' })); });
    expect(result.current.block).toBe(full);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shows unexpected response parsing errors', async () => {
    const response = Response.json(full);
    vi.spyOn(response, 'json').mockRejectedValueOnce('Content response could not be read');
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const { result } = renderHook(() => useDocumentContent(summary, 'canvas'));
    await waitFor(() => expect(result.current.error).toBe('Content response could not be read'));
    expect(result.current.loading).toBe(false);
  });
});
