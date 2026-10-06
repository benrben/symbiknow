import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from './index.js';

const opened: Array<{ server: Server; dataDir: string }> = [];

async function serverFixture(): Promise<{ base: string; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-jev-routes-'));
  const server = await createApiServer({ dataDir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, dataDir });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { base: `http://127.0.0.1:${address.port}`, dataDir: path.resolve(dataDir) };
}


afterEach(async () => {
  for (const { server, dataDir } of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('native request body limit', () => {
  it('maps an oversized JSON body to a 413 without logging it as a server error', async () => {
    const { base } = await serverFixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2_000_001) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Request body is too large' });
    expect(error).not.toHaveBeenCalled();
  });
});
