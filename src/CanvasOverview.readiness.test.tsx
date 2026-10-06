// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '../shared/types';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';
import { holdNativeNodeMeasurements } from './CanvasOverview.readiness.test.helpers';

installAssistantBrowser();
describe('saved group overview before native initial-fit readiness', () => {
  it('keeps the user overview request when delayed document measurements release the initial fit', async () => {
    const release = holdNativeNodeMeasurements();
    await assistantFixture(undefined, false, async request => {
      const initial = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      for (const [index, block] of initial.blocks.entries()) {
        await request(`/api/canvases/product-roadmap/blocks/${block.id}`, { ...jsonBody({ group: index === 0 ? 'custom:launch/notes' : index === 1 ? 'custom:launch/reference' : null }), method: 'PUT' });
      }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
    const viewport = document.querySelector('.react-flow__viewport');
    if (!viewport) throw new Error('Missing native viewport');
    await waitFor(() => expect(viewport.getAttribute('style')).toContain('scale(0.28)'));
    release();
    await waitFor(() => expect(document.querySelector('.react-flow__node')?.getAttribute('style')).not.toContain('visibility: hidden'));
    await waitFor(() => expect(viewport.getAttribute('style')).toContain('scale(0.28)'));
  });
});
