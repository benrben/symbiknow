// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { block, camera, canvas, installCanvasBrowser, mount, props } from './canvas-model.test.helpers';

installCanvasBrowser();
describe('normal group navigation with the installed canvas renderer', () => {
  it('shows only the document kind for documents in the Ungrouped file board', async () => {
    mount({ canvasProps: props(canvas([block('plain'), block('named', { group: 'custom:planning', x: 500 })])) });
    await camera({ x: 24, y: 68, zoom: .2 });
    const overview = screen.getByRole('navigation', { name: 'Mini-map groups' });
    fireEvent.click(within(overview).getByText(/^Map ·/));
    fireEvent.click(within(overview).getByRole('button', { name: /Ungrouped/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Browse files' }));
    const board = await screen.findByRole('region', { name: 'Ungrouped group documents' });
    const document = within(board).getByRole('button', { name: /Document plain/ });
    expect(document.querySelector('small')?.textContent).toBe('markdown');
  });
});
