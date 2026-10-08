import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStoreApiFetcher } from './api-inprocess.js';
import { atomicJson } from './storage-files.js';
import { CanvasStore } from './storage.js';

let root: string;
let store: CanvasStore;
beforeEach(async () => {
  // A local workspace without an access token admits same-machine callers as the local agent.
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  root = await mkdtemp(path.join(tmpdir(), 'symbi-file-upload-route-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root); await store.init();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('rejects an upload body that does not match the upload schema with every validation message', async () => {
  const response = await createStoreApiFetcher(store)('http://localhost/api/file-uploads', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'replace', canvasId: 'canvas-1' }) });
  expect(response.status).toBe(400);
  const { error } = await response.json() as { error: string };
  expect(error.split('; ')).toHaveLength(3);
  expect(await store.listWorkspaces()).toEqual([]);
});
