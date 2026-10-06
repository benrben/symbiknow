// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CanvasStore } from '../server/storage';
import { createApiServer } from '../server/index';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { CanvasProps } from './canvas-types';
import { api } from './api';
import { camera, installCanvasBrowser, instance, mount, props, run, state } from './canvas-model.test.helpers';

const nativeFetch = globalThis.fetch;
const opened: { root: string; server: Server }[] = [];
installCanvasBrowser();
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { root, server } of opened.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-canvas-model-'));
  const store = new CanvasStore(root);
  await store.init();
  const created = await store.createCanvas('acme-team', { name: 'Persisted canvas model' });
  const a = await store.createBlock(created.id, { title: 'Source', content: '# Source\n- [ ] Evidence checked', x: 100, y: 200, group: 'custom:launch' });
  const b = await store.createBlock(created.id, { title: 'Target', content: '# Target\nOriginal evidence', x: 900, y: 200, group: 'custom:launch' });
  const server = await createApiServer({ dataDir: root });
  opened.push({ root, server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const base = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => nativeFetch(String(input).startsWith('/api/') ? base + String(input) : input, init));
  return { root, store, a, b, base, created, original: await store.getCanvas(created.id) };
}

it('writes checkbox content, dimensions, drop positions, links and per-block layouts through HTTP and verifies disk, Git, store and reload', async () => {
  const value = await fixture();
  let document = value.original;
  async function update(id: string, patch: Partial<CanvasBlock>) {
    await api('/canvases/' + document.id + '/blocks/' + id, { method: 'PUT', body: JSON.stringify(patch) });
    document = await api<CanvasDocument>('/canvases/' + document.id);
    ui.change({ canvasProps: current() });
  }
  function current(): CanvasProps {
    return {
      ...props(document), onUpdateBlock: update, onDeleteBlock: async id => {
        await api('/canvases/' + document.id + '/blocks/' + id, { method: 'DELETE' });
        document = await api<CanvasDocument>('/canvases/' + document.id);
        ui.change({ canvasProps: current() });
      }
    };
  }
  const ui = mount({ canvasProps: current() });
  fireEvent.click(await screen.findByRole('checkbox'));
  await waitFor(async () => expect((await new CanvasStore(value.root).getCanvas(document.id)).blocks[0].content).toContain('- [x] Evidence checked'));
  expect((await value.store.documentHistory(document.id, value.a.id)).commits.length).toBeGreaterThan(1);
  expect(await readFile(path.join(value.root, value.a.file), 'utf8')).toContain('- [x] Evidence checked');
  ui.change({ canvasProps: current(), action: model => model.nodes[0].data.onResize(value.a.id, { width: 550, height: 330 }) });
  run();
  await waitFor(async () => expect((await new CanvasStore(value.root).getCanvas(document.id)).blocks[0]).toMatchObject({ width: 550, height: 330 }));
  ui.change({ canvasProps: current(), action: model => model.dropBlock({ ...model.nodes[0], position: { x: 780, y: 230 } }) });
  run();
  await waitFor(async () => expect((await new CanvasStore(value.root).getCanvas(document.id)).blocks[0]).toMatchObject({ x: 780, y: 230, group: 'custom:launch' }));
  ui.change({ canvasProps: current(), action: model => model.connect({ source: value.a.id, target: value.b.id, sourceHandle: null, targetHandle: null }) });
  run();
  await waitFor(async () => expect((await new CanvasStore(value.root).getCanvas(document.id)).blocks[0].links).toEqual([value.b.id]));
  run();
  expect((await value.store.getCanvas(document.id)).blocks[0].links).toEqual([value.b.id]);
  ui.change({ canvasProps: current(), action: model => model.deleteEdges([{ id: 'group-edge:ignored', source: value.a.id, target: value.b.id }, { id: value.a.id + '->' + value.b.id, source: value.a.id, target: value.b.id }, { id: 'obsolete', source: 'removed', target: value.b.id }]) });
  run();
  await waitFor(async () => expect((await new CanvasStore(value.root).getCanvas(document.id)).blocks[0].links).toEqual([]));
  const saved = await new CanvasStore(value.root).getCanvas(document.id);
  expect(saved.blocks.map(block => ({ id: block.id, x: block.x, y: block.y }))).toEqual([{ id: value.a.id, x: 780, y: 230 }, { id: value.b.id, x: 900, y: 200 }]);
  ui.unmount();
  mount({ canvasProps: props(saved) });
  expect(state().nodes.filter(node => node.id === value.a.id)[0].position).toEqual({ x: 780, y: 230 });
  expect(await api<CanvasDocument>('/canvases/' + saved.id)).toEqual(saved);
});

it('keeps a failed native delete on disk and in the renderer, then clears the failure when retrying the persisted delete', async () => {
  const value = await fixture();
  let document = value.original;
  let fail = true;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE' && fail) {
      fail = false;
      return Promise.resolve(Response.json({ error: 'Delete temporarily unavailable' }, { status: 503 }));
    }
    return nativeFetch(value.base + String(input), init);
  });
  function current(): CanvasProps {
    return {
      ...props(document), onDeleteBlock: async id => {
        await api('/canvases/' + document.id + '/blocks/' + id, { method: 'DELETE' });
        document = await api<CanvasDocument>('/canvases/' + document.id);
        ui.change({ canvasProps: current() });
      }
    };
  }
  const ui = mount({ canvasProps: current() });
  await camera({ x: 0, y: 0, zoom: 1 });
  await act(async () => { await instance().deleteElements({ nodes: [{ id: value.a.id }] }); });
  expect(screen.getByRole('alert').textContent).toContain('Could not delete: Delete temporarily unavailable');
  expect((await new CanvasStore(value.root).getCanvas(document.id)).blocks).toEqual(value.original.blocks);
  expect(instance().getNode(value.a.id)).toBeTruthy();
  await act(async () => { await instance().deleteElements({ nodes: [{ id: value.a.id }] }); });
  await waitFor(() => expect(instance().getNode(value.a.id)).toBeUndefined());
  expect(screen.queryByRole('alert')).toBeNull();
  expect((await new CanvasStore(value.root).getCanvas(document.id)).blocks.map(block => block.id)).toEqual([value.b.id]);
});

it.each(['save', 'save-return', 'move', 'delete'] as const)('ignores a held %s failure after visiting another real canvas', async operation => {
  const value = await fixture();
  const destination = await value.store.createCanvas('acme-team', { name: 'Destination canvas' });
  const target = await value.store.createBlock(destination.id, { title: 'Destination evidence', content: '# Destination evidence' });
  const other = await value.store.getCanvas(destination.id);
  let release: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT' || init?.method === 'DELETE') return new Promise<Response>(resolve => { release = resolve; });
    return nativeFetch(value.base + String(input), init);
  });
  const current = {
    ...props(value.original), onUpdateBlock: async (id: string, patch: Partial<CanvasBlock>) => {
      await api('/canvases/' + value.original.id + '/blocks/' + id, { method: 'PUT', body: JSON.stringify(patch) });
    }, onMoveBlocks: async (positions: Parameters<NonNullable<CanvasProps['onMoveBlocks']>>[0]) => {
      await api('/canvases/' + value.original.id + '/layout', { method: 'PUT', body: JSON.stringify({ positions }) });
    }, onDeleteBlock: async (id: string) => { await api('/canvases/' + value.original.id + '/blocks/' + id, { method: 'DELETE' }); }
  };
  const ui = mount({
    canvasProps: current, action: async model => {
      if (operation === 'save' || operation === 'save-return') await model.saveBlock(value.a.id, { title: 'Pending title' }).catch(() => undefined);
      if (operation === 'move') model.saveGroupMove('group:custom:launch');
      if (operation === 'delete') await model.beforeDelete({ nodes: model.nodes.slice(0, 1), edges: [] });
    }
  });
  if (operation === 'save' || operation === 'save-return') fireEvent.click(await screen.findByRole('checkbox'));
  else run();
  await waitFor(() => expect(release).toBeTypeOf('function'));
  ui.change({ canvasProps: { ...current, canvas: other } });
  expect(state().nodes.some(node => node.id === target.id)).toBe(true);
  if (operation === 'save-return') ui.change({ canvasProps: current });
  await act(async () => { release!(Response.json({ error: 'Previous canvas operation failed' }, { status: 503 })); });
  await waitFor(() => expect(state().nodes.some(node => node.id === (operation === 'save-return' ? value.a.id : target.id))).toBe(true));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(await new CanvasStore(value.root).getCanvas(value.original.id)).toEqual(value.original);
  expect(await new CanvasStore(value.root).getCanvas(destination.id)).toEqual(other);
});
