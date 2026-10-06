// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import type { CanvasBlock } from '../shared/types';
import { App } from './App';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root: string }> = [];
const token = 'native-browser-fixture-access-token';
let native: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', token); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  localStorage.clear(); window.history.replaceState(null, '', '/?canvas=product-roadmap');
  localStorage.setItem('symbiknow.theme', 'dark');
  // ReactFlow reads the CSS transform's scale; jsdom has no CSS matrix constructor.
  vi.stubGlobal('DOMMatrixReadOnly', class {
    readonly m22: number;
    constructor(transform: string) {
      const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
      const scale = /scale\(([^)]+)\)/.exec(transform);
      this.m22 = matrix ? Number(matrix[1].split(',')[3]) : scale ? Number(scale[1].split(',').at(-1)) : 1;
    }
  });
  vi.stubGlobal('ResizeObserver', class {
    private targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target);
      queueMicrotask(() => { if (this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver); });
    }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  });
  native = await fixture();
});
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-auth-browser-'));
  const store = new CanvasStore(root); await store.init();
  for (const block of (await store.getCanvas('product-roadmap')).blocks) await store.deleteBlock('product-roadmap', block.id);
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = ''; let hold: Promise<void> | undefined; let failSession = false;
  let saveHold: Promise<void> | undefined;
  let resolveSaved!: (value: { status: number; block: CanvasBlock }) => void;
  const savedBlock = new Promise<{ status: number; block: CanvasBlock }>(resolve => { resolveSaved = resolve; });
  const sessionRequests: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = String(input); const headers = new Headers(init?.headers); if (cookie) headers.set('cookie', cookie);
    if (route === '/api/session' && init?.method === 'POST') {
      sessionRequests.push(String(init.body));
      if (failSession) return Response.json({ error: 'Session server unavailable' }, { status: 503 });
    }
    const response = await nativeFetch(route.startsWith('/api/') ? base + route : input, { ...init, headers });
    if (route === '/api/session' && init?.method === 'POST') {
      if (hold) await hold;
      const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0];
    }
    if (route === '/api/canvases/product-roadmap/blocks' && init?.method === 'POST') {
      resolveSaved({ status: response.status, block: await response.clone().json() as CanvasBlock });
      if (saveHold) await saveHold;
    }
    return response;
  });
  return { root, base, sessionRequests, savedBlock, holdSave: (value: Promise<void>) => { saveHold = value; },
    hold: (value?: Promise<void>) => { hold = value; }, fail: (value: boolean) => { failSession = value; } };
}

describe('protected App through the native session API', () => {
  it('rejects the wrong token, switches login theme, signs in, and persists a document across remount', async () => {
    const { root, savedBlock } = native; const app = render(<App/>);
    await screen.findByRole('heading', { name: 'Sign in to SymbiKnow' });
    const input = screen.getByLabelText('Access token'); expect(document.activeElement).toBe(input);
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    fireEvent.change(input, { target: { value: 'wrong-token' } }); fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'That access token is not correct');
    fireEvent.change(input, { target: { value: token } }); fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Product Roadmap' });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.topbar button[aria-label="Create note"]')!);
    const title = await screen.findByLabelText('Title'); fireEvent.change(title, { target: { value: 'Protected saved note' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
      expect((await savedBlock).status).toBe(201);
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save document' })).toBeNull());
    const reopened = new CanvasStore(root); await reopened.init();
    expect((await reopened.getCanvas('product-roadmap')).blocks.find(block => block.title === 'Protected saved note')?.content).toContain('Start writing here.');
    app.unmount(); render(<App/>); await screen.findByRole('heading', { name: 'Product Roadmap' });
    expect(await screen.findByRole('button', { name: 'Edit Protected saved note' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in to SymbiKnow' })).toBeNull();
  });

  it('reports a session outage, retries, and shows busy state while the native session response is pending', async () => {
    const { fail, hold, sessionRequests } = native; render(<App/>);
    await screen.findByRole('heading', { name: 'Sign in to SymbiKnow' });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: token } });
    fail(true); fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Session server unavailable');
    fail(false); let release!: () => void; hold(new Promise<void>(done => { release = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Signing in…' })).toHaveProperty('disabled', true);
    expect(sessionRequests).toHaveLength(2);
    await act(async () => release()); await screen.findByRole('heading', { name: 'Product Roadmap' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the editor busy until its real saved-document response is delivered, then closes and reads the same source back', async () => {
    const { root, savedBlock, holdSave } = native;
    let release!: () => void; holdSave(new Promise<void>(resolve => { release = resolve; }));
    render(<App/>);
    await screen.findByRole('heading', { name: 'Sign in to SymbiKnow' });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Product Roadmap' });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.topbar button[aria-label="Create note"]')!);
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Pending protected note' } });
    let saved!: Awaited<typeof savedBlock>;
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
        saved = await savedBlock;
      });
      expect(saved.status).toBe(201);
      expect(screen.getByRole('button', { name: 'Save document' })).toHaveProperty('disabled', true);
      expect(screen.getByRole('dialog', { name: 'Document editor' })).toBeTruthy();
      const reopened = new CanvasStore(root); await reopened.init();
      expect(await reopened.getCanvasBlock('product-roadmap', saved.block.id)).toMatchObject({ title: 'Pending protected note', content: saved.block.content });
    } finally { await act(async () => release()); }
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save document' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'Edit Pending protected note' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
