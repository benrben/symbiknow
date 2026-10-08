import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import { internalToken } from './auth.js';
import { stageJevDraft } from './jev/drafts.js';
import { sourceSnapshot } from './jev/stamps.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProjectMcpServer } from './mcp.js';

let server: Server;
let directory: string;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
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
  const token = await store.createMcpToken('Draft-aware file writer', 'write', { allowedCanvasIds: ['product-roadmap'] });
  const mcp = createProjectMcpServer(base + '/api', fetch, { localFiles: false, headers: { authorization: `Bearer ${token.token}` } });
  client = new Client({ name: 'draft-aware-file-writer', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const args = { canvasId: 'product-roadmap', blockId: block.id };
  const read = await client.callTool({ name: 'read_doc', arguments: args });
  expect(read.isError).not.toBe(true);
  const download = await client.callTool({ name: 'download_file', arguments: args });
  expect(download.isError).not.toBe(true);
  const exported = JSON.parse((download.content as Array<{ text: string }>)[0].text) as {
    manifest: { checkoutId: string }; content: string; filename: string };
  const upload = { canvasId: args.canvasId, mode: 'replace', checkoutId: exported.manifest.checkoutId,
    filename: exported.filename, content: `${block.content}\nApproved after cancellation.`, idempotencyKey: 'draft-guard-retry' };
  for (const [name, arguments_] of [
    ['upload_file', upload], ['delete_doc', { ...args, expectedContentHash: block.contentHash! }], ['switch_branch', { ...args, name: 'main' }],
    ['merge_branch', { ...args, name: 'main' }], ['restore_revision', { ...args, revision: '0000000' }],
  ] as const) {
    const denied = await client.callTool({ name, arguments: arguments_ });
    expect(denied.isError, name).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0].text, name).toMatch(/reviewed draft is active/);
  }
  expect((await store.getCanvasBlock(args.canvasId, block.id)).content).toBe(block.content);
  const spoofed = await send(blockRoute, 'GET', { authorization: `Bearer ${internalToken}` });
  expect(spoofed.status).toBe(403); expect(await spoofed.json()).toEqual({ error: 'An authenticated agent identity is required' });
  const direct = await send(blockRoute, 'PUT', { authorization: `Bearer ${token.token}` }, { content: upload.content });
  expect(direct.status).toBe(403); expect(await direct.json()).toEqual({ error: 'This caller does not permit those tool arguments or canvases' });
  expect((await send(blockRoute, 'PATCH', { authorization: `Bearer ${token.token}` })).status).toBe(403);
  expect((await send(blockRoute, 'PUT', {}, { content: block.content })).status).toBe(200);
  const cancelled = await send(`/api/canvases/${args.canvasId}/jev/drafts/${block.id}/cancel`, 'POST', {}, { draftId: draft.id });
  expect(cancelled.status).toBe(200); expect(await cancelled.json()).toEqual({ ok: true });
  const saved = await client.callTool({ name: 'upload_file', arguments: upload });
  expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
  const reopened = new CanvasStore(directory); await reopened.init();
  expect((await reopened.getCanvasBlock(args.canvasId, block.id)).content).toBe(upload.content);
});
