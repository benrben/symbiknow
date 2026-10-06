import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { internalToken } from './auth.js';
import { CanvasStore } from './storage.js';
import { hasJevApiAccess, jevApiPrincipal, jevPrincipalHeaders } from './jev-api-principal.js';

let store: CanvasStore;
let root: string;
beforeEach(async () => {
  for (const name of ['SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'SYMBIKNOW_MCP_TOKEN', 'ALLTEAM_MCP_TOKEN']) vi.stubEnv(name, '');
  root = await mkdtemp(path.join(tmpdir(), 'reflex-principals-'));
  store = new CanvasStore(root); await store.init();
});
afterEach(async () => { await store.updateSettings({}); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function request(headers: Record<string, string> = {}, address = '127.0.0.1') {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: address });
  const message = new IncomingMessage(socket); message.headers = { host: 'localhost:8787', ...headers }; return message;
}

it('allows explicit local-owner review while keeping a stdio agent unprivileged regardless of display actor', async () => {
  expect(await jevApiPrincipal(store, request({ 'x-symbiknow-actor': 'Symbi' }), false)).toMatchObject({ kind: 'user', canApprove: true, canConfigure: true });
  expect(await jevApiPrincipal(store, request({ 'x-symbiknow-actor': 'workspace-owner' }), true)).toMatchObject({ kind: 'token', canApprove: false, canConfigure: false });
});

it('rejects cross-origin, malformed-origin, and remote unauthenticated approval', async () => {
  for (const origin of ['https://attacker.example', 'null', 'bad://']) await expect(jevApiPrincipal(store, request({ origin }), false)).rejects.toMatchObject({ status: 403 });
  await expect(jevApiPrincipal(store, request({}, '10.0.0.8'), false)).rejects.toMatchObject({ status: 403 });
});

it('does not turn an internal transport credential or forged proof into approval authority', async () => {
  const headers = { authorization: `Bearer ${internalToken}`, 'x-symbiknow-actor': 'workspace-owner' };
  await expect(jevApiPrincipal(store, request(headers), false)).rejects.toMatchObject({ status: 403 });
  await expect(jevApiPrincipal(store, request({ ...headers, 'x-symbiknow-jev-principal': 'owner.invalid' }), false)).rejects.toMatchObject({ status: 403 });
});

it('resolves current token capabilities on every signed loopback call and rejects revocation', async () => {
  const created = await store.createMcpToken('Scoped Reflex reader', 'read', { allowedCanvasIds: ['product-roadmap'], tools: ['jev_profile'] });
  const tokenId = created.settings.mcpTokens![0].id;
  const message = request({ authorization: `Bearer ${internalToken}`, ...jevPrincipalHeaders(tokenId) });
  expect(await jevApiPrincipal(store, message, false)).toEqual({ id: tokenId, kind: 'token', access: 'read', allowedCanvasIds: ['product-roadmap'], tools: ['jev_profile'], canConfigure: false, canApprove: false });
  await store.revokeMcpToken(tokenId);
  await expect(jevApiPrincipal(store, message, false)).rejects.toMatchObject({ status: 403 });
});

it('authenticates scoped bearer tokens without making them reviewers and handles fixed token revocation', async () => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'owner-key');
  expect(await hasJevApiAccess(store, request())).toBe(false);
  await expect(jevApiPrincipal(store, request(), false)).rejects.toMatchObject({ status: 401 });
  const created = await store.createMcpToken('Reflex writer', 'write');
  const message = request({ authorization: `Bearer ${created.token}`, 'x-symbiknow-actor': 'Human' });
  expect(await hasJevApiAccess(store, message)).toBe(true);
  expect(await jevApiPrincipal(store, message, false)).toMatchObject({ kind: 'token', canApprove: false });
  expect(await jevApiPrincipal(store, request({ authorization: `Bearer ${internalToken}`, ...jevPrincipalHeaders('access-token-primary') }), false)).toMatchObject({ id: 'access-token-primary', canApprove: false });
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  await expect(jevApiPrincipal(store, request({ authorization: `Bearer ${internalToken}`, ...jevPrincipalHeaders('access-token-primary') }), false)).rejects.toMatchObject({ status: 403 });
});

it('keeps legacy saved-token grants unprivileged and refuses review when no peer address establishes local trust', async () => {
  const created = await store.createMcpToken('Legacy saved agent', 'write');
  const id = created.settings.mcpTokens![0].id;
  const settings = await store.secretSettings();
  delete settings.mcpTokens![0].access;
  await writeFile(path.join(root, 'settings.json'), JSON.stringify(settings));
  const message = request({ authorization: `Bearer ${internalToken}`, ...jevPrincipalHeaders(id) });
  expect(await jevApiPrincipal(store, message, false)).toMatchObject({ id, kind: 'token', access: 'write', canApprove: false, canConfigure: false });
  const disconnected = new IncomingMessage(new Socket());
  disconnected.headers = { host: 'localhost:8787' };
  await expect(jevApiPrincipal(store, disconnected, false)).rejects.toMatchObject({ status: 403 });
  await expect(jevApiPrincipal(store, request({ authorization: 'Bearer forged' }), false)).rejects.toMatchObject({ status: 401 });
});
