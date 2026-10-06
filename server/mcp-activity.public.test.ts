import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import { mcpActivityRefs, mcpResultIds, safeMcpError, type McpActivityInput } from './mcp-activity.js';
import { CanvasApi } from './mcp-api.js';
import { recordCall } from './mcp-http-activity.js';
import { remoteMcpFixture, sdkClient, toolJson } from './mcp-http.test.fixture.js';
import { CanvasStore } from './storage.js';

const date = '2026-10-01T12:00:00.000Z';
const activity: McpActivityInput = { tokenId: 'token-1', tokenName: 'Native caller', access: 'read', tool: 'read_doc',
  startedAt: date, endedAt: date, outcome: 'success', canvasIds: ['product-roadmap'], documentIds: ['launch-checklist'] };

it('extracts real SDK document IDs and Git revisions and persists their call order after restart', async () => {
  const { base, root, store } = await remoteMcpFixture();
  const { token } = await store.createMcpToken('Revision auditor', 'write');
  const { client } = await sdkClient(base, token);
  const created = await client.callTool({ name: 'create_doc', arguments: { canvasId: 'product-roadmap', title: 'Revision source', content: '# First revision' } });
  const block = toolJson<CanvasBlock>(created);
  expect(mcpResultIds(created)).toEqual({ documentId: block.id, revision: undefined });
  const versions = await client.callTool({ name: 'list_versions', arguments: { canvasId: 'product-roadmap', blockId: block.id } });
  const original = toolJson<{ commits: Array<{ id: string }> }>(versions).commits[0].id;
  expect(mcpResultIds(versions)).toEqual({ documentId: undefined, revision: original });
  await client.callTool({ name: 'edit_doc', arguments: { canvasId: 'product-roadmap', blockId: block.id, content: '# Revised source' } });
  const restored = await client.callTool({ name: 'restore_revision', arguments: { canvasId: 'product-roadmap', blockId: block.id, revision: original } });
  expect(restored.isError).not.toBe(true);
  const revision = toolJson<{ commits: Array<{ id: string }> }>(restored).commits[0].id;
  expect(mcpResultIds(restored)).toEqual({ documentId: undefined, revision });
  const entries = (await new CanvasStore(root).mcpActivity()).entries;
  expect(entries.map(entry => entry.tool)).toEqual(['restore_revision', 'edit_doc', 'list_versions', 'create_doc']);
  expect(entries.map(entry => entry.documentIds)).toEqual(Array.from({ length: 4 }, () => [block.id]));
  expect(entries[0].revision).toBe(revision);
  expect(entries[2].revision).toBe(original);
  expect(await readFile(path.join(root, block.file), 'utf8')).toBe('# First revision');
  expect((await new CanvasStore(root).getCanvas('product-roadmap')).blocks.find(item => item.id === block.id)?.content).toBe('# First revision');
  const file = path.join(root, 'mcp-activity.json');
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(entries);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(entries)).not.toContain(token);
  expect(JSON.stringify(entries)).not.toContain('# First revision');
});

it('characterizes public result parsing for absent text, malformed payloads and revision precedence using a real Git revision', async () => {
  const { store } = await remoteMcpFixture();
  const status = await store.documentHistory('product-roadmap', 'launch-checklist');
  const revision = status.commits[0].id;
  const envelope = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  for (const result of [undefined, null, 7, {}, { content: [] }, { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] },
    { content: [{ text: 'not JSON' }] }, envelope(null)]) expect(mcpResultIds(result)).toEqual({});
  expect(mcpResultIds(envelope({ id: '<unsafe>', commits: [{ id: 123 }] }))).toEqual({ documentId: undefined, revision: undefined });
  expect(mcpResultIds(envelope({ id: 'launch-checklist', status: { commits: [{ id: revision }] }, commits: [{ id: 'b'.repeat(40) }] })))
    .toEqual({ documentId: 'launch-checklist', revision });
  expect(mcpResultIds(envelope({ status: { commits: [{ id: 'not-a-revision' }] }, commits: [{ id: revision }] })))
    .toEqual({ documentId: undefined, revision });
  expect(mcpResultIds(envelope({ status: { commits: [{ id: 'not-a-revision' }] }, commits: [{ id: 'c'.repeat(64) }] })))
    .toEqual({ documentId: undefined, revision: undefined });
  expect(mcpActivityRefs({ canvasId: 'product-roadmap', sourceCanvasId: 'product-roadmap', targetCanvasId: 'other-canvas',
    blockId: 'first', fromBlockId: 'first', toBlockId: 'second', keepBlockId: 'third',
    blockIds: Array.from({ length: 25 }, (_, index) => `doc-${index}`), mergeBlockIds: ['<unsafe>', 'third'], content: 'private source' }))
    .toEqual({ canvasIds: ['product-roadmap', 'other-canvas'], documentIds: ['first', 'second', 'third', ...Array.from({ length: 17 }, (_, index) => `doc-${index}`)] });
  for (const args of [null, 'private source', []]) expect(mcpActivityRefs(args)).toEqual({ canvasIds: [], documentIds: [] });
});

it.each(['{broken', '{}'])('surfaces malformed persisted activity %s through API and store, then recovers after disk repair', async malformed => {
  const { base, root, store } = await remoteMcpFixture();
  expect(await store.mcpActivity()).toEqual({ entries: [] });
  const file = path.join(root, 'mcp-activity.json');
  await writeFile(file, malformed);
  const response = await fetch(base + '/api/mcp/activity');
  expect(response.status).toBe(500);
  await expect(store.recordMcpActivity(activity)).rejects.toBeInstanceOf(Error);
  expect(await readFile(file, 'utf8')).toBe(malformed);
  await writeFile(file, '[]');
  const entry = await store.recordMcpActivity(activity);
  expect((await fetch(base + '/api/mcp/activity').then(result => result.json())).entries).toEqual([entry]);
  expect((await new CanvasStore(root).mcpActivity()).entries).toEqual([entry]);
});

it('cleans up the native temporary ledger after a rename failure and resumes serialized writes after repair', async () => {
  const { root, store } = await remoteMcpFixture();
  const original = await store.recordMcpActivity(activity);
  const file = path.join(root, 'mcp-activity.json');
  const contents = await readFile(file, 'utf8');
  await rename(file, file + '.backup');
  await promisify(execFile)('mkfifo', [file]);
  const pending = store.recordMcpActivity({ ...activity, tool: 'list_canvases', documentIds: [] });
  const rejected = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY)$/) });
  const writer = await open(file, 'w');
  try {
    await writer.writeFile(contents);
    await rename(file, file + '.fifo');
    await mkdir(file);
  } finally { await writer.close(); }
  await rejected;
  expect((await readdir(root)).filter(name => name.startsWith('mcp-activity.json.') && name.endsWith('.tmp'))).toEqual([]);
  await rm(file, { recursive: true });
  await rm(file + '.fifo');
  await rename(file + '.backup', file);
  const retried = await store.recordMcpActivity({ ...activity, tool: 'list_canvases', documentIds: [] });
  expect((await new CanvasStore(root).mcpActivity()).entries).toEqual([retried, original]);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('retains successful SDK document writes when the ledger is corrupt, then resumes logging after repair', async () => {
  const { base, root, store } = await remoteMcpFixture();
  const { token } = await store.createMcpToken('Ledger recovery writer', 'write');
  const { client } = await sdkClient(base, token);
  const file = path.join(root, 'mcp-activity.json');
  await writeFile(file, '{broken ledger');
  const created = await client.callTool({ name: 'create_doc', arguments: { canvasId: 'product-roadmap', title: 'Durable despite ledger failure', content: '# Native recovery proof' } });
  expect(created.isError).not.toBe(true);
  const block = toolJson<CanvasBlock>(created);
  expect((await new CanvasStore(root).getCanvas('product-roadmap')).blocks.find(item => item.id === block.id)?.content).toBe('# Native recovery proof');
  expect(await readFile(file, 'utf8')).toBe('{broken ledger');
  expect((await store.documentHistory('product-roadmap', block.id)).commits[0].message).toBe('Create Durable despite ledger failure');
  await writeFile(file, '[]');
  const read = await client.callTool({ name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: block.id } });
  expect(read.isError).not.toBe(true);
  const entries = (await new CanvasStore(root).mcpActivity()).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ tool: 'read_doc', outcome: 'success', documentIds: [block.id] });
  expect(entries[0].revision).toMatch(/^[a-f0-9]{40}$/);
});

it('records sanitized native HTTP status and disconnection errors without exposing the upstream address or non-Error details', async () => {
  const { base, root, store } = await remoteMcpFixture();
  const { token } = await store.createMcpToken('Failure auditor', 'read');
  const identity = await store.mcpTokenIdentity(token);
  if (!identity) throw new Error('Missing native token identity');
  const upstream = createServer((_request, response) => { response.writeHead(503); response.end(); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing native upstream address');
  const origin = `http://127.0.0.1:${address.port}/api`;
  const api = new CanvasApi(origin, fetch, () => ({}));
  let unavailable: unknown;
  try {
    let failure: unknown;
    try { await api.request('/workspaces'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(safeMcpError('error', failure)).toBe('Canvas API request failed (503).');
    await recordCall(store, identity, { name: 'list_canvases', args: {} }, date, date, 'error', undefined, failure);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  try { await api.request('/workspaces'); } catch (error) { unavailable = error; }
  expect(unavailable).toBeInstanceOf(Error);
  expect(safeMcpError('error', unavailable)).toBe('Canvas API was unavailable.');
  await recordCall(store, identity, { name: 'list_canvases', args: {} }, date, date, 'error', undefined, unavailable);
  expect(safeMcpError('error', 'secret non-Error details')).toBe('Tool call failed. Review its arguments or retry.');
  expect(safeMcpError('denied', unavailable)).toBe('Token access does not permit this tool.');
  const entries = (await new CanvasStore(root).mcpActivity()).entries;
  expect(entries.map(entry => entry.error)).toEqual(['Canvas API was unavailable.', 'Canvas API request failed (503).']);
  expect((await fetch(base + '/api/mcp/activity').then(response => response.json())).entries).toEqual(entries);
  expect(JSON.stringify(entries)).not.toContain(origin);
  expect(JSON.stringify(entries)).not.toContain(token);
  expect(JSON.stringify(entries)).not.toContain('secret non-Error details');
});
