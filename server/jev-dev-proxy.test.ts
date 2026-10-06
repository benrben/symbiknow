import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import viteConfig from '../vite.config.js';
import { createApiServer } from './index.js';
import { acceptanceReflexProvider } from '../features/acceptance-reflex-provider.js';

let web: ViteDevServer | undefined;
let api: Server | undefined;
let root: string | undefined;
afterEach(async () => {
  await web?.close();
  if (api) { api.closeAllConnections(); await new Promise<void>(resolve => api!.close(() => resolve())); }
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 20 });
  vi.unstubAllEnvs();
});

it('preserves the browser host through the actual Vite proxy while rejecting a forged origin', async () => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', ''); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  root = await mkdtemp(path.join(tmpdir(), 'reflex-vite-proxy-'));
  const remote = vi.fn<typeof fetch>(acceptanceReflexProvider);
  api = await createApiServer({ dataDir: root, fetcher: remote });
  await new Promise<void>(resolve => api!.listen(0, '127.0.0.1', resolve));
  const apiAddress = api.address(); if (!apiAddress || typeof apiAddress === 'string') throw new Error('Missing API port');
  const backend = `http://127.0.0.1:${apiAddress.port}`;
  const saved = await fetch(backend + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'proxy-fixture-key' } }) });
  expect(saved.ok).toBe(true);
  const options = viteConfig.server!.proxy!['/api'];
  expect(options).toMatchObject({ changeOrigin: false });
  if (typeof options === 'string') throw new Error('The development proxy must preserve the browser host');
  web = await createViteServer({ ...viteConfig, configFile: false, optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0, strictPort: true, watch: null, proxy: { '/api': { ...options, target: backend } } } });
  await web.listen();
  const address = web.httpServer?.address(); if (!address || typeof address === 'string') throw new Error('Missing browser port');
  const browser = `http://127.0.0.1:${address.port}`;
  const route = browser + '/api/workspaces/acme-team/jev/connection';
  const response = await fetch(route, { method: 'POST', headers: { origin: browser } });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ connected: true, documentsSent: 0 });
  expect(remote).toHaveBeenCalledOnce();
  expect(new Headers(remote.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer proxy-fixture-key');
  const attack = await fetch(route, { method: 'POST', headers: { origin: 'https://attacker.example' } });
  expect(attack.status).toBe(403); expect(remote).toHaveBeenCalledOnce();
});
