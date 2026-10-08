import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import { projectMcpMetadata } from './mcp-registry.js';
import type { DownloadedFile, FileUploadReceipt } from '../shared/working-copy.js';

let root: string;
let server: Server;
let base: string;
let store: CanvasStore;
const ownerHeaders = { authorization: 'Bearer browser-owner-secret', 'content-type': 'application/json' };
beforeEach(async () => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'browser-owner-secret');
  root = await mkdtemp(path.join(tmpdir(), 'symbi-browser-mcp-'));
  server = await createApiServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing browser test server');
  base = `http://127.0.0.1:${address.port}`;
  store = new CanvasStore(root); await store.init();
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  vi.unstubAllEnvs();
});
async function tool<T>(name: string, args: Record<string, unknown>) {
  const response = await fetch(base + '/api/mcp/browser', { method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ name, arguments: args }) });
  expect(response.status).toBe(200);
  const value = await response.json() as { isError?: boolean; content: Array<{ text: string }> };
  return { error: value.isError, value: value.isError ? value.content[0].text : JSON.parse(value.content[0].text) as T };
}
it('advertises the canonical full-access catalog and edits a downloaded local file with persisted readback and audit', async () => {
  const catalog = await fetch(base + '/api/mcp/browser', { headers: ownerHeaders });
  expect(catalog.status).toBe(200);
  const { tools } = await catalog.json() as { tools: Array<{ name: string }> };
  expect(tools.map(tool => tool.name).sort()).toEqual(projectMcpMetadata().map(tool => tool.name).sort());
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['ask_symbi', 'jev_do', 'download_file', 'upload_file']));
  const created = await tool<FileUploadReceipt>('upload_file', { mode: 'create', canvasId: 'product-roadmap',
    filename: 'browser.mdx', content: '# Browser source', idempotencyKey: 'browser-create' });
  expect(created.error).toBeUndefined();
  const receipt = created.value as FileUploadReceipt;
  const downloaded = await tool<DownloadedFile>('download_file', { canvasId: receipt.canvasId, blockId: receipt.blockId });
  const file = downloaded.value as DownloadedFile;
  const localPath = path.join(root, 'browser-agent.mdx');
  await writeFile(localPath, file.content); await writeFile(localPath, '# Edited browser source');
  const saved = await tool<FileUploadReceipt>('upload_file', { mode: 'replace', canvasId: receipt.canvasId,
    checkoutId: file.manifest.checkoutId, filename: file.filename, content: await readFile(localPath, 'utf8'), idempotencyKey: 'browser-replace' });
  expect(saved.error).toBeUndefined();
  const reopened = new CanvasStore(root); await reopened.init();
  expect((await reopened.getCanvasBlock(receipt.canvasId, receipt.blockId))).toMatchObject({ content: '# Edited browser source', kind: 'mdx' });
  const history = await reopened.documentHistory(receipt.canvasId, receipt.blockId);
  expect(history.commits[0].id).toBe((saved.value as FileUploadReceipt).revision);
  expect(history.commits[0].author).toBe('browser-owner');
  expect((await reopened.mcpActivity()).entries).toEqual(expect.arrayContaining([expect.objectContaining({
    tokenId: 'browser-owner', tool: 'upload_file', outcome: 'success', documentIds: [receipt.blockId], revision: history.commits[0].id })]));
});
it('requires the owner session, rejects another origin and refuses obsolete tool calls', async () => {
  expect((await fetch(base + '/api/mcp/browser')).status).toBe(401);
  const foreign = await fetch(base + '/api/mcp/browser', { method: 'POST',
    headers: { ...ownerHeaders, origin: 'https://foreign.example' }, body: JSON.stringify({ name: 'list_canvases', arguments: {} }) });
  expect(foreign.status).toBe(403);
  const restricted = await store.createMcpToken('Browser reader', 'read');
  expect((await fetch(base + '/api/mcp/browser', { headers: { authorization: `Bearer ${restricted.token}` } })).status).toBe(403);
  expect((await tool('edit_doc', { canvasId: 'product-roadmap', blockId: 'launch-checklist', content: 'bypass' })).error).toBe(true);
});
it('rejects malformed bridge calls and reports canonical tool errors without changing documents', async () => {
  const response = await fetch(base + '/api/mcp/browser', { method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ name: 'delete_doc', arguments: {}, access: 'write' }) });
  expect(response.status).toBe(400);
  expect((await tool('delete_doc', { canvasId: 'product-roadmap', blockId: 'launch-checklist' })).error).toBe(true);
  expect((await store.getCanvasBlock('product-roadmap', 'launch-checklist')).content).toContain('Launch');
});
