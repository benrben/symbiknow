// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { api } from './api';
import { useAppModel } from './app-model';
import { blockPath } from './app-model-helpers';
import { FullPageReader } from './AppDocumentReader';
import { BlockContent } from './Loaders';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';

type Workspace = Awaited<ReturnType<typeof workspaceFixture>>;

afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await closeWorkspaceFixtures();
});

async function summaries(workspace: Workspace) {
  return api<CanvasDocument>(`/canvases/${workspace.canvas.id}?summary=1`, { cache: 'no-store' });
}

function previewProps(workspace: Workspace, block: CanvasBlock) {
  return { block, canvasId: workspace.canvas.id,
    onUpdateBlock: async (id: string, patch: Partial<CanvasBlock>) => {
      await api(blockPath(workspace.canvas.id, id), { method: 'PUT', body: JSON.stringify(patch) });
    }, onError: (message: string) => { throw new Error(message); } };
}

async function appModel(workspace: Workspace) {
  window.history.replaceState(null, '', '/?canvas=' + workspace.canvas.id);
  const hook = renderHook(useAppModel);
  await waitFor(() => expect(hook.result.current.canvas?.id).toBe(workspace.canvas.id));
  return hook;
}

it('keeps an unloaded preview visible as loading, shows a lost response, and retries the real document', async () => {
  const workspace = await workspaceFixture();
  const summary = (await summaries(workspace)).blocks[0];
  expect(summary).toMatchObject({ content: '', contentLoaded: false });
  const route = '/api' + blockPath(workspace.canvas.id, summary.id);
  const held = workspace.hold(route, 'GET');
  const fetcher = vi.fn(fetch); vi.stubGlobal('fetch', fetcher);
  render(<BlockContent {...previewProps(workspace, summary)}/>);
  expect(screen.getByRole('status').textContent).toBe('Loading document…');
  expect(document.querySelector('.loader-markdown')).toBeNull();
  expect((await held.response).status).toBe(200);
  await act(async () => { held.fail('Document response disconnected'); });
  expect((await screen.findByRole('alert')).textContent).toContain('Document response disconnected');
  expect(document.querySelector('.loader-markdown')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading document' }));
  expect(await screen.findByRole('heading', { name: summary.title })).toBeTruthy();
  expect(screen.getByText('Read the deployment checklist before releasing the service.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  const reads = fetcher.mock.calls.filter(([path, init]) => String(path) === route && !init?.method);
  expect(reads).toHaveLength(2);
  expect(reads.every(([, init]) => init?.cache === 'no-store')).toBe(true);
  expect(await workspace.reload()).toEqual(workspace.canvas);
});

it('retries the reader and checks cited passages against fetched content and its current hash', async () => {
  const workspace = await workspaceFixture();
  const model = await appModel(workspace);
  const saved = workspace.canvas.blocks[0];
  const excerpt = 'Read the deployment checklist before releasing the service.';
  expect(model.result.current.canvas?.blocks[0]).toMatchObject({ content: '', contentLoaded: false });
  expect(model.result.current.canvas?.blocks[0].contentHash).toBeUndefined();
  act(() => model.result.current.navigateFromChat({ kind: 'document', canvasId: workspace.canvas.id,
    blockId: saved.id, title: saved.title, excerpt, contentHash: saved.contentHash }));
  const held = workspace.hold('/api' + blockPath(workspace.canvas.id, saved.id), 'GET');
  const view = render(<FullPageReader model={model.result.current}/>);
  expect(screen.getByRole('status').textContent).toBe('Loading document…');
  expect((screen.getByRole('button', { name: 'Edit document' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByLabelText('Source context from Chat')).toBeNull();
  expect(document.querySelector('.page-reader__content')).toBeNull();
  expect((await held.response).status).toBe(200);
  await act(async () => { held.fail('Reader response disconnected'); });
  expect((await screen.findByRole('alert')).textContent).toContain('Reader response disconnected');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading document' }));
  const context = await screen.findByLabelText('Source context from Chat');
  expect(within(context).getByText(excerpt)).toBeTruthy();
  expect(within(context).getByText('This passage appears in the current document.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Edit document' }) as HTMLButtonElement).disabled).toBe(false);
  view.unmount();
  await api(blockPath(workspace.canvas.id, saved.id), { method: 'PUT', body: JSON.stringify({ content: '# Current release guide\nThe deployment procedure changed.' }) });
  render(<FullPageReader model={model.result.current}/>);
  expect(await screen.findByRole('heading', { name: 'Current release guide' })).toBeTruthy();
  expect(screen.getByLabelText('Source context from Chat').textContent).toContain('This document changed since Chat checked it.');
  expect((await workspace.reload()).blocks.find(block => block.id === saved.id)?.content).toContain('The deployment procedure changed.');
});

it('fetches separately for a preview and reader, persists a checkbox, and opens the loaded document for editing', async () => {
  const workspace = await workspaceFixture();
  const created = await api<CanvasBlock>(`/canvases/${workspace.canvas.id}/blocks`, { method: 'POST',
    body: JSON.stringify({ title: 'Release tasks', content: '# Original release tasks\n\n- [ ] Approve release\n\nKeep this evidence.' }) });
  const model = await appModel(workspace);
  const summary = model.result.current.canvas!.blocks.find(block => block.id === created.id)!;
  const route = '/api' + blockPath(workspace.canvas.id, created.id);
  const fetcher = vi.fn(fetch); vi.stubGlobal('fetch', fetcher);
  const preview = render(<BlockContent {...previewProps(workspace, summary)}/>);
  expect(await screen.findByRole('heading', { name: 'Original release tasks' })).toBeTruthy();
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  await api(blockPath(workspace.canvas.id, created.id), { method: 'PUT',
    body: JSON.stringify({ content: '# Current release tasks\n\n- [ ] Approve release\n\nKeep this evidence.' }) });
  preview.unmount();
  act(() => model.result.current.openReader(created.id));
  const reader = render(<FullPageReader model={model.result.current}/>);
  expect(await screen.findByRole('heading', { name: 'Current release tasks' })).toBeTruthy();
  const reads = fetcher.mock.calls.filter(([path, init]) => String(path) === route && !init?.method);
  expect(reads).toHaveLength(2);
  expect(reads.every(([, init]) => init?.cache === 'no-store')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(async () => expect((await workspace.reload()).blocks.find(block => block.id === created.id)?.content)
    .toBe('# Current release tasks\n\n- [x] Approve release\n\nKeep this evidence.'));
  await waitFor(() => expect(model.result.current.canvas?.blocks.find(block => block.id === created.id)?.content).toContain('- [x] Approve release'));
  reader.rerender(<FullPageReader model={model.result.current}/>);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  const current = (await workspace.reload()).blocks.find(block => block.id === created.id)!;
  fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
  expect(model.result.current.dialog).toBe('block');
  expect(model.result.current.draftBlock).toMatchObject({ id: created.id, content: current.content, contentHash: current.contentHash });
  expect(fetcher.mock.calls.filter(([path, init]) => String(path) === route && !init?.method)).toHaveLength(2);
});

it('finishes loading a genuinely empty document in both preview and reader', async () => {
  const workspace = await workspaceFixture();
  const empty = await api<CanvasBlock>(`/canvases/${workspace.canvas.id}/blocks`, { method: 'POST', body: JSON.stringify({ title: 'Empty note', content: '' }) });
  const model = await appModel(workspace);
  const summary = model.result.current.canvas!.blocks.find(block => block.id === empty.id)!;
  const held = workspace.hold('/api' + blockPath(workspace.canvas.id, empty.id), 'GET');
  const preview = render(<BlockContent {...previewProps(workspace, summary)}/>);
  expect(screen.getByRole('status')).toBeTruthy();
  expect(document.querySelector('.loader-markdown')).toBeNull();
  await act(async () => { await held.release(); });
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(document.querySelector('.loader-markdown')?.textContent).toBe('');
  preview.unmount();
  act(() => model.result.current.openReader(empty.id));
  render(<FullPageReader model={model.result.current}/>);
  await waitFor(() => expect(document.querySelector('.page-reader__content .loader-markdown')?.textContent).toBe(''));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((await workspace.reload()).blocks.find(block => block.id === empty.id)?.content).toBe('');
});
