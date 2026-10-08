import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CanvasStore } from './storage.js';
import { createApiServer } from './index.js';

let directory: string;
let store: CanvasStore;
const servers: Server[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-storage-settings-'));
  store = new CanvasStore(directory);
  await store.init();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await rm(directory, { recursive: true, force: true });
});

async function api() {
  const server = await createApiServer({ dataDir: directory });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}

it('repairs malformed persisted last-use metadata after successful authentication and retains the token scope after restart', async () => {
  const created = await store.createMcpToken('Recoverable reader', 'read', { allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'] });
  const file = path.join(directory, 'settings.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.mcpTokens[0].lastUsedAt = 'invalid legacy timestamp';
  await writeFile(file, JSON.stringify(saved));
  expect(await store.mcpTokenIdentity(created.token)).toEqual({ id: created.settings.mcpTokens![0].id, name: 'Recoverable reader', access: 'read',
    allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'], canApprove: false, canConfigure: false });
  // Queue a real settings write after the advisory metadata operation.
  const settings = await store.updateSettings({});
  const lastUsedAt = settings.mcpTokens![0].lastUsedAt!;
  expect(Number.isFinite(Date.parse(lastUsedAt))).toBe(true);
  expect((await new CanvasStore(directory).getSettings()).mcpTokens![0].lastUsedAt).toBe(lastUsedAt);
  expect(await new CanvasStore(directory).verifyMcpToken(created.token)).toBe('Recoverable reader');
});

it.each(['read', 'write'])('keeps authentication and the real activity queue usable when advisory token metadata encounters a native %s failure', async failure => {
  const created = await store.createMcpToken('Advisory reader');
  const tokenId = created.settings.mcpTokens![0].id;
  const file = path.join(directory, 'settings.json');
  const original = await readFile(file, 'utf8');
  await rm(file);
  await promisify(execFile)('mkfifo', [file]);
  const pending = store.mcpTokenIdentity(created.token);
  const writer = await open(file, 'w');
  try {
    await writer.writeFile(original);
    if (failure === 'read') {
      await rename(file, file + '.fifo');
      await mkdir(file);
    }
  } finally { await writer.close(); }
  expect(await pending).toEqual({ id: tokenId, name: 'Advisory reader', access: 'read', canApprove: false, canConfigure: false });
  if (failure === 'write') {
    const secondRead = await open(file, 'w');
    try {
      await secondRead.writeFile(original);
      await rename(file, file + '.fifo');
      await mkdir(file);
    } finally { await secondRead.close(); }
  }
  const activity = await store.recordMcpActivity({ tokenId, tokenName: 'Advisory reader', access: 'read', tool: 'read_doc',
    startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:00:01Z', outcome: 'success',
    canvasIds: ['product-roadmap'], documentIds: ['roadmap-overview'] });
  expect((await new CanvasStore(directory).mcpActivity()).entries).toEqual([activity]);
  expect((await stat(file)).isDirectory()).toBe(true);
  await rm(file, { recursive: true });
  await writeFile(file, original);
  await rm(file + '.fifo');
  expect(await store.verifyMcpToken(created.token)).toBe('Advisory reader');
  const recovered = await store.updateSettings({ model: 'recovered-model' });
  expect(recovered).toMatchObject({ model: 'recovered-model', mcpTokens: [{ id: tokenId, lastUsedAt: expect.any(String) }] });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await new CanvasStore(directory).getSettings()).toEqual(recovered);
});

it('does not resurrect a token removed from native settings after its authentication read but before the metadata write', async () => {
  const created = await store.createMcpToken('Removed reader');
  const file = path.join(directory, 'settings.json');
  const original = await readFile(file, 'utf8');
  const latest = JSON.parse(original);
  delete latest.mcpTokens;
  latest.model = 'newer-model';
  await rm(file);
  await promisify(execFile)('mkfifo', [file]);
  const pending = store.verifyMcpToken(created.token);
  const writer = await open(file, 'w');
  try {
    await writer.writeFile(original);
    await rename(file, file + '.fifo');
    await writeFile(file, JSON.stringify(latest));
  } finally { await writer.close(); }
  expect(await pending).toBe('Removed reader');
  await store.updateSettings({});
  expect(await store.mcpTokenIdentity(created.token)).toBeNull();
  expect(await new CanvasStore(directory).getSettings()).toMatchObject({ model: 'newer-model', mcpTokens: [] });
  expect(await readFile(file, 'utf8')).not.toContain(created.settings.mcpTokens![0].id);
  await rm(file + '.fifo');
});

it('persists scoped and legacy tokens, keeps other token metadata unchanged, and honors the recent-use debounce', async () => {
  const scoped = await store.createMcpToken('Scoped proposer', 'propose', { allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'] });
  const legacy = await store.createMcpToken('Legacy writer', 'write');
  const file = path.join(directory, 'settings.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  delete saved.mcpTokens[1].access;
  saved.mcpTokens[0].lastUsedAt = new Date(Date.now() + 60_000).toISOString();
  await writeFile(file, JSON.stringify(saved));
  expect(await store.mcpTokenIdentity(legacy.token)).toEqual({ id: legacy.settings.mcpTokens![1].id, name: 'Legacy writer', access: 'write', canApprove: false, canConfigure: false });
  await store.updateSettings({});
  const before = await readFile(file, 'utf8');
  expect(await store.mcpTokenIdentity(scoped.token)).toEqual({ id: scoped.settings.mcpTokens![0].id, name: 'Scoped proposer', access: 'propose',
    allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'], canApprove: false, canConfigure: false });
  await store.recordMcpActivity({ tokenId: scoped.settings.mcpTokens![0].id, tokenName: 'Scoped proposer', access: 'propose', tool: 'read_doc',
    startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:00:01Z', outcome: 'success', canvasIds: [], documentIds: [] });
  expect(await readFile(file, 'utf8')).toBe(before);
  const stale = JSON.parse(before);
  stale.mcpTokens[0].lastUsedAt = '2000-01-01T00:00:00.000Z';
  await writeFile(file, JSON.stringify(stale));
  expect(await store.verifyMcpToken(scoped.token)).toBe('Scoped proposer');
  await store.updateSettings({});
  const touched = JSON.parse(await readFile(file, 'utf8'));
  expect(touched.mcpTokens[0].lastUsedAt).not.toBe(stale.mcpTokens[0].lastUsedAt);
  expect(touched.mcpTokens[1]).toEqual(stale.mcpTokens[1]);
  const retained = await store.revokeMcpToken(scoped.settings.mcpTokens![0].id);
  expect(retained.mcpTokens).toHaveLength(1);
  expect(await new CanvasStore(directory).verifyMcpToken(scoped.token)).toBeNull();
  expect(await new CanvasStore(directory).verifyMcpToken(legacy.token)).toBe('Legacy writer');
});

it('preserves provider keys and private secrets through HTTP updates, native external edits and restart while every public read stays redacted', async () => {
  vi.stubEnv('OPENROUTER_API_KEY', 'environment-router');
  vi.stubEnv('OPENAI_API_KEY', 'environment-openai');
  expect(await store.getApiKey()).toBe('environment-router');
  expect((await store.secretSettings()).apiKey).toBe('');
  const base = await api();
  const updated = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai', apiKey: 'saved-openai', model: 'openai-model',
      secrets: { REMOTE_TOKEN: 'private-remote-token' }, agentPlugins: [] }) });
  expect(updated.status).toBe(200);
  const publicSettings = await updated.json();
  expect(publicSettings).toMatchObject({ provider: 'openai', hasApiKey: true, secretNames: ['REMOTE_TOKEN'], agentPlugins: [] });
  expect(JSON.stringify(publicSettings)).not.toMatch(/saved-openai|private-remote-token/);
  await store.updateSettings({ provider: 'openrouter', apiKey: 'saved-router' });
  await store.updateSettings({ provider: 'openai', model: 'selected-model' });
  expect(await store.getApiKey()).toBe('saved-openai');
  const file = path.join(directory, 'settings.json');
  const saved = await store.secretSettings();
  expect(saved).toMatchObject({ providerKeys: { openrouter: 'saved-router', openai: 'saved-openai' }, secrets: { REMOTE_TOKEN: 'private-remote-token' } });
  await writeFile(file, JSON.stringify({ ...saved, model: 'externally-selected-model' }));
  const fetched = await fetch(base + '/api/settings');
  expect(fetched.status).toBe(200);
  expect(await fetched.json()).toMatchObject({ model: 'externally-selected-model', hasApiKey: true });
  expect((await new CanvasStore(directory).getSettings()).model).toBe('externally-selected-model');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('keeps retired private configuration on disk while removing Jev settings and plugins from native HTTP reads and updates', async () => {
  const file = path.join(directory, 'settings.json');
  const legacy = { ...await store.secretSettings(), jevApiKey: 'retired-private-key', reviewers: 'Legacy reviewer', workAreas: 'Legacy area',
    tagVocabulary: 'legacy tag', jevPolicy: { label: { show: 0.4, apply: 0.7 } }, agentPlugins: ['jev_insights', 'external_mcp'] };
  await writeFile(file, JSON.stringify(legacy));
  const base = await api();
  const initial = await fetch(base + '/api/settings').then(response => response.json());
  expect(initial.agentPlugins).toEqual(['external_mcp']);
  for (const field of ['hasJevApiKey', 'reviewers', 'workAreas', 'tagVocabulary', 'jevPolicy']) expect(initial).not.toHaveProperty(field);
  expect(JSON.stringify(initial)).not.toContain('retired-private-key');
  const update = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'ordinary-model', jevApiKey: 'replacement-key', reviewers: 'replacement', jevPolicy: {} }) });
  expect(update.status).toBe(200);
  expect(await update.json()).toMatchObject({ model: 'ordinary-model', agentPlugins: ['external_mcp'] });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  expect(saved).toMatchObject({ model: 'ordinary-model', jevApiKey: 'retired-private-key', reviewers: 'Legacy reviewer',
    workAreas: 'Legacy area', tagVocabulary: 'legacy tag', jevPolicy: legacy.jevPolicy });
  expect(saved.agentPlugins).toEqual(['external_mcp']);
  const restarted = await api();
  expect(await fetch(restarted + '/api/settings').then(response => response.json())).toEqual(await store.getSettings());
  const rejected = await fetch(restarted + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentPlugins: ['jev_insights'] }) });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ error: 'Unknown agent plugin' });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(saved);
});

it.each(['invalid JSON', 'directory'])('refuses %s settings over HTTP without overwriting them and succeeds after native repair', async obstruction => {
  await store.updateSettings({ provider: 'custom', baseUrl: 'http://localhost:9000/v1', model: 'preserved-model', apiKey: 'private-key' });
  const file = path.join(directory, 'settings.json');
  const original = await readFile(file, 'utf8');
  const base = await api();
  await rm(file);
  if (obstruction === 'directory') await mkdir(file);
  else await writeFile(file, '{invalid');
  const failedRead = await fetch(base + '/api/settings');
  expect(failedRead.status).toBe(500);
  expect(await failedRead.json()).toEqual({ error: 'Internal server error' });
  const failedWrite = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'unsafe-replacement' }) });
  expect(failedWrite.status).toBe(500);
  if (obstruction === 'directory') expect((await stat(file)).isDirectory()).toBe(true);
  else expect(await readFile(file, 'utf8')).toBe('{invalid');
  await rm(file, { recursive: true });
  await writeFile(file, original);
  const recovered = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'recovered-model' }) });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ model: 'recovered-model', provider: 'custom', baseUrl: 'http://localhost:9000/v1', hasApiKey: true });
  expect(await new CanvasStore(directory).getApiKey()).toBe('private-key');
});

it('enforces the native token limit before writing and accepts a new token after one is revoked', async () => {
  for (let index = 0; index < 20; index++) await store.createMcpToken(`Reader ${index}`);
  const file = path.join(directory, 'settings.json');
  const before = await readFile(file, 'utf8');
  const first = (await store.getSettings()).mcpTokens![0];
  await expect(store.createMcpToken('Overflow')).rejects.toMatchObject({ status: 400, message: 'Revoke an old token before creating another (limit 20)' });
  expect(await readFile(file, 'utf8')).toBe(before);
  await store.revokeMcpToken(first.id);
  const created = await store.createMcpToken('Replacement');
  expect(created.settings.mcpTokens).toHaveLength(20);
  const restarted = new CanvasStore(directory);
  expect(await restarted.verifyMcpToken(created.token)).toBe('Replacement');
  await restarted.updateSettings({});
});

it('uses documented defaults after the settings file is removed and returns missing token identities and revisions safely', async () => {
  await store.updateSettings({ model: 'old-model' });
  await rm(path.join(directory, 'settings.json'));
  const restarted = new CanvasStore(directory);
  expect(await restarted.getSettings()).toMatchObject({ provider: 'openrouter', model: '', mcpTokens: [], groupBy: 'work_area' });
  expect(await restarted.mcpTokenIdentity('')).toBeNull();
  expect(await restarted.verifyMcpToken('unknown')).toBeNull();
  await expect(restarted.revokeMcpToken('missing')).rejects.toMatchObject({ status: 404 });
  expect(await restarted.mcpDocumentRevision('../invalid')).toBeUndefined();
  expect(await restarted.mcpDocumentRevision('roadmap-overview')).toBeUndefined();
  await restarted.documentHistory('product-roadmap', 'roadmap-overview');
  expect(await restarted.mcpDocumentRevision('roadmap-overview')).toMatch(/^[a-f0-9]{40}$/);
});
