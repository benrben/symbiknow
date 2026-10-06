// @vitest-environment jsdom
import { renderHook, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { cameraFrames, holdNativeNodeMeasurements, nativeCameraClock } from './CanvasOverview.readiness.test.helpers';
import { block, canvas, installCanvasBrowser, mount, props, run, state } from './canvas-model.test.helpers';
import { useCanvasState } from './canvas-state';

installCanvasBrowser();

function metadataCanvas(count: number) {
  return canvas(Array.from({ length: count }, (_, index) => block(`document-${index}`, {
    content: '', contentLoaded: false, group: `custom:team${index % 4}`,
    x: index % 10 * 400, y: Math.floor(index / 10) * 320,
  })));
}

describe('opening large canvases before renderer measurements', () => {
  it.each([100, 600])('offers group frames and no document nodes or body requests for %s documents before fitting', async count => {
    nativeCameraClock();
    holdNativeNodeMeasurements();
    const requests = vi.fn(async () => Response.json({ error: 'Unexpected document request' }, { status: 500 }));
    vi.stubGlobal('fetch', requests);

    mount({ canvasProps: props(metadataCanvas(count)) });
    expect(state()).toMatchObject({ zoom: .28, pinned: true });
    await cameraFrames(96);

    expect(state().pinned).toBe(true);
    expect(state().nodes.length).toBeGreaterThan(0);
    expect(state().nodes.every(node => node.id.startsWith('group:'))).toBe(true);
    expect(document.querySelectorAll('.react-flow__node-groupFrame').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.react-flow__node-document')).toHaveLength(0);
    expect(JSON.parse(screen.getByLabelText('Native fit readiness').textContent ?? '{}').initialized).toBe(false);
    expect(requests).not.toHaveBeenCalled();
  });

  it('keeps document preview nodes below the overview threshold before any fitting occurs', () => {
    const document = metadataCanvas(99);

    mount({ canvasProps: props(document), view: 'surface' });

    expect(state()).toMatchObject({ zoom: 1, pinned: false });
    expect(state().nodes.filter(node => !node.id.startsWith('group:')).map(node => node.id))
      .toEqual(document.blocks.map(block => block.id));
  });

  it('exposes only the chosen group documents after an explicit group focus and zoom', () => {
    const document = metadataCanvas(120);
    mount({ canvasProps: props(document), view: 'surface', action: model => {
      model.focusGroup('custom:team2');
      model.moved(undefined, { x: 0, y: 0, zoom: .8 });
    } });
    expect(state().nodes.every(node => node.id.startsWith('group:'))).toBe(true);

    run();

    expect(state()).toMatchObject({ pinned: false, group: 'custom:team2', zoom: .8 });
    expect(state().nodes.filter(node => !node.id.startsWith('group:')).map(node => node.id))
      .toEqual(document.blocks.filter(block => block.group === 'custom:team2').map(block => block.id));
  });

  it.each([{ count: 99, zoom: 1, band: 'full', pinned: false }, { count: 100, zoom: .28, band: 'overview', pinned: true }])
    ('starts the viewport transition band consistently with the visible nodes at $count documents', ({ count, zoom, band, pinned }) => {
      const { result } = renderHook(() => useCanvasState(props(metadataCanvas(count))), { wrapper: ReactFlowProvider });

      expect(result.current.zoom).toBe(zoom);
      expect(result.current.mapPinned).toBe(pinned);
      expect(result.current.zoomBand.current).toBe(band);
    });
});
