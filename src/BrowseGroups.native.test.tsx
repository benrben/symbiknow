// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CanvasStore } from '../server/storage';
import type { CanvasDocument } from '../shared/types';
import { App } from './App';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';

installAssistantBrowser();

async function openLibrary() {
  fireEvent.click(screen.getByRole('button', { name: 'Browse groups' }));
  return screen.findByRole('complementary', { name: 'Browse groups' });
}

describe('BrowseGroups through actual App navigation and native saved documents', () => {
  it('lists API-persisted canonical groups, opens the exact duplicate-title reader and preserves the native canvas and groups across restart and remount', async () => {
    const title = 'Saved evidence 🚀 ' + 'אבג漢字'.repeat(12);
    const fixture = await assistantFixture(undefined, false, async request => {
      const original = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      for (const block of original.blocks) {
        expect((await request(`/api/canvases/${original.id}/blocks/${block.id}`, { method: 'DELETE' })).status).toBe(200);
      }
      for (const [index, block] of [
        { title: 'Loose evidence', content: '# Loose evidence', group: undefined },
        { title: 'Duplicate evidence', content: '# Saved second duplicate\nSecond exact persisted ID.', group: 'custom:alpha' },
        { title: 'Duplicate evidence', content: '# Saved first duplicate\nFirst exact persisted ID.', group: 'custom:alpha' },
        { title, content: '# Unicode evidence', group: 'custom:alpha/notes' },
        { title: 'Zebra evidence', content: '# Zebra evidence', group: 'custom:zebra' },
        { title: 'Lane evidence', content: '# Legacy lane evidence', group: 'work' },
      ].entries()) {
        expect((await request(`/api/canvases/${original.id}/blocks`, jsonBody({ ...block, x: 100 + index * 380, y: 200, width: 320, height: 240 }))).status).toBe(201);
      }
    });
    const saved = await fixture.read('product-roadmap');
    const alpha = saved.blocks.filter(value => value.group === 'custom:alpha').sort((a, b) => a.id.localeCompare(b.id));
    const chosen = alpha[1];
    expect(alpha).toHaveLength(2);
    const history = await new CanvasStore(fixture.root).documentHistory(saved.id, chosen.id);
    const library = await openLibrary();
    expect(within(library).getAllByRole('region').map(value => value.getAttribute('aria-label'))).toEqual([
      'Active work', 'Alpha', 'Alpha / Notes', 'Zebra', 'Ungrouped',
    ]);
    expect(within(library).getByRole('button', { name: 'Open ' + title }).textContent).toContain(title);
    const duplicateButtons = within(within(library).getByRole('region', { name: 'Alpha' })).getAllByRole('button', { name: 'Open Duplicate evidence' });
    await userEvent.click(duplicateButtons[1]);
    expect(screen.queryByRole('complementary', { name: 'Browse groups' })).toBeNull();
    const reader = await screen.findByRole('dialog', { name: 'Duplicate evidence full page' });
    expect(await within(reader).findByText(chosen.content.split('\n')[1])).toBeTruthy();
    expect(within(reader).getByRole('combobox', { name: 'Jump to document' })).toHaveProperty('value', chosen.id);
    fireEvent.click(within(reader).getByRole('button', { name: /Back to canvas/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Duplicate evidence full page' })).toBeNull());
    const canvas = await screen.findByRole('region', { name: saved.name + ' infinite canvas' });
    expect(canvas.querySelector('.react-flow')).toBeTruthy();
    expect(canvas.querySelectorAll('.react-flow__node.selected')).toHaveLength(0);
    // Reader Back restores the canvas view. A subsequent genuine document
    // click starts a new model selection rather than inventing a focus request.
    const visible = canvas.querySelector('.react-flow__node-document');
    if (!visible) throw new Error('Missing actual visible saved document');
    const visibleBlock = saved.blocks.find(value => value.id === visible.getAttribute('data-id'));
    if (!visibleBlock) throw new Error('Visible document is absent from the saved API canvas');
    fireEvent.click(visible);
    const inspector = screen.getByRole('complementary', { name: 'Selection inspector' });
    expect(inspector.textContent).toContain(visibleBlock.title);
    expect(visible.classList.contains('selected')).toBe(true);
    fireEvent.click(within(inspector).getByRole('button', { name: 'Close inspector' }));
    expect(visible.classList.contains('selected')).toBe(false);
    const reopened = await openLibrary();
    const close = within(reopened).getByRole('button', { name: 'Close browse groups' });
    close.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Browse groups' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    expect(await fixture.read(saved.id)).toEqual(saved);
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect(await restarted.getCanvas(saved.id)).toEqual(saved);
    expect(await restarted.documentHistory(saved.id, chosen.id)).toEqual(history);
    fixture.unmount(); render(<App />);
    await screen.findByText(saved.name, { selector: '.canvas-label h1' });
    const restored = await openLibrary();
    expect(within(restored).getAllByRole('region').map(value => value.getAttribute('aria-label'))).toEqual([
      'Active work', 'Alpha', 'Alpha / Notes', 'Zebra', 'Ungrouped',
    ]);
    expect(within(restored).getAllByRole('button', { name: 'Open Duplicate evidence' })).toHaveLength(2);
    fireEvent.click(within(restored).getByRole('button', { name: 'Close browse groups' }));
    expect(screen.queryByRole('complementary', { name: 'Browse groups' })).toBeNull();
    expect(await fixture.read(saved.id)).toEqual(saved);
  });
});
