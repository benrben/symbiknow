// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCanvasJourney, type CanvasPlace } from './useCanvasJourney';

beforeEach(() => window.localStorage.clear());

describe('useCanvasJourney', () => {
  it('moves backward and forward across canvases and remembers named places', () => {
    const view = renderHook(() => useCanvasJourney());
    act(() => view.result.current.visit({ canvasId: 'project', canvasName: 'project' }));
    act(() => view.result.current.updateViewport('project', { x: 12, y: 24, zoom: .5 }));
    act(() => view.result.current.visit({ canvasId: 'research', canvasName: 'Jev research', blockId: 'report', title: 'Report' }));
    expect(view.result.current.recent[0].title).toBe('Report');
    let back: CanvasPlace | undefined;
    act(() => { back = view.result.current.moveHistory(-1); });
    expect(back).toMatchObject({ canvasId: 'project', viewport: { x: 12, y: 24, zoom: .5 } });
    act(() => view.result.current.addBookmark('Current plan', view.result.current.current));
    expect(view.result.current.bookmarks[0]).toMatchObject({ name: 'Current plan', canvasId: 'project' });
    expect(window.localStorage.getItem('symbiknow:bookmarks')).toContain('Current plan');
    act(() => view.result.current.moveHistory(1));
    expect(view.result.current.current.canvasId).toBe('research');
    act(() => view.result.current.setHeaderHidden(true));
    expect(window.localStorage.getItem('symbiknow:header-hidden')).toBe('true');
  });
});
