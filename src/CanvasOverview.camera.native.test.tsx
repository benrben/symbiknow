// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cameraFrames, holdNativeNodeMeasurements, nativeCameraClock } from './CanvasOverview.readiness.test.helpers';
import { block, canvas, installCanvasBrowser, instance, mount, props, run, state } from './canvas-model.test.helpers';

installCanvasBrowser();
const document = canvas([block('a', { group: 'custom:a' }), block('b', { group: 'custom:b', x: 400 })]);
function overview() { fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' })); }
function expectCenter(x: number, y: number) {
  const viewport = instance().getViewport();
  expect(viewport.zoom).toBeGreaterThanOrEqual(.8);
  expect(viewport.x).toBeCloseTo(500 - x * viewport.zoom, 5);
  expect(viewport.y).toBeCloseTo(400 - y * viewport.zoom, 5);
}
describe('overview camera ownership while installed renderer geometry is pending', () => {
  it('keeps a newer overview above an older document focus after initial fitting', async () => {
    nativeCameraClock(); const release = holdNativeNodeMeasurements();
    mount({ canvasProps: { ...props(document), focusRequest: { blockId: 'a', sequence: 1 } } });
    await cameraFrames(400);
    overview(); await cameraFrames(300);
    expect(state().pinned).toBe(true);
    release(); await cameraFrames(500);
    expect(instance().getViewport()).toEqual({ x: 24, y: 68, zoom: .28 });
  });
  it('allows a newer document focus to supersede an older pending overview', async () => {
    nativeCameraClock(); const release = holdNativeNodeMeasurements();
    const initial = props(document); const view = mount({ canvasProps: initial });
    await cameraFrames(96); overview(); await cameraFrames(300);
    view.change({ canvasProps: { ...initial, focusRequest: { blockId: 'a', sequence: 1 } } });
    await cameraFrames(400);
    expect(state()).toMatchObject({ pinned: false, selected: ['a'] });
    release(); await cameraFrames(500);
    expectCenter(170, 140);
    expect(state().pinned).toBe(false);
  });
  it('allows a newer group focus to supersede an older pending overview', async () => {
    nativeCameraClock(); const release = holdNativeNodeMeasurements();
    const initial = props(document); const view = mount({ canvasProps: initial });
    await cameraFrames(96); overview(); await cameraFrames(300);
    view.change({ canvasProps: { ...initial, groupFocusRequest: { canvasId: document.id, group: 'custom:b', sequence: 1 } } });
    await cameraFrames(500);
    expect(state()).toMatchObject({ pinned: false, group: 'custom:b' });
    release(); await cameraFrames(500);
    expect(instance().getZoom()).toBeCloseTo(1, 7);
    const frame = instance().getNode('group:custom:b');
    if (!frame || frame.type !== 'groupFrame') throw new Error('Missing installed group frame');
    expectCenter(frame.position.x + frame.data.width / 2, frame.position.y + frame.data.height / 2);
    expect(state().pinned).toBe(false);
  });
  it('lets a newer overview cancel an older pending group center', async () => {
    nativeCameraClock(); const release = holdNativeNodeMeasurements();
    mount({ canvasProps: { ...props(document), groupFocusRequest: { canvasId: document.id, group: 'custom:b', sequence: 1 } } });
    await cameraFrames(400); overview(); await cameraFrames(300);
    release(); await cameraFrames(500);
    expect(instance().getViewport()).toEqual({ x: 24, y: 68, zoom: .28 });
    expect(state()).toMatchObject({ pinned: true, group: '' });
  });
  it('keeps a newer explicit viewport above an older overview while node geometry is pending', async () => {
    nativeCameraClock(); const release = holdNativeNodeMeasurements();
    const initial = props(document); const view = mount({ canvasProps: initial });
    await cameraFrames(96); overview(); await cameraFrames(300);
    view.change({ canvasProps: { ...initial, viewportRequest: { x: 33, y: 44, zoom: .9, sequence: 1 } } });
    release(); await cameraFrames(600);
    expect(instance().getViewport()).toEqual({ x: 33, y: 44, zoom: .9 });
  });
  it('lets a newer overview supersede an older explicit viewport before initial fitting', async () => {
    nativeCameraClock(); const release = holdNativeNodeMeasurements();
    mount({ canvasProps: { ...props(document), viewportRequest: { x: 33, y: 44, zoom: .9, sequence: 1 } } });
    await cameraFrames(96); overview(); await cameraFrames(300);
    release(); await cameraFrames(600);
    expect(instance().getViewport()).toEqual({ x: 24, y: 68, zoom: .28 });
  });
  it('keeps an old overview from reclaiming the camera after A → B → A navigation', async () => {
    nativeCameraClock(); const release = holdNativeNodeMeasurements();
    const initial = props(document); const view = mount({ canvasProps: initial });
    await cameraFrames(96); overview(); await cameraFrames(300);
    const other = canvas([block('destination', { x: 200, y: 140 })], 'other');
    view.change({ canvasProps: { ...initial, canvas: other, focusRequest: { blockId: 'destination', sequence: 1 } } });
    await cameraFrames(96);
    view.change({ canvasProps: { ...initial, focusRequest: { blockId: 'a', sequence: 2 } } });
    release(); await cameraFrames(600);
    expectCenter(170, 140);
    expect(state()).toMatchObject({ pinned: false, selected: ['a'] });
  });
  it('cancels a ready overview frame on unmount without later viewport publication', async () => {
    nativeCameraClock();
    const published = vi.fn();
    const view = mount({ canvasProps: { ...props(document), onViewportChange: published } });
    await cameraFrames(96);
    overview(); view.unmount();
    const before = published.mock.calls.length;
    await cameraFrames(600);
    expect(published).toHaveBeenCalledTimes(before);
  });
  it('keeps a pending supergroup overview after native geometry arrives', async () => {
    nativeCameraClock(); const release = holdNativeNodeMeasurements();
    const many = canvas(Array.from({ length: 12 }, (_, index) => block('doc' + index, { group: 'custom:group' + index, x: index * 400 })));
    const view = mount({ canvasProps: props(many) });
    await cameraFrames(96); overview(); await cameraFrames(300);
    view.change({ canvasProps: props(many), action: model => model.openHierarchyGroup(model.supergroups[0].id) });
    run(); release(); await cameraFrames(600);
    expect(instance().getViewport()).toEqual({ x: 24, y: 68, zoom: .28 });
    expect(screen.getByRole('button', { name: /^Supergroup:/ })).toBeTruthy();
  });
  it.each(['document', 'group'] as const)('does not replay an already applied %s focus over a genuinely newer fit', async kind => {
    nativeCameraClock();
    const initial = { ...props(document), ...(kind === 'document' ? { focusRequest: { blockId: 'a', sequence: 1 } }
      : { groupFocusRequest: { canvasId: document.id, group: 'custom:b', sequence: 1 } }) };
    const view = mount({ canvasProps: initial });
    await cameraFrames(1000);
    view.change({ canvasProps: { ...initial, fitRequest: 1 } });
    await cameraFrames(1000);
    expect(instance().getZoom()).toBeCloseTo(.75, 7);
  });
});
