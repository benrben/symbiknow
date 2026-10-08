import { mkdtemp, rm } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../shared/jev-types.js';
import type { RouteContext } from './api-context.js';
import { internalToken } from './auth.js';
import { canvasReadScope } from './jev-canvas-projection.js';
import { jevPrincipalHeaders } from './jev-api-principal.js';
import { CanvasStore } from './storage.js';

let store: CanvasStore;
let root: string;
beforeEach(async () => {
  for (const name of ['SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'SYMBIKNOW_MCP_TOKEN', 'ALLTEAM_MCP_TOKEN']) vi.stubEnv(name, '');
  root = await mkdtemp(path.join(tmpdir(), 'canvas-read-scope-'));
  store = new CanvasStore(root); await store.init();
});
// Serialize behind advisory token last-use writes before removing the workspace.
afterEach(async () => { await store.updateSettings({}); await rm(root, { recursive: true, force: true, maxRetries: 5 }); vi.unstubAllEnvs(); });

function context(headers: Record<string, string> = {}, mcpPrincipal?: JevPrincipal): RouteContext {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
  const request = new IncomingMessage(socket); request.headers = { host: 'localhost:8787', ...headers };
  const url = new URL('http://localhost:8787/api/canvases/product-roadmap');
  return { mcpPrincipal, store, request, response: new ServerResponse(request), method: 'GET', route: url.pathname, url,
    actor: 'Tester', signal: new AbortController().signal };
}

const scopedAgent: JevPrincipal = { id: 'scoped-agent', kind: 'token', access: 'read', allowedCanvasIds: ['product-roadmap'],
  canConfigure: false, canApprove: false };

it('returns an MCP session scope for a permitted canvas and refuses any other canvas', async () => {
  expect(await canvasReadScope(context({}, scopedAgent), 'product-roadmap')).toEqual(['product-roadmap']);
  await expect(canvasReadScope(context({}, scopedAgent), 'engineering')).rejects.toMatchObject({ status: 403 });
  expect(await canvasReadScope(context({}, { ...scopedAgent, allowedCanvasIds: undefined }), 'engineering')).toBeUndefined();
});

it('leaves the owner session and the internal transport unscoped but scopes a stored bearer token', async () => {
  expect(await canvasReadScope(context(), 'engineering')).toBeUndefined();
  expect(await canvasReadScope(context({ authorization: `Bearer ${internalToken}` }), 'engineering')).toBeUndefined();
  const created = await store.createMcpToken('Scoped reader', 'read', { allowedCanvasIds: ['product-roadmap'] });
  const bearer = context({ authorization: `Bearer ${created.token}` });
  expect(await canvasReadScope(bearer, 'product-roadmap')).toEqual(['product-roadmap']);
  await expect(canvasReadScope(bearer, 'engineering')).rejects.toMatchObject({ status: 403 });
  const signed = context({ authorization: `Bearer ${internalToken}`, ...jevPrincipalHeaders(created.settings.mcpTokens![0].id) });
  await expect(canvasReadScope(signed, 'engineering')).rejects.toMatchObject({ status: 403 });
});
