// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { CanvasStore } from '../server/storage';
import { App } from './App';
import { assistantFixture, jsonBody } from './AppAssistantPanel.test.helpers';
import { inputFile, installWorkspaceBrowser } from './AppWorkspaceView.test.helpers';

installWorkspaceBrowser();
function uploadInput() {
  const input = document.querySelector<HTMLInputElement>('.topbar input[type=file]');
  if (!input) throw new Error('Missing native file input');
  return input;
}
async function createNamed(label: string, name: string) {
  const dialog = await screen.findByRole('dialog', { name: 'Create new' });
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value: name } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
  await screen.findByText(label === 'Workspace name' ? 'Untitled canvas' : name, { selector: '.canvas-label h1' });
}

describe('workspace public controls backed by native persistence', () => {
  it('preserves the theme while keeping the workspace header available without the removed navigation bar', async () => {
    localStorage.setItem('symbiknow:header-hidden', 'true');
    const fixture = await assistantFixture(undefined, false);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(document.querySelector('.canvas-label h1')?.textContent).toBe('Product Roadmap');
    expect(document.querySelector('.canvas-navigation')).toBeNull();
    for (const name of ['Back to previous canvas view', 'Forward to next canvas view', 'Bookmarks and recently viewed', 'Hide header', 'Show header']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    fixture.unmount();
    render(<App />);
    await screen.findByRole('region', { name: 'Product Roadmap infinite canvas' });
    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('.canvas-label h1')?.textContent).toBe('Product Roadmap');
    expect(document.querySelector('.canvas-navigation')).toBeNull();
  });

  it('opens and closes saved groups without manual grouping actions', async () => {
    const fixture = await assistantFixture(undefined, false);
    const saved = await fixture.read('product-roadmap');
    await userEvent.click(screen.getByRole('button', { name: 'Search documents' }));
    await screen.findByRole('dialog', { name: 'Search documents' });
    fireEvent.click(screen.getByRole('button', { name: 'Browse groups' }));
    expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();
    const groups = screen.getByRole('complementary', { name: 'Browse groups' });
    expect(document.querySelector('.canvas-main')?.classList.contains('is-grouping')).toBe(true);
    fireEvent.click(within(groups).getByRole('button', { name: 'Open ' + saved.blocks[0].title }));
    expect(screen.queryByRole('complementary', { name: 'Browse groups' })).toBeNull();
    await screen.findByRole('dialog', { name: saved.blocks[0].title + ' full page' });
    fireEvent.click(screen.getByRole('button', { name: /Back to canvas/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: saved.blocks[0].title + ' full page' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Browse groups' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close browse groups' }));
    expect(document.querySelector('.canvas-main')?.classList.contains('is-grouping')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Symbi' }));
    expect(screen.queryByRole('complementary', { name: 'Symbi assistant' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Browse groups' }));
    expect(screen.getByRole('complementary', { name: 'Browse groups' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Group documents' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Suggested groups' })).toBeNull();
    expect(await fixture.read(saved.id)).toEqual(saved);
  });

  it('uploads through the browser input and reads the new source from a restarted store', async () => {
    const fixture = await assistantFixture(undefined, false);
    const input = uploadInput();
    fireEvent.change(input, { target: { files: null } });
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.upload(input, inputFile('# Uploaded roadmap\nNative evidence.', 'Uploaded.md'));
    await waitFor(async () => expect((await fixture.read('product-roadmap')).blocks.some(block => block.title === 'Uploaded')).toBe(true));
    expect(input.value).toBe('');
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect((await restarted.getCanvas('product-roadmap')).blocks.find(block => block.title === 'Uploaded')?.content).toBe('# Uploaded roadmap\nNative evidence.');
  });

  it('routes temporary-research tools to the research session and leaves saved documents unchanged', async () => {
    const fixture = await assistantFixture(undefined, true);
    const before = await fixture.read('product-roadmap');
    fireEvent.click(screen.getByRole('button', { name: 'Open research canvas' }));
    const research = await screen.findByRole('region', { name: 'Research canvas' });
    await userEvent.click(screen.getByRole('button', { name: 'Search documents' }));
    expect(document.activeElement).toBe(within(research).getByRole('textbox', { name: 'Find in research canvas' }));
    expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Browse groups' }));
    await waitFor(() => expect(research.querySelector('.react-flow__viewport')?.getAttribute('style')).toContain('scale(0.28)'));
    expect(screen.queryByRole('complementary', { name: 'Browse groups' })).toBeNull();
    const input = uploadInput();
    fireEvent.change(input, { target: { files: null } });
    await userEvent.upload(input, inputFile('# Temporary input\nReview in this session.', 'Temporary.md'));
    await waitFor(() => expect(research.textContent).toContain('Temporary'));
    expect(input.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Create note' }));
    const editor = await screen.findByRole('dialog', { name: 'Document editor' });
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'Session note' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save document' }));
    await waitFor(() => expect(research.textContent).toContain('Session note'));
    expect(await fixture.read(before.id)).toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'Return to main canvas' }));
    expect(screen.queryByRole('region', { name: 'Research canvas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Insights' })).toBeNull();
  });

  it('shows native canvas and workspace empty states, then creates the first saved document', async () => {
    const deletions: Promise<Response>[] = [];
    const fixture = await assistantFixture((_route, init, forward) => {
      const response = forward();
      if (init.method === 'DELETE') deletions.push(response.then(value => value.clone()));
      return response;
    }, false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete canvas: Product Roadmap' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete canvas' })).getByRole('button', { name: 'Delete canvas' }));
    expect(deletions).toHaveLength(1);
    await act(async () => {
      const response = await deletions[0];
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });
    await screen.findByRole('heading', { name: 'Your workspace is ready for a canvas' });
    expect((await fixture.documents())[0].canvases).toEqual([]);
    expect(screen.getByRole('button', { name: 'Upload files' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Create note' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Create canvas' }));
    await createNamed('Canvas name', 'Empty view');
    await screen.findByRole('heading', { name: 'Make knowledge together.' });
    const emptyPrompt = document.querySelector<HTMLElement>('.canvas-empty-prompt');
    expect(emptyPrompt).toBeTruthy();
    const activatedUpload = vi.fn();
    uploadInput().addEventListener('click', activatedUpload);
    fireEvent.click(within(emptyPrompt!).getByRole('button', { name: 'Upload files' }));
    expect(activatedUpload).toHaveBeenCalledOnce();
    fireEvent.click(within(emptyPrompt!).getByRole('button', { name: 'Create note' }));
    const editor = screen.getByRole('dialog', { name: 'Document editor' });
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'First evidence' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save document' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Make knowledge together.' })).toBeNull());
    const created = (await fixture.documents())[0].canvases[0];
    expect((await fixture.read(created.id)).blocks).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace: Acme Team' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete workspace' })).getByRole('button', { name: 'Delete workspace' }));
    expect(deletions).toHaveLength(2);
    await act(async () => {
      const response = await deletions[1];
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });
    await screen.findByRole('heading', { name: 'One infinite canvas for people and AI' });
    expect(await fixture.documents()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await createNamed('Workspace name', 'Research team');
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect((await restarted.listWorkspaces())[0]).toMatchObject({ name: 'Research team', canvases: [{ name: 'Untitled canvas' }] });
  });

  it('opens document history, then summarizes native keyboard multi-selection', async () => {
    const fixture = await assistantFixture(undefined, false);
    const document = await fixture.read('product-roadmap');
    const title = document.blocks[0].title;
    fireEvent.click(screen.getByRole('button', { name: 'History for ' + title }));
    const history = await screen.findByRole('dialog', { name: 'History and branches' });
    await within(history).findByRole('region', { name: 'Revision history' });
    fireEvent.click(within(history).getByRole('button', { name: 'Close dialog' }));
    const pane = window.document.querySelector('.react-flow__pane');
    if (!pane) throw new Error('Missing installed canvas pane');
    fireEvent.click(pane);
    await waitFor(() => expect(window.document.querySelectorAll('.react-flow__node.selected')).toHaveLength(0));
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    for (const block of document.blocks.slice(0, 2)) {
      const node = window.document.querySelector<HTMLElement>(`.react-flow__node[data-id="${block.id}"]`);
      if (!node) throw new Error('Missing installed document node');
      fireEvent.keyDown(node, { key: 'Enter', code: 'Enter', ctrlKey: true });
    }
    fireEvent.keyUp(window, { key: 'Control' });
    const summarize = await screen.findByRole('button', { name: 'AI: summarize these' });
    fireEvent.click(summarize);
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(settings).getByRole('radiogroup', { name: 'Model provider' })).toBeTruthy();
    expect(await fixture.read(document.id)).toEqual(document);
  });

  it('preserves saved sources and groups across remount while manual grouping controls remain absent', async () => {
    const fixture = await assistantFixture(undefined, false);
    const saved = await fixture.read('product-roadmap');
    expect(screen.queryByRole('button', { name: 'Group documents' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'By tags' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Suggested groups' })).toBeNull();
    fixture.unmount();
    render(<App/>);
    await screen.findByRole('region', { name: 'Product Roadmap infinite canvas' });
    expect(screen.queryByRole('button', { name: 'Group documents' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Suggested groups' })).toBeNull();
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect(await restarted.getCanvas('product-roadmap')).toEqual(saved);
  });

  it('opens a saved research copy and switches canvases through the sidebar with native persisted documents', async () => {
    const fixture = await assistantFixture(undefined, true);
    fireEvent.click(screen.getByRole('button', { name: 'Open research canvas' }));
    const research = await screen.findByRole('region', { name: 'Research canvas' });
    fireEvent.click(within(research).getByRole('button', { name: 'Save canvas' }));
    fireEvent.click(await within(research).findByRole('button', { name: 'Open saved canvas ↗' }, { timeout: 4000 }));
    await screen.findByText('Research — Release evidence', { selector: '.canvas-label h1' });
    const saved = (await fixture.documents())[0].canvases.find(canvas => canvas.name === 'Research — Release evidence');
    if (!saved) throw new Error('Missing durable research copy');
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect((await restarted.getCanvas(saved.id)).blocks.map(block => block.title)).toEqual(['Release review']);
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Product Roadmap' }));
    await screen.findByText('Product Roadmap', { selector: '.canvas-label h1' });
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: ' + saved.name }));
    await screen.findByText(saved.name, { selector: '.canvas-label h1' });
    expect(screen.queryByRole('region', { name: 'Research canvas' })).toBeNull();
  });

  it('connects sidebar dialogs, upload activation, document editing, reading and a persisted cross-canvas portal', async () => {
    let other!: CanvasDocument;
    let destination!: CanvasBlock;
    const fixture = await assistantFixture(undefined, false, async request => {
      other = await request('/api/workspaces/acme-team/canvases', jsonBody({ name: 'Related canvas' })).then(response => response.json()) as CanvasDocument;
      destination = await request('/api/canvases/' + other.id + '/blocks', jsonBody({ title: 'Related evidence', kind: 'markdown', content: 'Related durable text' })).then(response => response.json()) as CanvasBlock;
      const response = await request('/api/canvases/product-roadmap/blocks/roadmap-overview', { ...jsonBody({ crossLinks: [{ canvasId: other.id, blockId: destination.id }] }), method: 'PUT' });
      expect(response.status).toBe(200);
    });
    for (const name of ['New workspace', 'New canvas', 'Settings']) {
      fireEvent.click(screen.getByRole('button', { name }));
      const dialog = await screen.findByRole('dialog', { name: name === 'Settings' ? 'Settings' : 'Create new' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    }
    const clicked = vi.fn();
    uploadInput().addEventListener('click', clicked);
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    expect(clicked).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Create note' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Document editor' })).getByRole('button', { name: 'Close dialog' }));
    const before = await fixture.read('product-roadmap');
    const title = before.blocks.find(block => block.id === 'roadmap-overview')?.title;
    if (!title) throw new Error('Missing persisted origin');
    fireEvent.click(screen.getByRole('button', { name: 'Edit ' + title }));
    const editor = await screen.findByRole('dialog', { name: 'Document editor' });
    expect(within(editor).getByLabelText('Title')).toHaveProperty('value', title);
    fireEvent.click(within(editor).getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read ' + title + ' full page' }));
    await screen.findByRole('dialog', { name: title + ' full page' });
    fireEvent.click(screen.getByRole('button', { name: /Back to canvas/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: title + ' full page' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: `Open related document ${destination.id} on canvas ${other.id}` }));
    const reader = await screen.findByRole('dialog', { name: 'Related evidence full page' });
    await waitFor(() => expect(reader.textContent).toContain('Related durable text'));
    expect(await fixture.read(before.id)).toEqual(before);
  });

  it('reveals and edits actual API search hits, retaining source contents when the editor closes', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      const other = await request('/api/workspaces/acme-team/canvases', jsonBody({ name: 'Search reference' })).then(response => response.json()) as CanvasDocument;
      const saved = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      await request('/api/canvases/' + other.id + '/blocks', jsonBody({ title: saved.blocks[0].title + ' reference', kind: 'markdown', content: 'Related source' }));
    });
    const before = await fixture.read('product-roadmap');
    const title = before.blocks[0].title;
    fireEvent.click(screen.getByRole('button', { name: 'Search documents' }));
    const search = await screen.findByRole('dialog', { name: 'Search documents' });
    fireEvent.change(within(search).getByRole('textbox', { name: 'Search every Markdown file' }), { target: { value: title } });
    fireEvent.click(await within(search).findByRole('button', { name: 'Show ' + title + ' on canvas' }));
    expect(screen.getByRole('region', { name: before.name + ' infinite canvas' })).toBeTruthy();
    fireEvent.click(within(search).getByRole('button', { name: 'Edit ' + title }));
    const editor = await screen.findByRole('dialog', { name: 'Document editor' });
    expect(within(editor).getByLabelText('Title')).toHaveProperty('value', title);
    fireEvent.click(within(editor).getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search documents' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Search documents' })).getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();
    expect(await fixture.read(before.id)).toEqual(before);
  });

  it('shows an actual transport failure, reconnects and dismisses a file-format error', async () => {
    let disconnected = false;
    let creationUnavailable = false;
    let other!: CanvasDocument;
    const fixture = await assistantFixture((route, init, forward) => {
      if (disconnected && route === '/api/canvases/' + other.id) throw new TypeError('Failed to fetch');
      if (creationUnavailable && init.method === 'POST' && route.endsWith('/canvases')) throw new TypeError('Failed to fetch');
      return forward();
    }, false, async request => {
      other = await request('/api/workspaces/acme-team/canvases', jsonBody({ name: 'Reconnect canvas' })).then(response => response.json()) as CanvasDocument;
    });
    disconnected = true;
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Reconnect canvas' }));
    const reconnect = await screen.findByRole('button', { name: 'Reconnect' });
    expect(screen.getByRole('alert').textContent).toContain('server is unavailable');
    disconnected = false;
    fireEvent.click(reconnect);
    await screen.findByText(other.name, { selector: '.canvas-label h1' });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(uploadInput(), { target: { files: [inputFile('Unsupported input', 'Evidence.pdf')] } });
    expect((await screen.findByRole('alert')).textContent).toContain('Choose a .md, .mdx, or .html file: Evidence.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).toBeNull();
    creationUnavailable = true;
    fireEvent.click(screen.getByRole('button', { name: 'New canvas' }));
    const creation = await screen.findByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(creation).getByLabelText('Canvas name'), { target: { value: 'Unavailable creation' } });
    fireEvent.click(within(creation).getByRole('button', { name: 'Create' }));
    expect((await within(creation).findByRole('alert')).textContent).toContain('server is unavailable');
    expect(document.querySelector('.global-error')).toBeNull();
    creationUnavailable = false;
    fireEvent.click(within(creation).getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((await fixture.read(other.id)).blocks).toHaveLength(0);
  });
});
