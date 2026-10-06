import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import { internalToken } from './auth.js';
import { stageJevDraft, setJevDraftState } from './jev/drafts.js';
import { sourceSnapshot } from './jev/stamps.js';

let server: Server;
let directory: string;
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

it('holds MCP source writes and version changes behind a durable draft while browser review and reads remain available', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'symbi-reflex-write-guard-'));
  server = await createApiServer({ dataDir: directory });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  const base = `http://127.0.0.1:${address.port}`;
  const store = new CanvasStore(directory);
  await store.ensureJevStamps('product-roadmap');
  const block = await store.getCanvasBlock('product-roadmap', 'roadmap-overview');
  const draft = await stageJevDraft(directory, sourceSnapshot('acme-team', 'product-roadmap', block), {
    id: 'reviewed-edit', baseContent: block.content, proposedContent: `${block.content}\nProposed edit.`, instruction: 'Review this addition.',
  }, 'agent');
  const blockRoute = '/api/canvases/product-roadmap/blocks/roadmap-overview';
  const send = (route: string, method: string, headers: Record<string, string>, body?: unknown) => fetch(base + route, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const agentHeaders: Array<Record<string, string>> = [{ 'x-symbiknow-agent-transport': 'mcp' }, { authorization: `Bearer ${internalToken}` }];
  for (const headers of agentHeaders) {
    for (const [suffix, method] of [['', 'PUT'], ['', 'DELETE'], ['/versions/switch', 'POST'], ['/versions/merge', 'POST'], ['/versions/restore', 'POST']]) {
      const response = await send(blockRoute + suffix, method, headers, method === 'DELETE' ? undefined : { content: 'Bypass draft', name: 'main', revision: 'HEAD' });
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: expect.stringMatching(/reviewed draft is active/) });
    }
    expect((await send(blockRoute, 'GET', headers)).status).toBe(200);
    expect((await send('/api/workspaces', 'GET', headers)).status).toBe(200);
    expect((await send(blockRoute, 'PATCH', headers)).status).toBe(404);
  }
  expect((await send(blockRoute, 'PUT', {}, { content: block.content })).status).toBe(200);
  await setJevDraftState(directory, 'product-roadmap', block.id, draft.id, 'cancelled');
  expect((await send(blockRoute, 'PUT', { 'x-symbiknow-agent-transport': 'mcp' }, { content: `${block.content}\nApproved after cancellation.` })).status).toBe(200);
  expect((await send('/api/canvases/product-roadmap/blocks/release-checklist', 'PUT', { 'x-symbiknow-agent-transport': 'mcp' }, { content: 'No draft here.' })).status).toBe(404);
});
