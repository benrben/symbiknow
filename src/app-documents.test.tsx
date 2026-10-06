// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import type { CanvasDocument, ChatSettings } from '../shared/types';
import { useAppState } from './app-state';
import { useCanvasData } from './app-canvas-data';
import { useCanvasNavigationActions } from './app-navigation';
import { useDocumentActions } from './app-documents';
import { browserActor } from './api';

const originalFetch = globalThis.fetch;
const opened: Array<{ server: Server; dataDir: string }> = [];
type Intercept = (route: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
function failure(message: string) { return new Response(JSON.stringify({ error: message }), { status: 503 }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const formEvent = () => ({ preventDefault: vi.fn() }) as unknown as FormEvent;
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type ResourceHandler = (uri: string) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
function file(name: string, text: () => Promise<string>) {
  const result = new File([], name); Object.defineProperty(result, 'text', { value: text }); return result;
}
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-documents-'));
  const server = await createApiServer({ dataDir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, dataDir });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  let intercept: Intercept | undefined;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => intercept?.(url.replace('?summary=1', ''), init) ?? originalFetch(base + url, init));
  const hook = renderHook(() => {
    const state = useAppState(); const data = useCanvasData(state); const navigation = useCanvasNavigationActions(state);
    return { state, data, navigation, actions: useDocumentActions(state, data, navigation) };
  });
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe('product-roadmap'));
  const canvas = await originalFetch(base + '/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
  const read = (id = canvas.id) => originalFetch(base + '/api/canvases/' + id).then(response => response.json()) as Promise<CanvasDocument>;
  const other = await originalFetch(base + '/api/workspaces/' + canvas.workspaceId + '/canvases', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other canvas' }),
  }).then(response => response.json()) as CanvasDocument;
  await act(async () => { await hook.result.current.data.refreshWorkspaces(canvas.id); });
  const otherId = other.id;
  return { ...hook, base, canvas, otherId, read, intercept: (next?: Intercept) => { intercept = next; } };
}
beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, '', '/?canvas=product-roadmap'); });
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.WebMCP;
  for (const { server, dataDir } of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

describe('document actions through the real canvas API', () => {
  it('refreshes after a registered WebMCP write and reports refresh failure without losing the saved document', async () => {
    const tools = new Map<string, ToolHandler>();
    const resources = new Map<string, ResourceHandler>();
    window.WebMCP = class {
      registerTool(name: string, _description: string, _schema: unknown, handler: ToolHandler) { tools.set(name, handler); }
      registerResource(name: string, _description: string, _template: unknown, handler: ResourceHandler) { resources.set(name, handler); }
    };
    const { result, intercept, read } = await fixture();
    await waitFor(() => expect(tools.has('create_doc')).toBe(true));
    const create = tools.get('create_doc')!;
    await act(async () => { await create({ title: 'MCP written note', content: '# MCP written note' }); });
    await waitFor(() => expect(result.current.state.canvas?.blocks.some(block => block.title === 'MCP written note')).toBe(true));
    expect((await read()).blocks.some(block => block.title === 'MCP written note')).toBe(true);
    const active = await resources.get('active_canvas')!('canvas://active');
    expect(JSON.parse(active.contents[0].text)).toMatchObject({ id: 'product-roadmap' });
    intercept((route, init) => route === '/api/canvases/product-roadmap' && !init?.method ? failure('MCP canvas refresh unavailable') : undefined);
    await act(async () => { await create({ title: 'Saved despite refresh', content: '# Saved despite refresh' }); });
    await waitFor(() => expect(result.current.state.error).toBe('MCP canvas refresh unavailable'));
    expect((await read()).blocks.some(block => block.title === 'Saved despite refresh')).toBe(true);
  });

  it('opens new and existing drafts and distinguishes Browser locks from another editor', async () => {
    const { result, canvas } = await fixture();
    act(() => result.current.actions.openNewBlock());
    expect(result.current.state).toMatchObject({ dialog: 'block', draftBlock: { title: 'Untitled note', kind: 'markdown', content: '# Untitled note\n\nStart writing here.\n' } });
    const block = canvas.blocks[0];
    const lock = { owner: 'External agent', expiresAt: '2099-01-01T00:00:00Z' };
    act(() => result.current.actions.openBlock({ ...block, lock }));
    expect(result.current.state.draftLock).toEqual(lock);
    expect(result.current.state.draftBlock).toMatchObject({ id: block.id, contentHash: block.contentHash });
    act(() => result.current.actions.openBlock({ ...block, lock: { ...lock, owner: browserActor } }));
    expect(result.current.state.draftLock).toBeUndefined();
    act(() => result.current.actions.openBlock(block));
    expect(result.current.state.draftLock).toBeUndefined();
  });

  it('creates and updates a document, trims its title, and persists changes on read-back', async () => {
    const { result, read } = await fixture();
    act(() => { result.current.actions.openNewBlock(); result.current.state.setDraftBlock({ title: '  Reviewed note  ', kind: 'markdown', content: '# Reviewed note\nEvidence' }); });
    await act(async () => { await result.current.actions.saveBlock(formEvent()); });
    const created = (await read()).blocks.find(block => block.title === 'Reviewed note')!;
    expect(created.content).toBe('# Reviewed note\nEvidence');
    expect(result.current.state).toMatchObject({ dialog: null, busy: false, error: '', focusRequest: { blockId: created.id, title: created.title } });
    act(() => { result.current.actions.openBlock(created); result.current.state.setDraftBlock(current => ({ ...current, title: 'Updated note', content: '# Updated' })); });
    await act(async () => { await result.current.actions.saveBlock(formEvent()); });
    expect((await read()).blocks.find(block => block.id === created.id)).toMatchObject({ title: 'Updated note', content: '# Updated' });
  });

  it.each(['canvas', 'title'])('refuses a save without a %s before writing', async missing => {
    const { result, canvas, read } = await fixture();
    act(() => { result.current.actions.openNewBlock(); if (missing === 'canvas') result.current.state.setCanvasId(''); else result.current.state.setDraftBlock({ title: '  ', kind: 'markdown', content: 'Draft' }); });
    const event = formEvent(); await act(async () => { await result.current.actions.saveBlock(event); });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(await read()).toEqual(canvas);
    expect(result.current.state.busy).toBe(false);
  });

  it('keeps a failed save draft available and permits a successful retry', async () => {
    const { result, intercept, read, canvas } = await fixture();
    act(() => result.current.actions.openNewBlock());
    intercept((route, init) => init?.method === 'POST' && route.endsWith('/blocks') ? failure('Write unavailable') : undefined);
    await act(async () => { await result.current.actions.saveBlock(formEvent()); });
    expect(result.current.state).toMatchObject({ dialog: 'block', busy: false, error: 'Write unavailable', draftBlock: { title: 'Untitled note' } });
    expect(await read()).toEqual(canvas);
    intercept(); await act(async () => { await result.current.actions.saveBlock(formEvent()); });
    expect((await read()).blocks).toHaveLength(canvas.blocks.length + 1);
    expect(result.current.state.error).toBe('');
  });

  it('does not close a newer dialog when a previous save finishes after navigation', async () => {
    const { result, intercept, read, base, otherId } = await fixture();
    const response = deferred<void>(); let writing = false;
    intercept((route, init) => { if (init?.method === 'POST' && route.endsWith('/blocks')) {
      writing = true; return originalFetch(base + route, init).then(async saved => { await response.promise; return saved; });
    } });
    act(() => result.current.actions.openNewBlock());
    let saving!: Promise<void>; act(() => { saving = result.current.actions.saveBlock(formEvent()); });
    await waitFor(() => expect(writing).toBe(true));
    act(() => { result.current.navigation.navigateTo({ canvasId: otherId, canvasName: 'Other canvas' }); result.current.actions.openNamedDialog('workspace'); result.current.state.setDraftName('New team draft'); });
    response.resolve();
    await act(async () => { await saving; });
    expect(result.current.state).toMatchObject({ dialog: 'workspace', draftName: 'New team draft', canvasId: otherId });
    expect((await read()).blocks.some(block => block.title === 'Untitled note')).toBe(true);
  });

  it('does not replace a newer dialog error when an old save fails', async () => {
    const { result, intercept } = await fixture(); const response = deferred<Response>();
    intercept((_route, init) => init?.method === 'POST' ? response.promise : undefined);
    act(() => result.current.actions.openNewBlock());
    let saving!: Promise<void>; act(() => { saving = result.current.actions.saveBlock(formEvent()); });
    act(() => { result.current.actions.openNamedDialog('canvas'); result.current.state.setError('New form message'); });
    response.resolve(failure('Old save failure'));
    await act(async () => { await saving; });
    expect(result.current.state).toMatchObject({ dialog: 'canvas', error: 'New form message' });
  });

  it('takes over a lock, clears the draft lock, and reports unavailable takeover requests', async () => {
    const { result, canvas, intercept, read } = await fixture(); const block = canvas.blocks[0];
    act(() => result.current.state.setDraftLock({ owner: 'Other editor', expiresAt: '2099-01-01T00:00:00Z' }));
    await act(async () => { await result.current.actions.takeOverLock(block.id); });
    expect(result.current.state.draftLock).toBeUndefined(); expect((await read()).blocks.find(item => item.id === block.id)?.lock).toBeUndefined();
    intercept(route => route.includes('/lock?force=1') ? failure('Lock service unavailable') : undefined);
    await act(async () => { await result.current.actions.takeOverLock(block.id); });
    expect(result.current.state.error).toBe('Lock service unavailable');
  });

  it('moves documents and skips publishing the old layout after navigation', async () => {
    const { result, canvas, read, intercept, otherId } = await fixture(); const block = canvas.blocks[0];
    await act(async () => { await result.current.actions.moveBlocks([{ blockId: block.id, x: 850, y: 700 }]); });
    expect((await read()).blocks.find(item => item.id === block.id)).toMatchObject({ x: 850, y: 700 });
    const response = deferred<Response>(); intercept(route => route.endsWith('/layout') ? response.promise : undefined);
    let moving!: Promise<void>; act(() => { moving = result.current.actions.moveBlocks([{ blockId: block.id, x: 900, y: 900 }]); });
    act(() => result.current.navigation.navigateTo({ canvasId: otherId, canvasName: 'Other canvas' }));
    response.resolve(new Response('{}')); await act(async () => { await moving; });
    expect(result.current.state.canvasId).toBe(otherId);
    expect(result.current.state.canvas?.id).not.toBe(canvas.id);
  });

  it('opens version history and activity-linked revisions, including missing-document and network recovery', async () => {
    const { result, canvas, intercept } = await fixture(); const block = canvas.blocks[0];
    act(() => { result.current.state.setVersionRevision('old'); result.current.actions.openVersionHistory(block); });
    expect(result.current.state).toMatchObject({ dialog: 'versions', versionBlockId: block.id }); expect(result.current.state.versionRevision).toBeUndefined();
    await act(async () => { await result.current.actions.openActivityHistory(canvas.id, block.id, 'reviewed-revision'); });
    expect(result.current.state).toMatchObject({ dialog: 'versions', versionRevision: 'reviewed-revision', canvas: { id: canvas.id, name: canvas.name } });
    expect(result.current.state.canvas!.blocks.every(item => item.contentLoaded === false && item.content === '')).toBe(true);
    await act(async () => { await result.current.actions.openActivityHistory(canvas.id, 'removed', 'old'); });
    expect(result.current.state.error).toContain('This document is no longer on the canvas');
    intercept(route => route === '/api/canvases/' + canvas.id ? failure('History unavailable') : undefined);
    await act(async () => { await result.current.actions.openActivityHistory(canvas.id, block.id, 'old'); });
    expect(result.current.state.error).toBe('History unavailable');
  });

  it('updates a document in place, preserves unrelated documents, and surfaces failed edits to the caller', async () => {
    const { result, canvas, read, intercept } = await fixture(); const block = canvas.blocks[0];
    const unrelated = result.current.state.canvas!.blocks[1];
    await act(async () => { await result.current.actions.updateBlock(block.id, { title: 'Inspector edit' }); });
    expect(result.current.state.canvas?.blocks.find(item => item.id === block.id)?.title).toBe('Inspector edit');
    expect((await read()).blocks.find(item => item.id === block.id)?.title).toBe('Inspector edit');
    expect(result.current.state.canvas?.blocks[1]).toBe(unrelated);
    expect((await read()).blocks[1]).toEqual(canvas.blocks[1]);
    intercept((_route, init) => init?.method === 'PUT' ? failure('Edit denied') : undefined);
    await act(async () => { await expect(result.current.actions.updateBlock(block.id, { title: 'Denied' })).rejects.toThrow('Edit denied'); });
    expect(result.current.state.error).toBe('Edit denied');
  });

  it.each(['canvas', 'editor'])('deletes from the %s and preserves errors for a retry', async origin => {
    const { result, canvas, read, intercept } = await fixture(); const block = canvas.blocks[0];
    act(() => result.current.actions.openBlock(block));
    intercept((_route, init) => init?.method === 'DELETE' ? failure('Delete unavailable') : undefined);
    await act(async () => { if (origin === 'canvas') await expect(result.current.actions.deleteCanvasBlock(block.id)).rejects.toThrow('Delete unavailable'); else await result.current.actions.deleteBlock(); });
    expect(result.current.state.error).toBe('Delete unavailable'); expect(await read()).toEqual(canvas);
    intercept(); await act(async () => { if (origin === 'canvas') await result.current.actions.deleteCanvasBlock(block.id); else await result.current.actions.deleteBlock(); });
    expect((await read()).blocks.some(item => item.id === block.id)).toBe(false);
  });

  it('imports edited files, preserving the current kind for Markdown and reporting read failures', async () => {
    const { result } = await fixture();
    act(() => result.current.state.setDraftBlock({ title: 'Slides', kind: 'slides', content: '# Original' }));
    await act(async () => { await result.current.actions.importEditedFile(file('slides.MD', async () => '# New slides')); });
    expect(result.current.state.draftBlock).toMatchObject({ kind: 'slides', content: '# New slides' });
    await act(async () => { await result.current.actions.importEditedFile(file('interactive.mdx', async () => '# Interactive')); });
    expect(result.current.state.draftBlock).toMatchObject({ kind: 'mdx', content: '# Interactive' });
    await act(async () => { await result.current.actions.importEditedFile(file('broken.md', async () => { throw new Error('File unavailable'); })); });
    expect(result.current.state.error).toBe('File unavailable'); expect(result.current.state.draftBlock.content).toBe('# Interactive');
  });

  it('saves settings and keeps failure ownership with the visible settings form', async () => {
    const { result, base, intercept } = await fixture(); act(() => result.current.state.setDialog('settings'));
    const payload = { provider: 'openrouter' as const, model: 'openai/gpt-4o-mini', systemPrompt: 'Reviewed settings' };
    await act(async () => { await result.current.actions.saveSettings(payload); });
    const settings = await originalFetch(base + '/api/settings').then(response => response.json()) as ChatSettings;
    expect(settings.systemPrompt).toBe('Reviewed settings'); expect(result.current.state).toMatchObject({ settings, dialog: null, busy: false });
    intercept(route => route === '/api/settings' ? failure('Settings unavailable') : undefined);
    act(() => result.current.state.setDialog('settings'));
    await act(async () => { await expect(result.current.actions.saveSettings(payload)).rejects.toThrow('Settings unavailable'); });
    expect(result.current.state).toMatchObject({ dialog: 'settings', busy: false });
  });

  it('preserves a newer dialog after a settings write completes, while retaining the saved settings', async () => {
    const { result, base, intercept } = await fixture(); const release = deferred<void>();
    intercept((route, init) => route === '/api/settings' && init?.method === 'PUT'
      ? originalFetch(base + route, init).then(async response => { await release.promise; return response; }) : undefined);
    act(() => result.current.state.setDialog('settings'));
    let saving!: Promise<void>;
    act(() => { saving = result.current.actions.saveSettings({ provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: 'Saved after navigation' }); });
    act(() => result.current.actions.openNamedDialog('workspace'));
    release.resolve(); await act(async () => { await saving; });
    expect(result.current.state).toMatchObject({ dialog: 'workspace', settings: { systemPrompt: 'Saved after navigation' } });
    expect(await originalFetch(base + '/api/settings').then(response => response.json())).toMatchObject({ systemPrompt: 'Saved after navigation' });
  });

  it('opens named dialogs with a fresh name and handles non-Error action failures', async () => {
    const { result } = await fixture(); act(() => { result.current.state.setDraftName('Old name'); result.current.actions.openNamedDialog('canvas'); });
    expect(result.current.state).toMatchObject({ draftName: '', dialog: 'canvas' });
    await act(async () => { await result.current.actions.perform(async () => { throw 'Boundary failure'; }); });
    expect(result.current.state).toMatchObject({ dialog: 'canvas', busy: false, error: 'Something went wrong. Please try again.' });
  });
});
