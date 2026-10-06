import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiLifecycle } from './api-lifecycle.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'reflex-api-lifecycle-'));
  roots.push(root); return root;
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native address');
  return `http://127.0.0.1:${address.port}`;
}

it('holds the native close callback until a response audit tail and durable writer settle, without repeating shutdown', async () => {
  const root = await directory();
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let stops = 0; let settlements = 0; let callback = false;
  const lifecycle = new ApiLifecycle(() => { stops++; }, async () => {
    settlements++; await writeFile(path.join(root, 'settled'), 'writers finished');
  });
  const server = createServer((_request, response) => lifecycle.track((async () => {
    response.end('accepted');
    await barrier;
    await writeFile(path.join(root, 'audit'), 'native response recorded');
  })()));
  lifecycle.install(server);
  expect(await (await fetch(await listen(server))).text()).toBe('accepted');
  const closedSocket = new Promise<void>(resolve => server.once('close', resolve));
  const closed = new Promise<void>((resolve, reject) => server.close(error => {
    callback = true; if (error) reject(error); else resolve();
  }));
  await closedSocket;
  expect(callback).toBe(false);
  const first = lifecycle.shutdown();
  expect(lifecycle.shutdown()).toBe(first);
  release(); await closed;
  expect(await readFile(path.join(root, 'audit'), 'utf8')).toBe('native response recorded');
  expect(await readFile(path.join(root, 'settled'), 'utf8')).toBe('writers finished');
  expect(settlements).toBe(1); expect(stops).toBeGreaterThan(0);
  await rm(root, { recursive: true });
});

it('settles actual rejected request work and closes normally when the caller supplies no callback', async () => {
  const root = await directory(); let stopped = false;
  const lifecycle = new ApiLifecycle(() => { stopped = true; }, async () => {
    await writeFile(path.join(root, 'complete'), 'closed');
  });
  const failure = readFile(path.join(root, 'missing')).then(() => undefined);
  await expect(lifecycle.track(failure)).rejects.toMatchObject({ code: 'ENOENT' });
  const server = createServer((_request, response) => response.end('ready'));
  lifecycle.install(server); await listen(server);
  const closedSocket = new Promise<void>(resolve => server.once('close', resolve));
  expect(server.close()).toBe(server); await closedSocket; await lifecycle.shutdown();
  expect(stopped).toBe(true);
  expect(await readFile(path.join(root, 'complete'), 'utf8')).toBe('closed');
});

it('reports a genuine durable shutdown failure to the native callback', async () => {
  const root = await directory();
  const lifecycle = new ApiLifecycle(() => undefined, async () => {
    await readFile(path.join(root, 'missing-ledger'));
  });
  const server = createServer(); lifecycle.install(server); await listen(server);
  const error = await new Promise<Error | undefined>(resolve => server.close(resolve));
  expect(error).toMatchObject({ code: 'ENOENT' });
  await expect(lifecycle.shutdown()).rejects.toBe(error);
});

it('keeps callback-free shutdown failures visible and preserves the blocked native recovery artifact', async () => {
  const root = await directory(); const artifact = path.join(root, 'recovery');
  await writeFile(artifact, 'prepared write must be retained');
  const visible = vi.spyOn(console, 'error');
  const lifecycle = new ApiLifecycle(() => undefined, async () => {
    await writeFile(path.join(artifact, 'child'), 'cannot overwrite recovery');
  });
  const server = createServer(); lifecycle.install(server); await listen(server);
  const closedSocket = new Promise<void>(resolve => server.once('close', resolve));
  server.close(); await closedSocket;
  await expect(lifecycle.shutdown()).rejects.toMatchObject({ code: 'ENOTDIR' });
  expect(visible).toHaveBeenCalledWith('API shutdown requires durable recovery:', expect.objectContaining({ code: 'ENOTDIR' }));
  expect(await readFile(artifact, 'utf8')).toBe('prepared write must be retained');
});
