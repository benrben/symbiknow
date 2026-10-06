// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import type { CanvasDocument } from '../shared/types';
import { useAppModel } from './app-model';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root: string }> = [];
type Intercept = (route: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function file(name: string, text: () => Promise<string> = async () => '# ' + name) {
  const result = new File([], name); Object.defineProperty(result, 'text', { value: text }); return result;
}
function files(...values: File[]) { return values as unknown as FileList; }
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-intake-actions-'));
  const store = new CanvasStore(root); await store.init();
  const canvas = await store.getCanvas('product-roadmap');
  const other = await store.createCanvas(canvas.workspaceId!, { name: 'Other upload canvas' });
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  const base = `http://127.0.0.1:${address.port}`;
  let intercept: Intercept | undefined;
  const requests: Array<{ route: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', (route: string, init?: RequestInit) => {
    requests.push({ route, init }); const intercepted = intercept?.(route.replace('?summary=1', ''), init); if (intercepted) return intercepted;
    return nativeFetch(base + route, init);
  });
  const hook = renderHook(useAppModel);
  await waitFor(() => expect(hook.result.current.canvas?.id).toBe(canvas.id));
  const read = (id = canvas.id) => nativeFetch(base + '/api/canvases/' + id).then(response => response.json()) as Promise<CanvasDocument>;
  const restart = async () => { const fresh = new CanvasStore(root); await fresh.init(); return fresh.getCanvas(canvas.id); };
  const upload = async (...values: File[]) => act(async () => { await hook.result.current.uploadFiles(files(...values)); });
  return { ...hook, root, base, canvas, other, requests, read, restart, upload, intercept: (next?: Intercept) => { intercept = next; } };
}
beforeEach(() => { localStorage.clear(); window.history.replaceState(null, '', '/?canvas=product-roadmap'); });
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('public App direct uploads through native HTTP and disk', () => {
  it('persists direct uploads without reopening an old canvas after navigation', async () => {
    const { result, other, restart } = await fixture(); const release = deferred<string>();
    let pending!: Promise<void>; act(() => { pending = result.current.uploadFiles(files(file('Direct.md', () => release.promise))); });
    act(() => result.current.navigateTo({ canvasId: other.id, canvasName: other.name }));
    release.resolve('# Direct'); await act(async () => { await pending; });
    expect(result.current.canvasId).toBe(other.id); expect((await restart()).blocks.find(block => block.title === 'Direct')?.content).toBe('# Direct');
  });

  it('persists every direct-upload file and safely handles an empty direct batch', async () => {
    const { upload, restart, canvas } = await fixture(); await upload(); expect(await restart()).toEqual(canvas);
    await upload(file('One.md'), file('Two.mdx')); expect((await restart()).blocks.filter(block => ['One', 'Two'].includes(block.title)).map(block => block.kind)).toEqual(['markdown', 'mdx']);
  });

  it('leaves newer navigation in control when the uploaded canvas refresh returns later', async () => {
    const owner = await fixture();
    const arrived = deferred<Response>();
    const release = deferred<Response>();
    owner.intercept((route, init) => {
      if (route !== '/api/canvases/' + owner.canvas.id || init?.method) return;
      owner.intercept();
      void nativeFetch(owner.base + route, init).then(response => arrived.resolve(response));
      return release.promise;
    });
    let pending!: Promise<void>;
    act(() => { pending = owner.result.current.uploadFiles(files(file('While refreshing.md'))); });
    const response = await arrived.promise;
    expect(response.status).toBe(200);
    act(() => owner.result.current.navigateTo({ canvasId: owner.other.id, canvasName: owner.other.name }));
    await waitFor(() => expect(owner.result.current.canvas?.id).toBe(owner.other.id));
    release.resolve(response);
    await act(async () => { await pending; });
    expect(owner.result.current.canvasId).toBe(owner.other.id);
    expect(owner.result.current.focusRequest).toBeNull();
    expect((await owner.restart()).blocks.find(block => block.title === 'While refreshing')?.content).toBe('# While refreshing.md');
    expect(await owner.read()).toEqual(await owner.restart());
  });

  it('reports an unreadable file and allows a fresh direct upload without calling semantic actions', async () => {
    const { result, upload, requests, restart } = await fixture();
    await upload(file('Broken.md', async () => { throw new Error('File unavailable'); }));
    expect(result.current.error).toBe('File unavailable');
    await upload(file('Recovered.md')); expect(result.current.error).toBe('');
    expect((await restart()).blocks.find(block => block.title === 'Recovered')?.content).toBe('# Recovered.md');
    expect(requests.some(({ route }) => /intake|insights|automations|rank=/.test(route))).toBe(false);
  });
});
