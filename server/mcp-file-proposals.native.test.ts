import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CanvasStore } from './storage.js';
import { atomicJson } from './storage-files.js';
import { createStoreApiFetcher } from './api-inprocess.js';
import { createProjectMcpServer } from './mcp.js';
import { currentMcpIdentity, jevPrincipalHeaders } from './jev-api-principal.js';
import { internalToken } from './auth.js';
import type { McpTokenInfo } from '../shared/types.js';

let root: string;
let store: CanvasStore;
let canvasId: string;
let docId: string;
const clients: Array<{ client: Client; close: () => Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-mcp-proposals-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Files' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Review' })).id;
  docId = (await store.createBlock(canvasId, { title: 'Source', content: '# Before' })).id;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(item => item.close()));
  await rm(root, { recursive: true, force: true });
});
async function connect(name: string, access: 'read' | 'propose' | 'write', grants: Pick<McpTokenInfo, 'canApprove' | 'canConfigure'> = {}) {
  const created = await store.createMcpToken(name, access, { allowedCanvasIds: [canvasId], ...grants });
  const identity = (await store.mcpTokenIdentity(created.token))!;
  const server = createProjectMcpServer('http://symbi.internal/api', createStoreApiFetcher(store), {
    ...identity, callerId: identity.id, localFiles: false,
    headers: { authorization: `Bearer ${internalToken}`, ...jevPrincipalHeaders(identity.id), 'x-symbiknow-actor': identity.id },
    resolvePermissions: () => currentMcpIdentity(store, identity.id),
  });
  const client = new Client({ name, version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push({ client, close: async () => { await client.close(); await server.close(); } });
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: tool, arguments: { canvasId, ...args } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { error: result.isError, value: result.isError ? text : JSON.parse(text) };
  };
  return { call, client, identity };
}
it('proposes an uploaded working file, applies it through an authorized MCP reviewer, and undoes it', async () => {
  const author = await connect('Proposer', 'propose');
  const download = await author.call('download_file', { blockId: docId });
  expect(download.error).toBeUndefined();
  const proposed = await author.call('upload_file', { mode: 'propose', checkoutId: download.value.manifest.checkoutId,
    filename: download.value.filename, content: '# Reviewed file', idempotencyKey: 'review-1' });
  expect(proposed.error).toBeUndefined(); expect(proposed.value.proposalId).toBeTruthy();
  expect((await store.getCanvasBlock(canvasId, docId)).content).toBe('# Before');
  expect((await author.call('apply_file_proposal', { proposalId: proposed.value.proposalId })).error).toBe(true);
  const reviewer = await connect('Reviewer', 'write', { canApprove: true });
  expect((await reviewer.call('read_file_proposal', { proposalId: proposed.value.proposalId })).value.changes).toHaveLength(1);
  expect((await reviewer.call('apply_file_proposal', { proposalId: proposed.value.proposalId })).error).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, docId)).content).toBe('# Reviewed file');
  expect((await reviewer.call('undo_file_proposal', { proposalId: proposed.value.proposalId })).error).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, docId)).content).toBe('# Before');
});
it('uses stable lock ownership and refreshes discovery and execution after token revocation', async () => {
  const agent = await connect('Stable caller', 'write');
  expect((await agent.call('claim_doc', { blockId: docId })).error).toBeUndefined();
  const downloaded = await agent.call('download_file', { blockId: docId });
  const saved = await agent.call('upload_file', { mode: 'replace', checkoutId: downloaded.value.manifest.checkoutId,
    filename: downloaded.value.filename, content: '# Locked edit', idempotencyKey: 'lock-1' });
  expect(saved.error).toBeUndefined();
  expect((await agent.call('release_doc', { blockId: docId })).error).toBeUndefined();
  await store.revokeMcpToken(agent.identity.id);
  await expect(agent.client.listTools()).rejects.toThrow('revoked');
  expect((await agent.call('read_doc', { blockId: docId })).error).toBe(true);
  expect((await store.getCanvasBlock(canvasId, docId)).content).toBe('# Locked edit');
});
it('enforces read grants, checkout ownership, and actual canvas scope in the backend', async () => {
  const reader = await connect('Reader', 'read');
  const names = (await reader.client.listTools()).tools.map(tool => tool.name);
  expect(names).toContain('download_file'); expect(names).not.toContain('upload_file');
  const downloaded = await reader.call('download_file', { blockId: docId });
  const writer = await connect('Other writer', 'write');
  const denied = await writer.call('upload_file', { mode: 'replace', checkoutId: downloaded.value.manifest.checkoutId,
    filename: downloaded.value.filename, content: '# Wrong caller', idempotencyKey: 'foreign-1' });
  expect(denied.error).toBe(true);
  const foreign = await reader.call('read_doc', { canvasId: 'product-roadmap', blockId: 'launch-checklist' });
  expect(foreign.error).toBe(true);
  expect((await store.getCanvasBlock(canvasId, docId)).content).toBe('# Before');
  expect(await readFile(path.join(root, 'file-checkouts', downloaded.value.manifest.checkoutId + '.json'), 'utf8')).toContain(reader.identity.id);
});
