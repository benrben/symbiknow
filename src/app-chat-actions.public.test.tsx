// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import { DocumentVersions } from '../server/version-control';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { useAppModel } from './app-model';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root: string }> = [];
type Intercept = (route: string, init?: RequestInit) => Promise<Response> | Response | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-chat-actions-'));
  const store = new CanvasStore(root); await store.init();
  await store.createCanvas((await store.listWorkspaces())[0].id, { name: 'Another native canvas' });
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native fixture port');
  const base = `http://127.0.0.1:${address.port}`;
  let intercept: Intercept | undefined;
  const requests: Array<{ route: string; method: string; cache: RequestCache | undefined }> = [];
  vi.stubGlobal('fetch', (route: string, init?: RequestInit) => {
    requests.push({ route, method: init?.method ?? 'GET', cache: init?.cache });
    return intercept?.(route.replace('?summary=1', ''), init) ?? nativeFetch(base + route, init);
  });
  const hook = renderHook(useAppModel);
  await waitFor(() => expect(hook.result.current.canvas?.id).toBe('product-roadmap'));
  const canvas = await store.getCanvas('product-roadmap');
  async function write(route: string, body: unknown, method = 'PUT') {
    const response = await nativeFetch(base + '/api' + route, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return response.json();
  }
  const read = async (id = canvas.id): Promise<CanvasDocument> => {
    const response = await nativeFetch(base + '/api/canvases/' + id);
    expect(response.status).toBe(200); return response.json();
  };
  const restart = async () => { const fresh = new CanvasStore(root); await fresh.init(); return fresh.getCanvas(canvas.id, true); };
  const request = (route: string, init?: RequestInit) => nativeFetch(base + '/api' + route, init);
  return { ...hook, root, base, canvas, store, requests, read, write, restart, request, intercept: (next?: Intercept) => { intercept = next; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function holdUndoRead(current: Fixture) {
  const entered = deferred<void>(); const release = deferred<void>();
  // Hold the actual atomic Undo request before it reaches the native guard;
  // independent human writes still use the real server while this is queued.
  current.intercept((route, init) => {
    if (route !== `/api/canvases/${current.canvas.id}/jev/undo-parent` || init?.method !== 'POST') return;
    entered.resolve(); return release.promise.then(() => nativeFetch(current.base + route, init));
  });
  return { entered: entered.promise, release: () => release.resolve() };
}
async function createdBlock(current: Fixture): Promise<CanvasBlock> {
  return current.write('/canvases/' + current.canvas.id + '/blocks', { title: 'Agent finding', content: '# Agent finding\nOriginal evidence' }, 'POST');
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/?canvas=product-roadmap'); });
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('agent Undo through actual App actions, HTTP and the durable store', () => {
  it('uses full fresh edit snapshots for receipts and Undo while refreshing canvas metadata separately', async () => {
    const current = await fixture(); const before = current.canvas.blocks[0];
    const after = await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`,
      { title: 'Agent revised roadmap', content: '# Agent revised roadmap\nFreshly saved evidence' }) as CanvasBlock;
    let changes!: Awaited<ReturnType<typeof current.result.current.refreshCanvasAfterChat>>;

    await act(async () => { changes = await current.result.current.refreshCanvasAfterChat(current.canvas.id, current.canvas.blocks); });

    expect(changes).toEqual({ created: [], updated: [{ before, after }] });
    expect(current.requests).toContainEqual({ route: '/api/canvases/' + current.canvas.id, method: 'GET', cache: 'no-store' });
    expect(current.requests).toContainEqual({ route: '/api/canvases/' + current.canvas.id + '?summary=1', method: 'GET', cache: 'no-store' });
    expect(current.result.current.canvas?.blocks.find(block => block.id === before.id)).toMatchObject({ title: after.title, content: '', contentLoaded: false });
    await act(async () => { await current.result.current.undoAgentEditedBlock(current.canvas.id, changes.updated[0]); });
    expect((await current.restart()).blocks.find(block => block.id === before.id)).toMatchObject({ title: before.title, content: before.content, contentHash: before.contentHash });
  });
  it('offers complete creation receipts and omits unsafe edits when original bodies were not loaded', async () => {
    const current = await fixture(); const before = current.result.current.canvas!.blocks;
    expect(before.every(block => block.contentLoaded === false && block.content === '')).toBe(true);
    await current.write(`/canvases/${current.canvas.id}/blocks/${before[0].id}`,
      { title: 'Agent revised an unloaded document', content: '# Saved edit must never be undone to an empty placeholder' });
    const created = await createdBlock(current);
    let changes!: Awaited<ReturnType<typeof current.result.current.refreshCanvasAfterChat>>;

    await act(async () => { changes = await current.result.current.refreshCanvasAfterChat(current.canvas.id, before); });

    expect(changes).toEqual({ created: [created], updated: [] });
    expect(changes.created[0].content).toContain('Original evidence');
    await act(async () => { await current.result.current.undoAgentCreatedBlock(current.canvas.id, changes.created[0]); });
    const saved = await current.restart();
    expect(saved.blocks.find(block => block.id === before[0].id)?.content).toBe('# Saved edit must never be undone to an empty placeholder');
    expect(saved.blocks.some(block => block.id === created.id)).toBe(false);
  });
  it('reports no edits from an unchanged metadata-only original snapshot', async () => {
    const current = await fixture(); const before = current.result.current.canvas!.blocks;
    let changes!: Awaited<ReturnType<typeof current.result.current.refreshCanvasAfterChat>>;
    await act(async () => { changes = await current.result.current.refreshCanvasAfterChat(current.canvas.id, before); });
    expect(changes).toEqual({ created: [], updated: [] });
    expect(await current.restart()).toEqual(current.canvas);
  });
  it.each([false, true])('deletes an unchanged creation and records native history (legacy snapshot: %s)', async legacy => {
    const current = await fixture(); const created = await createdBlock(current);
    const snapshot = legacy ? { ...created, contentHash: undefined } : created;
    await act(async () => { await current.result.current.undoAgentCreatedBlock(current.canvas.id, snapshot); });
    expect((await current.restart()).blocks.some(block => block.id === created.id)).toBe(false);
    expect(current.result.current.canvas!.blocks.some(block => block.id === created.id)).toBe(false);
    const history = await new DocumentVersions(path.join(current.root, '.versions', created.id)).status();
    expect(history.commits[0].message).toBe(`Delete ${created.title} from canvas ${current.canvas.name}`);
    expect(history.commits[0].author).toBe('Browser');
  });
  it.each(['already deleted', 'changed content', 'new incoming reference'])('refuses to delete a creation that is %s', async reason => {
    const current = await fixture(); const created = await createdBlock(current);
    if (reason === 'already deleted') expect((await current.request(`/canvases/${current.canvas.id}/blocks/${created.id}`, { method: 'DELETE' })).ok).toBe(true);
    if (reason === 'changed content') await current.write(`/canvases/${current.canvas.id}/blocks/${created.id}`, { content: '# Later human edit' });
    if (reason === 'new incoming reference') await current.write(`/canvases/${current.canvas.id}/blocks/launch-checklist`, { links: [created.id] });
    const before = await current.restart();
    await act(async () => { await expect(current.result.current.undoAgentCreatedBlock(current.canvas.id, created)).rejects.toThrow(/gone|changed|reference/); });
    expect(await current.restart()).toEqual(before);
  });
  it.each([false, true])('restores an agent edit with saved labels and defaults (rich metadata: %s)', async rich => {
    const current = await fixture(); let before = await createdBlock(current);
    const [first, second] = current.canvas.blocks;
    if (rich) before = await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`, {
      tags: ['reviewed'], archived: true, stale: true, purpose: 'guide', reviewer: 'Owner', workArea: 'Delivery', group: 'custom:delivery',
      links: [first.id, second.id], linkTypes: { [second.id]: 'related', [first.id]: 'implements' },
      crossLinks: [],
    }) as CanvasBlock;
    const after = await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`, {
      content: '# Agent edit', title: 'Agent updated title', archived: false, stale: false, tags: ['agent'], purpose: 'plan', reviewer: 'Agent',
      workArea: 'New area', group: 'custom:agent', links: [], linkTypes: {},
    }) as CanvasBlock;
    await act(async () => { await current.result.current.undoAgentEditedBlock(current.canvas.id, { before, after }); });
    const restored = (await current.restart()).blocks.find(block => block.id === before.id)!;
    expect(restored).toMatchObject({ title: before.title, content: before.content, contentHash: before.contentHash,
      x: before.x, y: before.y, width: before.width, height: before.height, links: before.links,
      archived: before.archived ?? false, stale: before.stale ?? false, tags: before.tags ?? [] });
    expect(restored.reviewer).toBe(before.reviewer);
    expect(restored.group).toBe(before.group);
    expect((await current.store.documentHistory(current.canvas.id, before.id)).commits[0].message).toBe(`Undo agent edit to ${before.title}`);
  });
  it.each(['deleted', 'metadata changed', 'unreviewed hash', 'quality changed'])('preserves history when an edited document is %s', async reason => {
    const current = await fixture(); const before = await createdBlock(current);
    let after = await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`, {
      content: '# Agent edit', ...(reason === 'quality changed' ? { quality: { score: .8, at: '2026-10-01T12:00:00.000Z' } } : {}),
    }) as CanvasBlock;
    if (reason === 'deleted') expect((await current.request(`/canvases/${current.canvas.id}/blocks/${before.id}`, { method: 'DELETE' })).ok).toBe(true);
    if (reason === 'metadata changed') await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`, { tags: ['human'] });
    if (reason === 'unreviewed hash') after = { ...after, contentHash: undefined };
    const saved = await current.restart();
    await act(async () => { await expect(current.result.current.undoAgentEditedBlock(current.canvas.id, { before, after })).rejects.toThrow(/review|quality|changed/i); });
    expect(await current.restart()).toEqual(saved);
  });
  it.each(['untouched', 'legacy draft', 'title', 'kind', 'content', 'hash', 'new document', 'not in original snapshot', 'unloaded original snapshot', 'deleted'])
    ('refreshes agent changes while preserving a %s editor draft', async mode => {
      const current = await fixture(); const original = await createdBlock(current); const before = await current.read();
      await act(async () => { await current.result.current.openBlock(original); });
      if (mode === 'new document') act(() => current.result.current.openNewBlock());
      if (mode === 'legacy draft') act(() => current.result.current.setDraftBlock(draft => ({ ...draft, contentHash: undefined })));
      if (['title', 'kind', 'content', 'hash'].includes(mode)) act(() => current.result.current.setDraftBlock(draft => ({ ...draft,
        ...(mode === 'title' ? { title: 'Unsaved human title' } : {}), ...(mode === 'kind' ? { kind: 'slides' } : {}),
        ...(mode === 'content' ? { content: '# Unsaved human notes' } : {}), ...(mode === 'hash' ? { contentHash: 'newer-review' } : {}),
      })));
      const draft = current.result.current.draftBlock;
      if (mode === 'deleted') expect((await current.request(`/canvases/${current.canvas.id}/blocks/${original.id}`, { method: 'DELETE' })).ok).toBe(true);
      else await current.write(`/canvases/${current.canvas.id}/blocks/${original.id}`, { title: 'Agent improved title', content: '# Agent improved content' });
      const created = await createdBlock(current); let changes!: Awaited<ReturnType<typeof current.result.current.refreshCanvasAfterChat>>;
      let snapshot = before.blocks;
      if (mode === 'not in original snapshot') snapshot = snapshot.filter(block => block.id !== original.id);
      if (mode === 'unloaded original snapshot') snapshot = snapshot.map(block => ({ ...block, content: '', contentHash: undefined, contentLoaded: false }));
      await act(async () => { changes = await current.result.current.refreshCanvasAfterChat(current.canvas.id, snapshot); });
      expect(changes.created.map(block => block.id)).toContain(created.id);
      if (mode === 'untouched' || mode === 'legacy draft') expect(current.result.current.draftBlock).toMatchObject({ id: original.id, title: 'Agent improved title', content: '# Agent improved content' });
      else expect(current.result.current.draftBlock).toEqual(draft);
      expect((await current.restart()).blocks.find(block => block.id === created.id)).toEqual(created);
    });
  it('handles an empty canvas id, current native read failure, and repaired retry', async () => {
    const current = await fixture(); let changes!: Awaited<ReturnType<typeof current.result.current.refreshCanvasAfterChat>>;
    await act(async () => { changes = await current.result.current.refreshCanvasAfterChat('', current.canvas.blocks); });
    expect(changes).toEqual({ created: [], updated: [] });
    const file = path.join(current.root, 'canvases', current.canvas.id + '.json'); const saved = await readFile(file, 'utf8');
    await writeFile(file, '{broken');
    await act(async () => { changes = await current.result.current.refreshCanvasAfterChat(current.canvas.id, current.canvas.blocks); });
    expect(changes).toEqual({ created: [], updated: [] }); expect(current.result.current.error).not.toBe('');
    await writeFile(file, saved);
    await act(async () => { changes = await current.result.current.refreshCanvasAfterChat(current.canvas.id, current.canvas.blocks); });
    expect(changes).toEqual({ created: [], updated: [] });
    expect(current.result.current.canvas!.id).toBe(current.canvas.id);
  });
  it('opens chat with ordered selection context and advances each public prompt sequence', async () => {
    const current = await fixture(); const blocks = current.canvas.blocks.slice(0, 2);
    act(() => { current.result.current.setShowChat(false); current.result.current.setAssistantView('reflex'); });
    act(() => current.result.current.summarizeSelection(blocks));
    expect(current.result.current.showChat).toBe(true); expect(current.result.current.assistantView).toBe('chat');
    expect(current.result.current.chatPromptRequest).toEqual({ sequence: 1,
      text: `Summarize these selected canvas documents together: ${blocks.map(block => `${block.title} (${block.id})`).join(', ')}. Read each document, identify shared themes, differences, and source links. Do not edit the canvas.` });
    act(() => current.result.current.summarizeSelection([]));
    expect(current.result.current.chatPromptRequest!.sequence).toBe(2);
    expect(current.result.current.chatPromptRequest!.text).toContain('together: . Read each document');
    expect(await current.restart()).toEqual(await current.read());
  });
  it.each(['another canvas', 'the same canvas after navigating away'])('does not publish an old refresh failure on %s', async destination => {
    const current = await fixture(); const entered = deferred<void>(); const release = deferred<void>(); let held = false;
    current.intercept((route, init) => {
      if (held || route !== '/api/canvases/' + current.canvas.id || init?.method) return;
      held = true; entered.resolve();
      return release.promise.then(() => nativeFetch(current.base + route, init));
    });
    let refresh!: ReturnType<typeof current.result.current.refreshCanvasAfterChat>;
    act(() => { refresh = current.result.current.refreshCanvasAfterChat(current.canvas.id, current.canvas.blocks); });
    await entered.promise;
    const other = current.result.current.workspaces.flatMap(workspace => workspace.canvases).find(canvas => canvas.id !== current.canvas.id)!;
    act(() => current.result.current.selectCanvas(other.id));
    await waitFor(() => expect(current.result.current.canvas?.id).toBe(other.id));
    if (destination !== 'another canvas') {
      act(() => current.result.current.selectCanvas(current.canvas.id));
      await waitFor(() => expect(current.result.current.canvas?.id).toBe(current.canvas.id));
    }
    act(() => { current.result.current.openNewBlock(); current.result.current.setError('Current form needs a title'); });
    expect((await current.request('/canvases/' + current.canvas.id, { method: 'DELETE' })).ok).toBe(true);
    release.resolve(); await act(async () => { expect(await refresh).toEqual({ created: [], updated: [] }); });
    expect(current.result.current.error).toBe('Current form needs a title');
    expect(current.result.current.dialog).toBe('block');
    expect(current.result.current.draftBlock.title).toBe('Untitled note');
  });
  it.each([
    { name: 'tags', patch: { tags: ['human-reviewed'] } },
    { name: 'position', patch: { x: 999, y: 888 } },
    { name: 'classification', patch: { purpose: 'guide', reviewer: 'Review owner', group: 'custom:human-review' } },
  ])('retains an existing human $name change before Undo starts', async ({ patch }) => {
    const current = await fixture(); const created = await createdBlock(current);
    const changed = await current.write(`/canvases/${current.canvas.id}/blocks/${created.id}`, patch) as CanvasBlock;
    let failure: Error | null = null;
    await act(async () => { failure = await current.result.current.undoAgentCreatedBlock(current.canvas.id, created).then(() => null, error => error); });
    expect((await current.restart()).blocks.find(block => block.id === created.id)).toEqual(changed);
    expect(failure).toBeInstanceOf(Error);
  });
  it.each([
    { name: 'content', patch: { content: '# Human evidence added after Undo started' } },
    { name: 'title', patch: { title: 'Human reviewed finding' } },
    { name: 'tags', patch: { tags: ['human-reviewed'] } },
    { name: 'outgoing link', patch: { links: ['launch-checklist'] } },
  ])('retains a simultaneous human $name edit made after the Undo preflight read', async ({ patch }) => {
    const current = await fixture(); const created = await createdBlock(current); const read = holdUndoRead(current);
    let outcome!: Promise<Error | null>;
    act(() => { outcome = current.result.current.undoAgentCreatedBlock(current.canvas.id, created).then(() => null, failure => failure); });
    await read.entered;
    const changed = await current.write(`/canvases/${current.canvas.id}/blocks/${created.id}`, patch) as CanvasBlock;
    read.release(); let failure: Error | null = null; await act(async () => { failure = await outcome; });
    expect((await current.restart()).blocks.find(block => block.id === created.id)).toEqual(changed);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toMatch(/changed|review/i);
  });
  it('retains a new incoming reference created after the Undo preflight read', async () => {
    const current = await fixture(); const created = await createdBlock(current); const read = holdUndoRead(current);
    const source = current.canvas.blocks.find(block => block.id === 'launch-checklist')!;
    let outcome!: Promise<Error | null>;
    act(() => { outcome = current.result.current.undoAgentCreatedBlock(current.canvas.id, created).then(() => null, failure => failure); });
    await read.entered;
    const linked = await current.write(`/canvases/${current.canvas.id}/blocks/${source.id}`, { links: [...source.links, created.id] }) as CanvasBlock;
    read.release(); let failure: Error | null = null; await act(async () => { failure = await outcome; });
    const saved = await current.restart();
    expect(saved.blocks.find(block => block.id === created.id)).toEqual(created);
    expect(saved.blocks.find(block => block.id === source.id)).toEqual(linked);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toMatch(/reference|review/i);
  });
  it('retains a creation referenced by a saved document on another canvas', async () => {
    const current = await fixture(); const created = await createdBlock(current);
    const other = current.result.current.workspaces.flatMap(workspace => workspace.canvases).find(canvas => canvas.id !== current.canvas.id)!;
    const source = await current.write(`/canvases/${other.id}/blocks`, { title: 'Cross-canvas evidence', content: '# Evidence' }, 'POST') as CanvasBlock;
    const linked = await current.write(`/canvases/${other.id}/blocks/${source.id}`, { crossLinks: [{ canvasId: current.canvas.id, blockId: created.id }] }) as CanvasBlock;
    let failure: Error | null = null;
    await act(async () => { failure = await current.result.current.undoAgentCreatedBlock(current.canvas.id, created).then(() => null, error => error); });
    expect((await current.restart()).blocks.find(block => block.id === created.id)).toEqual(created);
    expect((await current.read(other.id)).blocks.find(block => block.id === source.id)).toEqual(linked);
    expect(failure).toBeInstanceOf(Error);
  });
  it.each(['creation', 'edit'])('retains a later saved outgoing reference whose target is archived during %s Undo', async mode => {
    const current = await fixture(); const before = await createdBlock(current);
    const after = mode === 'edit' ? await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`, { content: '# Agent edit' }) as CanvasBlock : before;
    const other = current.result.current.workspaces.flatMap(workspace => workspace.canvases).find(canvas => canvas.id !== current.canvas.id)!;
    const target = await current.write(`/canvases/${other.id}/blocks`, { title: 'Retained destination', content: '# Retained evidence' }, 'POST') as CanvasBlock;
    const read = holdUndoRead(current); let outcome!: Promise<Error | null>;
    act(() => { outcome = (mode === 'edit'
      ? current.result.current.undoAgentEditedBlock(current.canvas.id, { before, after })
      : current.result.current.undoAgentCreatedBlock(current.canvas.id, after)).then(() => null, error => error); });
    await read.entered;
    const links = [{ canvasId: other.id, blockId: target.id, relation: 'related' }];
    await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`, { crossLinks: links });
    await current.write(`/canvases/${other.id}/blocks/${target.id}`, { archived: true });
    read.release(); let failure: Error | null = null; await act(async () => { failure = await outcome; });
    const raw = JSON.parse(await readFile(path.join(current.root, 'canvases', current.canvas.id + '.json'), 'utf8'));
    expect(raw.blocks.find((block: CanvasBlock) => block.id === before.id)?.crossLinks).toEqual(links);
    expect(failure).toBeInstanceOf(Error);
    await current.write(`/canvases/${other.id}/blocks/${target.id}`, { archived: false });
    expect((await current.restart()).blocks.find(block => block.id === before.id)).toMatchObject({ content: after.content, crossLinks: links });
  });
  it.each([{ name: 'tags', patch: { tags: ['human-reviewed'] } }, { name: 'position', patch: { x: 990, y: 880 } }])
    ('retains a simultaneous human $name change during edit Undo', async ({ patch }) => {
      const current = await fixture(); const before = await createdBlock(current);
      const after = await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`, { content: '# Agent edit' }) as CanvasBlock;
      const read = holdUndoRead(current); let outcome!: Promise<Error | null>;
      act(() => { outcome = current.result.current.undoAgentEditedBlock(current.canvas.id, { before, after }).then(() => null, failure => failure); });
      await read.entered;
      const changed = await current.write(`/canvases/${current.canvas.id}/blocks/${before.id}`, patch) as CanvasBlock;
      read.release(); let failure: Error | null = null; await act(async () => { failure = await outcome; });
      expect((await current.restart()).blocks.find(block => block.id === before.id)).toEqual(changed);
      expect(failure).toBeInstanceOf(Error);
    });
});
