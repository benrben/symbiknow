// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CanvasStore } from '../server/storage';
import type { CanvasDocument } from '../shared/types';
import { App } from './App';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';

installAssistantBrowser();

async function showGroups() {
  fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
  await waitFor(() => expect(document.querySelector('.react-flow__viewport')?.getAttribute('style')).toContain('scale(0.28)'));
  const groups = screen.getByRole('navigation', { name: 'Mini-map groups' });
  fireEvent.click(within(groups).getByText(/^Map ·/));
  return groups;
}

describe('CanvasOverview navigation from native saved metadata', () => {
  it('navigates persisted nested groups and selects their document, then reloads the same hierarchy', async () => {
    const title = 'Launch evidence 🚀 ' + 'אבג漢字'.repeat(18);
    let saved!: CanvasDocument;
    const fixture = await assistantFixture(undefined, false, async request => {
      const initial = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      for (const [index, block] of initial.blocks.entries()) {
        const group = index === 0 ? 'custom:launch/notes' : index === 1 ? 'custom:launch/reference' : null;
        const response = await request(`/api/canvases/product-roadmap/blocks/${block.id}`, { ...jsonBody({ group, ...(index === 0 ? { title, links: [initial.blocks[1].id] } : {}) }), method: 'PUT' });
        expect(response.status).toBe(200);
      }
      saved = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
    });
    const board = await showGroups();
    fireEvent.click(within(board).getByRole('button', { name: /^Launch/ }));
    expect(screen.queryByRole('navigation', { name: 'Group overview' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Notes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Browse files' }));
    const files = await screen.findByRole('region', { name: 'Notes group documents' });
    const selected = within(files).getByRole('button', { name: name => name.includes(title) });
    expect(selected.querySelector('small')?.textContent).toBe('markdown');
    fireEvent.click(selected);
    const inspector = await screen.findByRole('complementary', { name: 'Selection inspector' });
    expect(within(inspector).getByText(title)).toBeTruthy();
    await within(inspector).findByRole('heading', { name: saved.blocks[0].content.split('\n')[0].replace(/^#\s*/, ''), level: 1 });
    expect(document.querySelector(`[data-id="${saved.blocks[0].id}"]`)?.classList.contains('selected')).toBe(true);
    expect(screen.queryByRole('region', { name: 'Notes group documents' })).toBeNull();
    expect(await fixture.read(saved.id)).toEqual(saved);
    const restarted = new CanvasStore(fixture.root);
    await restarted.init();
    expect(await restarted.getCanvas(saved.id)).toEqual(saved);
    fixture.unmount();
    render(<App />);
    await screen.findByText('Product Roadmap', { selector: '.canvas-label h1' });
    const restored = await showGroups();
    expect([...restored.querySelectorAll('button')].map(item => item.textContent)).toEqual([expect.stringMatching(/^Launch/), expect.stringMatching(/^Ungrouped/)]);
    expect(await fixture.read(saved.id)).toEqual(saved);
  });
});
