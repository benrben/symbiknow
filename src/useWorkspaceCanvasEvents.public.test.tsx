// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '../shared/types';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';
import { useAppModel } from './app-model';
import { useWorkspaceCanvasEvents } from './useWorkspaceCanvasEvents';

installAssistantBrowser();
const camera = { x: 410, y: 280, zoom: 1.4 };
const focus = { level: 'documents' as const, visibleGroups: [] };
async function eventOwner() {
  let other!: CanvasDocument;
  const fixture = await assistantFixture(undefined, false, async request => {
    other = await request('/api/workspaces/acme-team/canvases', jsonBody({ name: 'Other canvas' })).then(response => response.json()) as CanvasDocument;
  });
  fixture.unmount();
  // A public hook consumer can receive viewport reports before/after its
  // renderer mounts. The actual AppModel still owns data, navigation and stores.
  const owner = renderHook(() => {
    const model = useAppModel();
    return { model, events: useWorkspaceCanvasEvents(model) };
  });
  await waitFor(() => expect(owner.result.current.model.canvas?.id).toBe('product-roadmap'));
  return { ...owner, fixture, other };
}
describe('workspace viewport events with the native AppModel and API', () => {
  it('ignores reports during a genuinely absent canvas, then accepts focus and visible document changes', async () => {
    const { result, fixture } = await eventOwner();
    await act(async () => { await result.current.model.loadCanvas(''); });
    expect(result.current.model.canvas).toBeNull();
    const before = result.current.model.journey.current;
    act(() => result.current.events.viewportChanged(camera, ['roadmap-overview'], focus));
    expect(result.current.model.journey.current).toBe(before);
    expect(result.current.model.visibleBlockIds).toEqual([]);
    const saved = await fixture.request('/api/canvases/product-roadmap/blocks', jsonBody({ title: 'New evidence', content: 'Source updated while the surface was absent', kind: 'markdown' }));
    expect(saved.status).toBe(201);
    await act(async () => { await result.current.model.loadCanvas('product-roadmap'); });
    expect(result.current.model.canvas?.id).toBe('product-roadmap');
    act(() => result.current.events.viewportChanged(camera, ['roadmap-overview'], { ...focus, activeGroup: 'custom:planning' }));
    expect(result.current.model.visibleBlockIds).toEqual(['roadmap-overview']);
    expect(result.current.model.canvasViewFocus.activeGroup).toBe('custom:planning');
    const same = result.current.model.canvasViewFocus;
    act(() => result.current.events.viewportChanged(camera, ['roadmap-overview'], { ...focus, activeGroup: 'custom:planning' }));
    expect(result.current.model.canvasViewFocus).toBe(same);
    act(() => result.current.events.viewportChanged(camera, ['roadmap-overview'], { ...focus, activeGroup: 'custom:planning', visibleGroups: ['custom:planning'] }));
    expect(result.current.model.canvasViewFocus.visibleGroups).toEqual(['custom:planning']);
    await waitFor(() => expect(result.current.model.journey.current?.viewport).toEqual(camera));
  });
  it('invalidates old pending views across A → B → A and falls back after a current timer publishes', async () => {
    const { result, other } = await eventOwner();
    await act(async () => result.current.model.selectCanvas(other.id));
    await waitFor(() => expect(result.current.model.canvas?.id).toBe(other.id));
    act(() => result.current.model.selectCanvas('product-roadmap'));
    await waitFor(() => expect(result.current.model.canvas?.id).toBe('product-roadmap'));
    act(() => result.current.events.viewportChanged(camera, ['roadmap-overview'], focus));
    act(() => result.current.model.selectCanvas(other.id));
    expect(result.current.model.canvas).toBeNull();
    await waitFor(() => expect(result.current.model.canvas?.id).toBe(other.id));
    expect(result.current.model.journey.current?.canvasId).toBe(other.id);
    expect(result.current.model.journey.current?.viewport).toBeUndefined();
    act(() => result.current.model.selectCanvas('product-roadmap'));
    expect(result.current.model.canvas).toBeNull();
    await waitFor(() => expect(result.current.model.canvas?.id).toBe('product-roadmap'));
    expect(result.current.model.journey.current?.canvasId).toBe('product-roadmap');
    expect(result.current.model.journey.current?.viewport).toBeUndefined();
    act(() => result.current.events.viewportChanged(camera, ['roadmap-overview'], focus));
    await waitFor(() => expect(result.current.model.journey.current?.viewport).toEqual(camera));
    expect(result.current.model.journey.current).toMatchObject({ canvasId: 'product-roadmap', viewport: camera });
  });
  it('cancels its pending publication on unmount and gives a new native owner a fresh camera', async () => {
    const { result, unmount } = await eventOwner();
    const scheduled = vi.spyOn(window, 'setTimeout');
    const canceled = vi.spyOn(window, 'clearTimeout');
    act(() => result.current.events.viewportChanged(camera, [], focus));
    const index = scheduled.mock.calls.findIndex(([, delay]) => delay === 180);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = scheduled.mock.results[index].value;
    unmount();
    expect(canceled).toHaveBeenCalledWith(timer);
    const next = renderHook(() => {
      const model = useAppModel();
      return { model, events: useWorkspaceCanvasEvents(model) };
    });
    await waitFor(() => expect(next.result.current.model.canvas?.id).toBe('product-roadmap'));
    expect(next.result.current.model.journey.current?.viewport).toBeUndefined();
  });
});
