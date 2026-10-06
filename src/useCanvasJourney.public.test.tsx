// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCanvasJourney, type CanvasPlace } from './useCanvasJourney';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';

afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await closeWorkspaceFixtures();
});

it('records viewport changes in the current saved place without replacing the neighboring native document', async () => {
  const fixture = await workspaceFixture();
  const { result } = renderHook(useCanvasJourney);
  const [first, second] = fixture.canvas.blocks;
  const place: CanvasPlace = { canvasId: fixture.canvas.id, canvasName: fixture.canvas.name, blockId: first.id, title: first.title };
  const viewport = { x: first.x, y: first.y, zoom: .75 };
  act(() => { expect(result.current.moveHistory(-1)).toBeUndefined(); expect(result.current.moveHistory(1)).toBeUndefined(); });
  act(() => result.current.updateViewport(fixture.canvas.id, viewport));
  expect(result.current.current).toBeUndefined();
  act(() => result.current.visit(place));
  act(() => result.current.updateViewport(fixture.secondCanvas.id, viewport));
  expect(result.current.current).toEqual(place);
  for (const next of [viewport, { ...viewport }, { ...viewport, x: viewport.x + 5 },
    { ...viewport, x: viewport.x + 5, y: viewport.y + 7 }, { ...viewport, x: viewport.x + 5, y: viewport.y + 7, zoom: .5 }]) {
    act(() => result.current.updateViewport(fixture.canvas.id, next));
    expect(result.current.current).toEqual({ ...place, viewport: next });
    expect(result.current.journey.entries).toHaveLength(1);
  }
  const savedFirst = result.current.current;
  const other = { ...place, blockId: second.id, title: second.title, viewport: { x: 22, y: 33, zoom: 1 } };
  act(() => result.current.visit(other));
  act(() => { expect(result.current.moveHistory(-1)).toEqual(savedFirst); });
  act(() => result.current.updateViewport(fixture.canvas.id, { x: 45, y: 56, zoom: .6 }));
  expect(result.current.journey.entries[1]).toEqual(other);
  act(() => { expect(result.current.moveHistory(1)).toEqual(other); });
  expect(result.current.current).toEqual(other);
  expect(await fixture.reload()).toEqual(fixture.canvas);
});

it('ignores a late viewport when forgetting saved places and a retained history callback leave no current place', async () => {
  const fixture = await workspaceFixture();
  const { result } = renderHook(useCanvasJourney);
  act(() => result.current.visit({ canvasId: fixture.canvas.id, canvasName: fixture.canvas.name }));
  act(() => result.current.visit({ canvasId: fixture.secondCanvas.id, canvasName: fixture.secondCanvas.name }));
  const previousHistory = result.current.moveHistory;
  act(() => {
    result.current.forgetCanvas(fixture.canvas.id);
    result.current.forgetCanvas(fixture.secondCanvas.id);
    previousHistory(-1);
  });
  expect(result.current.current).toBeUndefined();
  act(() => result.current.updateViewport(fixture.canvas.id, { x: 99, y: 88, zoom: 1 }));
  expect(result.current.current).toBeUndefined(); expect(result.current.journey.entries).toEqual([]);
  expect(await fixture.reload()).toEqual(fixture.canvas);
});

it('rejects blank bookmark names through the public journey action and restores a trimmed saved native document', async () => {
  const fixture = await workspaceFixture();
  const first = fixture.canvas.blocks[0];
  const place: CanvasPlace = { canvasId: fixture.canvas.id, canvasName: fixture.canvas.name, blockId: first.id,
    title: first.title, viewport: { x: first.x, y: first.y, zoom: .75 } };
  const hook = renderHook(useCanvasJourney);
  act(() => { hook.result.current.addBookmark('', place); hook.result.current.addBookmark('   ', place); });
  expect(hook.result.current.bookmarks).toEqual([]);
  expect(JSON.parse(localStorage.getItem('symbiknow:bookmarks')!)).toEqual([]);
  act(() => hook.result.current.addBookmark('  Saved native view  ', place));
  const saved = hook.result.current.bookmarks;
  expect(saved).toEqual([{ ...place, id: expect.any(String), name: 'Saved native view' }]);
  hook.unmount(); const restored = renderHook(useCanvasJourney);
  expect(restored.result.current.bookmarks).toEqual(saved);
  act(() => restored.result.current.removeBookmark(saved[0].id));
  expect(JSON.parse(localStorage.getItem('symbiknow:bookmarks')!)).toEqual([]);
  act(() => { restored.result.current.visit(place); restored.result.current.addBookmark('Forget this place', place); });
  expect(restored.result.current.recent).toEqual([place]);
  act(() => restored.result.current.forgetCanvas(fixture.canvas.id));
  expect(restored.result.current.bookmarks).toEqual([]); expect(restored.result.current.recent).toEqual([]);
  expect(JSON.parse(localStorage.getItem('symbiknow:bookmarks')!)).toEqual([]);
  expect(await fixture.reload()).toEqual(fixture.canvas);
});
