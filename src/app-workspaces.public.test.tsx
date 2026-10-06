// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import { useAppModel } from './app-model';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root: string }> = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-workspace-actions-'));
  const store = new CanvasStore(root); await store.init();
  const home = await store.getCanvas('product-roadmap');
  const workspace = await store.createWorkspace({ name: 'Other team' });
  const otherCanvas = await store.createCanvas(workspace.id, { name: 'Other team evidence' });
  await store.createBlock(otherCanvas.id, { title: 'Keeper', content: '# Keep this evidence' });
  await store.createBlock(otherCanvas.id, { title: 'Folded', content: '# Fold this evidence' });
  const other = await store.getCanvas(otherCanvas.id);
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native port');
  const base = `http://127.0.0.1:${address.port}`;
  let hold: { match: (route: string, init?: RequestInit) => boolean; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  vi.stubGlobal('fetch', async (route: string, init?: RequestInit) => {
    const pending = hold?.match(route, init) ? hold : undefined;
    const response = await nativeFetch(base + route, init);
    if (pending) { await response.clone().text(); pending.entered.resolve(); await pending.release.promise; }
    return response;
  });
  const hook = renderHook(useAppModel);
  await waitFor(() => expect(hook.result.current.canvas?.id).toBe(home.id));
  let submitted!: Promise<void>;
  const formView = render(<form onSubmit={event => { submitted = hook.result.current.createNamed(event); }}><button type="submit">Submit native form</button></form>);
  function submit() {
    fireEvent.submit(formView.container.querySelector('form')!);
    return submitted;
  }
  function holdRequest(match: (route: string, init?: RequestInit) => boolean) {
    const entered = deferred(); const release = deferred(); hold = { match, entered, release };
    return { entered: entered.promise, release: () => { hold = undefined; release.resolve(); } };
  }
  async function select(id: string) { act(() => hook.result.current.selectCanvas(id)); await waitFor(() => expect(hook.result.current.canvas?.id).toBe(id)); }
  const restarted = async () => { const fresh = new CanvasStore(root); await fresh.init(); return fresh; };
  return { ...hook, root, store, home, other, workspace, base, select, submit, holdRequest, restarted };
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/?canvas=product-roadmap'); });
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('workspace actions through public App actions and native persistence', () => {
  it.each(['canvas', 'workspace'] as const)('selects a fresh %s creation and clears only its completed draft', async dialog => {
    const current = await fixture(); act(() => { current.result.current.openNamedDialog(dialog); current.result.current.setDraftName('Fresh native creation'); });
    await act(async () => { await current.submit(); });
    await waitFor(() => expect(current.result.current.canvas?.name).toBe(dialog === 'canvas' ? 'Fresh native creation' : 'Untitled canvas'));
    expect(current.result.current).toMatchObject({ dialog: null, draftName: '' });
    const fresh = await current.restarted(); expect(await fresh.getCanvas(current.result.current.canvasId, true)).toEqual(current.result.current.canvas);
  });
  it('deletes the active canvas and selects a surviving canvas', async () => {
    const current = await fixture();
    act(() => current.result.current.requestDeleteCanvas(current.home.id, current.home.name, current.home.workspaceId));
    await act(async () => { await current.result.current.deleteCanvas(); });
    await waitFor(() => expect(current.result.current.canvas?.id).toBe(current.other.id));
    await expect((await current.restarted()).getCanvas(current.home.id)).rejects.toThrow('Canvas not found');
  });
  it('treats absent deletion requests and a blank creation name as ordinary no-ops', async () => {
    const current = await fixture(); const before = await current.store.listWorkspaces();
    await act(async () => { await current.result.current.deleteCanvas(); await current.result.current.deleteWorkspace(); });
    act(() => { current.result.current.openNamedDialog('canvas'); current.result.current.setDraftName('  '); });
    await act(async () => { await current.submit(); });
    expect(await (await current.restarted()).listWorkspaces()).toEqual(before);
    expect(current.result.current.dialog).toBe('canvas');
  });
  it('removes only deleted search hits and chat-return history while keeping another canvas intact', async () => {
    const current = await fixture(); await current.store.createBlock(current.home.id, { title: 'Evidence to delete', content: '# Evidence to delete' });
    act(() => current.result.current.setSearchQuery('evidence'));
    await waitFor(() => {
      expect(current.result.current.searchHits.some(hit => hit.canvasId === current.home.id)).toBe(true);
      expect(current.result.current.searchHits.some(hit => hit.canvasId === current.other.id)).toBe(true);
    });
    act(() => current.result.current.navigateFromChat({ kind: 'group', canvasId: current.other.id, group: '__ungrouped', title: 'Other evidence' }));
    await waitFor(() => expect(current.result.current.canvas?.id).toBe(current.other.id));
    const other = current.other;
    act(() => current.result.current.requestDeleteWorkspace(current.result.current.workspaces.find(workspace => workspace.id === current.home.workspaceId)!));
    await act(async () => { await current.result.current.deleteWorkspace(); });
    expect(current.result.current.searchHits.length).toBeGreaterThan(0);
    expect(current.result.current.searchHits.every(hit => hit.canvasId === other.id)).toBe(true);
    act(() => current.result.current.returnFromChatNavigation());
    expect(current.result.current.canvasId).toBe(other.id);
    const fresh = await current.restarted();
    expect(await fresh.getCanvas(other.id, true)).toEqual(other);
    expect(current.result.current.canvas).toEqual(await fresh.getCanvasSummary(other.id));
  });
  it('removes a deleted canvas from persisted workspace navigation', async () => {
    const current = await fixture();
    act(() => current.result.current.requestDeleteCanvas(current.home.id, current.home.name, current.home.workspaceId));
    await act(async () => { await current.result.current.deleteCanvas(); });
    await waitFor(() => expect(current.result.current.canvas?.id).toBe(current.other.id));
    expect((await (await current.restarted()).listWorkspaces()).flatMap(workspace => workspace.canvases).some(canvas => canvas.id === current.home.id)).toBe(false);
  });
  it('deletes an inactive workspace while preserving the active canvas', async () => {
    const current = await fixture();
    act(() => current.result.current.requestDeleteWorkspace(current.result.current.workspaces.find(workspace => workspace.id === current.workspace.id)!));
    await act(async () => { await current.result.current.deleteWorkspace(); });
    expect(current.result.current.canvas?.id).toBe(current.home.id);
    expect((await (await current.restarted()).listWorkspaces()).map(workspace => workspace.id)).toEqual([current.home.workspaceId]);
  });
  it('clears deleted workspace research and navigation, selects the remaining workspace, then handles the last deletion', async () => {
    const current = await fixture(); const block = current.home.blocks[0];
    act(() => {
      current.result.current.addAnswerSources(1, { query: 'Research to clear', canvasId: current.home.id, selection: 'local', sources: [
        { canvasId: current.home.id, canvasName: current.home.name, blockId: block.id, title: block.title, excerpt: block.content, relevance: 1 },
      ] });
      current.result.current.updateAnswerText(1, '# Research to clear'); current.result.current.settleAnswerTurn(1, 'complete');
      current.result.current.setSearchOpen(true);
      current.result.current.setVisibleBlockIds([block.id]); current.result.current.selectedOnCanvas([block]);
    });
    act(() => current.result.current.requestDeleteWorkspace(current.result.current.workspaces.find(workspace => workspace.id === current.home.workspaceId)!));
    await act(async () => { await current.result.current.deleteWorkspace(); });
    await waitFor(() => expect(current.result.current.canvas?.id).toBe(current.other.id));
    expect(current.result.current).toMatchObject({ answerTurns: [], searchOpen: false, selectedBlockIds: [], visibleBlockIds: [], chatSession: 1 });
    act(() => current.result.current.requestDeleteWorkspace(current.result.current.workspaces[0]));
    await act(async () => { await current.result.current.deleteWorkspace(); });
    expect(current.result.current).toMatchObject({ canvasId: '', canvas: null, workspaces: [], chatSession: 2 });
    expect(await (await current.restarted()).listWorkspaces()).toEqual([]);
  });
  it('keeps another canvas intact when deleting an inactive canvas', async () => {
    const current = await fixture(); await current.select(current.other.id);
    const other = current.other;
    act(() => current.result.current.requestDeleteCanvas(current.home.id, current.home.name, current.home.workspaceId));
    await act(async () => { await current.result.current.deleteCanvas(); });
    expect(current.result.current.canvas?.id).toBe(other.id);
    const fresh = await current.restarted(); expect(await fresh.getCanvas(other.id, true)).toEqual(other);
    expect(current.result.current.canvas).toEqual(await fresh.getCanvasSummary(other.id));
    await expect(fresh.getCanvas(current.home.id)).rejects.toThrow('Canvas not found');
  });
  it.each([{ dialog: 'canvas', aba: false }, { dialog: 'workspace', aba: false }, { dialog: 'canvas', aba: true }] as const)
    ('keeps newer navigation and draft after an older $dialog creation returns (ABA: $aba)', async ({ dialog, aba }) => {
    const current = await fixture(); act(() => { current.result.current.openNamedDialog(dialog); current.result.current.setDraftName('Authorized older creation'); });
    const held = current.holdRequest((route, init) => init?.method === 'POST' && /\/workspaces\/[^/]+\/canvases$/.test(route));
    const creating = current.submit(); await held.entered;
    await current.select(current.other.id);
    if (aba) await current.select(current.home.id);
    act(() => { current.result.current.openNamedDialog('canvas'); current.result.current.setDraftName('Newer human draft'); });
    await act(async () => { held.release(); await creating; });
    const destination = aba ? current.home : current.other;
    expect(current.result.current.canvas?.id).toBe(destination.id);
    expect(current.result.current.dialog).toBe('canvas'); expect(current.result.current.draftName).toBe('Newer human draft');
    const fresh = await current.restarted();
    const list = await fresh.listWorkspaces();
    expect(dialog === 'workspace' ? list.some(workspace => workspace.name === 'Authorized older creation')
      : list.flatMap(workspace => workspace.canvases).some(canvas => canvas.name === 'Authorized older creation')).toBe(true);
    expect(await fresh.getCanvas(destination.id, true)).toEqual(destination);
    expect(current.result.current.canvas).toEqual(await fresh.getCanvasSummary(destination.id));
  });
  it('keeps a newer same-canvas form when a prior creation completes', async () => {
    const current = await fixture(); act(() => { current.result.current.openNamedDialog('canvas'); current.result.current.setDraftName('Older native creation'); });
    const held = current.holdRequest((route, init) => init?.method === 'POST' && /\/workspaces\/[^/]+\/canvases$/.test(route));
    const creating = current.submit(); await held.entered;
    act(() => { current.result.current.openNamedDialog('workspace'); current.result.current.setDraftName('Newer workspace draft'); });
    await act(async () => { held.release(); await creating; });
    expect(current.result.current).toMatchObject({ canvasId: current.home.id, dialog: 'workspace', draftName: 'Newer workspace draft' });
    expect((await (await current.restarted()).listWorkspaces()).flatMap(workspace => workspace.canvases).some(canvas => canvas.name === 'Older native creation')).toBe(true);
  });
  it('persists an authorized creation after unmount and leaves reload on the original canvas', async () => {
    const current = await fixture(); act(() => { current.result.current.openNamedDialog('canvas'); current.result.current.setDraftName('Creation after unmount'); });
    const held = current.holdRequest((route, init) => init?.method === 'POST' && /\/workspaces\/[^/]+\/canvases$/.test(route));
    const creating = current.submit(); await held.entered; current.unmount();
    await act(async () => { held.release(); await creating; });
    expect((await (await current.restarted()).listWorkspaces()).flatMap(workspace => workspace.canvases).some(canvas => canvas.name === 'Creation after unmount')).toBe(true);
    const remounted = renderHook(useAppModel); await waitFor(() => expect(remounted.result.current.canvas?.id).toBe(current.home.id));
  });
});
