// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from 'codemirror';
import { describe, expect, it } from 'vitest';
import { CanvasStore } from '../server/storage';
import type { CanvasDocument } from '../shared/types';
import { App } from './App';
import { assistantFixture, jsonBody } from './AppAssistantPanel.test.helpers';
import { installWorkspaceBrowser } from './AppWorkspaceView.test.helpers';

installWorkspaceBrowser();

async function installedSource(dialog: HTMLElement) {
  return waitFor(() => {
    const source = within(dialog).getByRole('textbox', { name: 'Markdown source' });
    const view = EditorView.findFromDOM(source);
    if (!view) throw new Error('Missing installed source editor in native block dialog');
    return { source, view };
  });
}

describe('MarkdownEditor through actual App edit, native HTTP, Git and reload', () => {
  it('retains native draft input through view switching and a failed save, then saves once and restores the source from native storage on remount', async () => {
    let failNextSave = true;
    const fixture = await assistantFixture((route, init, forward) => {
      if (init.method === 'PUT' && route.endsWith('/blocks/roadmap-overview') && failNextSave) {
        failNextSave = false;
        return Promise.resolve(Response.json({ error: 'Editor transport unavailable' }, { status: 503 }));
      }
      return forward();
    }, false, async request => {
      const original = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      for (const block of original.blocks.filter(value => value.id !== 'roadmap-overview')) {
        expect((await request(`/api/canvases/${original.id}/blocks/${block.id}`, { method: 'DELETE' })).status).toBe(200);
      }
      expect((await request('/api/canvases/product-roadmap/blocks/roadmap-overview', {
        ...jsonBody({ content: '# Native source\nBefore save.', x: 100, y: 200, width: 320, height: 240 }), method: 'PUT',
      })).status).toBe(200);
    });
    const original = await fixture.read('product-roadmap');
    const block = original.blocks[0];
    const historyBefore = await new CanvasStore(fixture.root).documentHistory(original.id, block.id);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit ' + block.title }));
    const dialog = await screen.findByRole('dialog', { name: 'Document editor' });
    const initial = await installedSource(dialog);
    expect(initial.view.state.doc.toString()).toBe(block.content);
    const content = '# Persisted Unicode evidence 🚀\n\n**Reviewed אבג漢字**\n\n- [ ] Native save';
    await act(async () => { initial.view.dispatch({ changes: { from: 0, to: initial.view.state.doc.length, insert: content } }); });
    const modes = within(dialog).getByRole('group', { name: 'Editor view' });
    within(modes).getByRole('button', { name: 'Source' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(within(modes).getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');
    expect((await installedSource(dialog)).view).toBe(initial.view);
    expect(within(dialog).getByRole('region', { name: 'Document preview' }).textContent).toContain('Reviewed אבג漢字');
    await userEvent.click(within(modes).getByRole('button', { name: 'Preview' }));
    expect(within(dialog).queryByRole('textbox', { name: 'Markdown source' })).toBeNull();
    await userEvent.click(within(modes).getByRole('button', { name: 'Source' }));
    const restored = await installedSource(dialog);
    expect(restored.view).not.toBe(initial.view);
    expect(restored.view.state.doc.toString()).toBe(content);
    fireEvent.keyDown(restored.source, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(within(modes).getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(within(modes).getByRole('button', { name: 'Preview' }), { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(within(modes).getByRole('button', { name: 'Source' }).getAttribute('aria-pressed')).toBe('true');
    expect((await installedSource(dialog)).view.state.doc.toString()).toBe(content);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save document' }));
    await screen.findByText('Editor transport unavailable');
    expect((await installedSource(dialog)).view.state.doc.toString()).toBe(content);
    expect(await fixture.read(original.id)).toEqual(original);
    expect(await new CanvasStore(fixture.root).documentHistory(original.id, block.id)).toEqual(historyBefore);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save document' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull());
    const saved = await fixture.read(original.id);
    expect(saved.blocks[0].content).toBe(content);
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect(await restarted.getCanvas(saved.id)).toEqual(saved);
    const history = await restarted.documentHistory(saved.id, block.id);
    expect(history.commits.length).toBe(historyBefore.commits.length + 1);
    expect(history.commits[0]).toMatchObject({ author: 'Browser', message: 'Edit ' + block.title });
    fixture.unmount(); render(<App />);
    await screen.findByText(saved.name, { selector: '.canvas-label h1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit ' + block.title }));
    const reopened = await screen.findByRole('dialog', { name: 'Document editor' });
    expect((await installedSource(reopened)).view.state.doc.toString()).toBe(content);
    fireEvent.click(within(reopened).getByRole('button', { name: 'Cancel' }));
    expect(await fixture.read(saved.id)).toEqual(saved);
    expect(await restarted.documentHistory(saved.id, block.id)).toEqual(history);
  }, 15_000);
});
