// @vitest-environment jsdom
import { StrictMode, useLayoutEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../shared/types';
import { api } from './api';
import { BlockContent } from './Loaders';
import { applyTheme } from './theme';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';

afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  applyTheme('light');
  await closeWorkspaceFixtures();
});

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>;
const htmlSource = '<!doctype html><html><body><h1>Native page</h1></body></html>';
const uploaded = '---\r\nformat: HTML\r\n---\r\n' + htmlSource;

async function createDocument(fixture: Fixture, kind: CanvasBlock['kind'], content: string) {
  return api<CanvasBlock>(`/canvases/${fixture.canvas.id}/blocks`, {
    method: 'POST', body: JSON.stringify({ title: 'Native preview', kind, content }),
  });
}

function contentProps(fixture: Fixture, block: CanvasBlock, fullPage = false) {
  return { block, canvasId: fixture.canvas.id, fullPage,
    onUpdateBlock: async (id: string, patch: Partial<CanvasBlock>) => {
      await api(`/canvases/${fixture.canvas.id}/blocks/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
    }, onError: (message: string) => { throw new Error(message); } };
}

function preview() { return screen.getByTitle('Native preview HTML preview') as HTMLIFrameElement; }
function heightMessage(source: Window | null, data: unknown) {
  act(() => window.dispatchEvent(new MessageEvent('message', { source, data })));
}

it('keeps an invalid persisted diagram readable as an error when the public theme changes', async () => {
  const fixture = await workspaceFixture();
  const block = await createDocument(fixture, 'markdown', '```mermaid\ninvalid native diagram\n```');
  const before = await fixture.reload();
  applyTheme('dark'); render(<BlockContent {...contentProps(fixture, block)}/>);
  expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toContain('Mermaid:');
  await act(async () => applyTheme('light'));
  expect(document.documentElement.dataset.theme).toBe('light');
  expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toContain('Mermaid:');
  expect(await fixture.reload()).toEqual(before);
});

it.each(['markdown', 'slides', 'website', 'mdx'] as const)('previews a persisted uploaded HTML page regardless of its %s loader', async kind => {
  const fixture = await workspaceFixture();
  const block = await createDocument(fixture, kind, uploaded);
  const before = await fixture.reload();
  const view = render(<BlockContent {...contentProps(fixture, block)}/>);
  expect(preview().srcdoc).toBe(htmlSource);
  expect(preview().getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals');
  expect(preview().getAttribute('referrerpolicy')).toBe('no-referrer');
  view.unmount();
  expect(await fixture.reload()).toEqual(before);
  render(<BlockContent {...contentProps(fixture, before.blocks.find(item => item.id === block.id)!, true)}/>);
  expect(preview().srcdoc).toContain(htmlSource);
  expect(preview().srcdoc).toContain('symbiknowHtmlHeight');
  expect(await fixture.reload()).toEqual(before);
});

it('sizes the full-page reader only from its iframe and bounds valid heights across public mode changes', async () => {
  const fixture = await workspaceFixture();
  const block = await createDocument(fixture, 'markdown', uploaded);
  const props = contentProps(fixture, block, true);
  const view = render(<StrictMode><BlockContent {...props}/></StrictMode>);
  const frame = preview();
  heightMessage(window, { symbiknowHtmlHeight: 999 });
  expect(frame.style.height).toBe('');
  for (const data of [null, {}, { symbiknowHtmlHeight: 0 }, { symbiknowHtmlHeight: -5 }, { symbiknowHtmlHeight: 'Infinity' }]) {
    heightMessage(frame.contentWindow, data); expect(frame.style.height).toBe('');
  }
  heightMessage(frame.contentWindow, { symbiknowHtmlHeight: 12.3 }); expect(frame.style.height).toBe('21px');
  heightMessage(frame.contentWindow, { symbiknowHtmlHeight: 99_999 }); expect(frame.style.height).toBe('40000px');
  heightMessage(frame.contentWindow, { symbiknowHtmlHeight: '200.2' }); expect(frame.style.height).toBe('209px');
  view.rerender(<StrictMode><BlockContent {...props} fullPage={false}/></StrictMode>);
  expect(frame.style.height).toBe(''); expect(frame.srcdoc).toBe(htmlSource);
  heightMessage(frame.contentWindow, { symbiknowHtmlHeight: 999 }); expect(frame.style.height).toBe('');
  view.rerender(<StrictMode><BlockContent {...props}/></StrictMode>);
  heightMessage(frame.contentWindow, { symbiknowHtmlHeight: 222 }); expect(frame.style.height).toBe('230px');
  view.unmount(); heightMessage(frame.contentWindow, { symbiknowHtmlHeight: 999 });
  expect(screen.queryByTitle('Native preview HTML preview')).toBeNull();
  expect((await fixture.reload()).blocks.find(item => item.id === block.id)).toEqual(block);
});

it('ignores an iframe message during the mounted parent layout that removes its reader', async () => {
  const fixture = await workspaceFixture();
  const block = await createDocument(fixture, 'markdown', uploaded);
  let source: Window | null = null;
  function Reader() {
    const [visible, setVisible] = useState(true);
    useLayoutEffect(() => {
      if (!visible) window.dispatchEvent(new MessageEvent('message', { source, data: { symbiknowHtmlHeight: 999 } }));
    }, [visible]);
    return <><button onClick={() => setVisible(false)}>Close native reader</button>
      {visible && <BlockContent {...contentProps(fixture, block, true)}/>}</>;
  }
  render(<Reader/>); source = preview().contentWindow;
  fireEvent.click(screen.getByRole('button', { name: 'Close native reader' }));
  expect(screen.queryByTitle('Native preview HTML preview')).toBeNull();
  expect((await fixture.reload()).blocks.find(item => item.id === block.id)).toEqual(block);
});

it('keeps an unsaved research website readable until it is durably saved', async () => {
  const fixture = await workspaceFixture();
  const block = await createDocument(fixture, 'website', '# Native website\nKeep this specification.');
  const before = await fixture.reload();
  const props = contentProps(fixture, block);
  const view = render(<BlockContent {...props} canvasId="session-research"/>);
  expect(screen.getByRole('heading', { name: 'Native website' })).toBeTruthy();
  expect(screen.getByText('Save this research canvas to build and preview the website.')).toBeTruthy();
  expect(screen.queryByTitle('Native preview website preview')).toBeNull();
  view.rerender(<BlockContent {...props}/>);
  expect(screen.getByTitle('Native preview website preview').getAttribute('src')).toBe(`/api/canvases/${fixture.canvas.id}/blocks/${block.id}/site/?static=1`);
  expect(await fixture.reload()).toEqual(before);
});

it('refreshes each rendered document field after native API writes and switching the public block identity', async () => {
  const fixture = await workspaceFixture();
  let block = await createDocument(fixture, 'markdown', '# Original preview');
  const props = contentProps(fixture, block);
  const view = render(<BlockContent {...props}/>);
  expect(screen.getByRole('heading', { name: 'Original preview' })).toBeTruthy();
  view.rerender(<BlockContent {...props} block={{ ...block, x: block.x + 25 }}/>);
  expect(screen.getByRole('heading', { name: 'Original preview' })).toBeTruthy();
  block = await api<CanvasBlock>(`/canvases/${fixture.canvas.id}/blocks/${block.id}`, {
    method: 'PUT', body: JSON.stringify({ content: uploaded }),
  });
  view.rerender(<BlockContent {...props} block={block}/>); expect(preview().srcdoc).toBe(htmlSource);
  block = await api<CanvasBlock>(`/canvases/${fixture.canvas.id}/blocks/${block.id}`, {
    method: 'PUT', body: JSON.stringify({ title: 'Renamed native preview' }),
  });
  view.rerender(<BlockContent {...props} block={block}/>);
  expect(screen.getByTitle('Renamed native preview HTML preview')).toBeTruthy();
  const second = await createDocument(fixture, 'markdown', '- [ ] Save the other document');
  view.rerender(<BlockContent {...props} block={second}/>);
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(async () => expect((await fixture.reload()).blocks.find(item => item.id === second.id)?.content).toBe('- [x] Save the other document'));
  const changed = await api<CanvasBlock>(`/canvases/${fixture.canvas.id}/blocks/${second.id}`, {
    method: 'PUT', body: JSON.stringify({ kind: 'website' }),
  });
  view.rerender(<BlockContent {...props} block={changed}/>);
  expect(screen.getByTitle('Native preview website preview')).toBeTruthy();
  expect((await fixture.reload()).blocks.find(item => item.id === block.id)).toEqual(block);
});

it('uses replacement public update and error callbacks for real saves and a lost native response', async () => {
  const fixture = await workspaceFixture();
  let block = await createDocument(fixture, 'markdown', '- [ ] Native task');
  const errors: string[] = [];
  const props = contentProps(fixture, block);
  const view = render(<BlockContent {...props} onError={message => errors.push('old: ' + message)}/>);
  const update = async (id: string, patch: Partial<CanvasBlock>) => {
    block = await api<CanvasBlock>(`/canvases/${fixture.canvas.id}/blocks/${id}`, {
      method: 'PUT', body: JSON.stringify({ ...patch, purpose: 'guide' }),
    });
  };
  const oldError = (message: string) => errors.push('old: ' + message);
  view.rerender(<BlockContent {...props} onUpdateBlock={update} onError={oldError}/>);
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(block.purpose).toBe('guide'));
  await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
  const updatedProps = { ...props, block, onUpdateBlock: update, onError: oldError };
  view.rerender(<BlockContent {...updatedProps}/>);
  view.rerender(<BlockContent {...updatedProps} onError={message => errors.push('current: ' + message)}/>);
  const held = fixture.hold(`/api/canvases/${fixture.canvas.id}/blocks/${block.id}`, 'PUT');
  fireEvent.click(screen.getByRole('checkbox'));
  expect((await held.response).status).toBe(200);
  await act(async () => { held.fail('Preview save response disconnected'); });
  await waitFor(() => expect(errors).toEqual(['current: Could not save checkbox: Preview save response disconnected']));
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
  const saved = (await fixture.reload()).blocks.find(item => item.id === block.id)!;
  expect(saved.content).toBe('- [ ] Native task'); expect(saved.purpose).toBe('guide');
  view.unmount(); render(<BlockContent {...contentProps(fixture, saved)}/>);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
