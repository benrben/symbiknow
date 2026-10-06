// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';
import { useCanvasJourney } from './useCanvasJourney';

afterEach(async () => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await closeWorkspaceFixtures(); });

it('warns on the native browser storage quota while keeping navigation and bookmarks usable for the current session', async () => {
  const native = await workspaceFixture();
  localStorage.setItem('quota', 'x'.repeat(4_999_995));
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const hook = renderHook(useCanvasJourney); const source = native.canvas.blocks[0];
  const place = { canvasId: native.canvas.id, canvasName: native.canvas.name, blockId: source.id, title: source.title };
  act(() => { hook.result.current.visit(place); hook.result.current.addBookmark('Release review', place); hook.result.current.setHeaderHidden(true); });
  expect(warnings).toHaveBeenCalledWith('Canvas navigation preferences cannot be saved; they remain available for this session.');
  expect(hook.result.current.current).toEqual(place);
  expect(hook.result.current.bookmarks).toEqual([{ ...place, id: expect.any(String), name: 'Release review' }]);
  expect(hook.result.current.headerHidden).toBe(true);
  expect(localStorage.getItem('symbiknow:bookmarks')).toBeNull();
  expect(await native.reload()).toEqual(native.canvas);
});

it('recovers damaged saved navigation JSON and records repeated native views only when their viewport changes', async () => {
  const native = await workspaceFixture();
  for (const key of ['symbiknow:bookmarks', 'symbiknow:recent', 'symbiknow:header-hidden']) localStorage.setItem(key, '{ damaged browser preferences');
  const hook = renderHook(useCanvasJourney); const source = native.canvas.blocks[0];
  expect(hook.result.current.bookmarks).toEqual([]); expect(hook.result.current.recent).toEqual([]); expect(hook.result.current.headerHidden).toBe(false);
  const viewport = { x: source.x, y: source.y, zoom: .75 };
  const place = { canvasId: native.canvas.id, canvasName: native.canvas.name, blockId: source.id, title: source.title, viewport };
  act(() => hook.result.current.visit(place));
  act(() => hook.result.current.visit({ ...place }));
  act(() => hook.result.current.visit({ ...place, viewport: undefined }));
  expect(hook.result.current.journey.entries).toEqual([place]);
  const changed = { ...place, viewport: { ...viewport, x: viewport.x + 10 } };
  act(() => hook.result.current.visit(changed));
  expect(hook.result.current.journey.entries).toEqual([place, changed]);
  expect(await native.reload()).toEqual(native.canvas);
});
