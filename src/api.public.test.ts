// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import { api, authRequiredEvent } from './api';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'native-header-token'); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-api-headers-'));
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  vi.stubGlobal('fetch', (route: string, init?: RequestInit) => nativeFetch(`http://127.0.0.1:${address.port}${route}`, init));
  return { root };
}

describe('public API request headers through native protected HTTP', () => {
  it.each(['object', 'Headers', 'tuples'])('preserves %s headers while supplying JSON defaults and writes saved state', async kind => {
    const { root } = await fixture(); const entries = { authorization: 'Bearer native-header-token', 'x-request': 'native-client' };
    const headers: HeadersInit = kind === 'Headers' ? new Headers(entries) : kind === 'tuples' ? Object.entries(entries) : entries;
    await api('/settings', { method: 'PUT', headers, body: JSON.stringify({ provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: 'Saved with ' + kind }) });
    const fresh = new CanvasStore(root); await fresh.init(); expect((await fresh.getSettings()).systemPrompt).toBe('Saved with ' + kind);
    expect(await api('/session', { headers })).toEqual({ authRequired: true, authenticated: true });
  });

  it('notifies the app for a protected request while keeping an invalid sign-in error local to the form', async () => {
    await fixture(); const listener = vi.fn(); window.addEventListener(authRequiredEvent, listener);
    try {
      await expect(api('/workspaces')).rejects.toThrow('access token'); expect(listener).toHaveBeenCalledOnce();
      await expect(api('/session', { method: 'POST', body: JSON.stringify({ token: 'incorrect' }) })).rejects.toThrow('That access token is not correct');
      expect(listener).toHaveBeenCalledOnce();
      expect(await api('/session', { headers: { authorization: 'Bearer native-header-token' } })).toMatchObject({ authenticated: true });
    } finally { window.removeEventListener(authRequiredEvent, listener); }
  });
});
