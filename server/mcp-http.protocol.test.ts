import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CanvasBlock } from '../shared/types.js';
import { CanvasStore } from './storage.js';
import { mcpSessionCount } from './mcp-http.js';
import { remoteMcpFixture, rpcHeaders, rpcRequest, sdkClient, toolJson } from './mcp-http.test.fixture.js';

afterEach(() => vi.unstubAllEnvs());
const listing = { jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} };

describe('remote MCP protocol and token boundaries', () => {
  it('requires MCP credentials before parsing or dispatching an HTTP body', async () => {
    const { base } = await remoteMcpFixture();
    const result = await rpcRequest(base, 'missing-token', listing);
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toBe('Bearer');
    expect(await result.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000,
      message: 'Missing or invalid MCP token. Create one in Settings → Connect agents.' } });
  });

  it('rejects noninitializing requests and malformed or oversized JSON, then allows SDK initialization', async () => {
    const { base, store } = await remoteMcpFixture();
    const { token } = await store.createMcpToken('Protocol reader', 'read');
    for (const [input, method] of [[listing, 'POST'], [undefined, 'GET'], [undefined, 'OPTIONS']] as const) {
      const result = await rpcRequest(base, token, input, undefined, method);
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ error: { message: 'Send an initialize request to start an MCP session.' } });
    }
    const malformed = await fetch(base + '/mcp', { method: 'POST', headers: rpcHeaders(token), body: '{' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32000, message: expect.any(String) } });
    const tooLarge = await rpcRequest(base, token, { ...listing, padding: 'x'.repeat(4_000_001) });
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toMatchObject({ error: { message: 'Request body is too large' } });
    const { client } = await sdkClient(base, token);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('read_doc');
  });

  it('rejects unknown sessions and a different valid token using another session', async () => {
    const { base, store } = await remoteMcpFixture();
    const first = await store.createMcpToken('First reader', 'read');
    const second = await store.createMcpToken('Second reader', 'read');
    const { client, transport } = await sdkClient(base, first.token);
    const sessionId = transport.sessionId;
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
    const missing = await rpcRequest(base, first.token, listing, '00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { message: 'Session not found. Start a new MCP session.' } });
    const denied = await rpcRequest(base, second.token, listing, sessionId);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { message: 'This MCP session belongs to another token.' } });
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('gives path credentials precedence over headers and preserves scoped tools, canvases and remote-only schemas', async () => {
    const { base, store } = await remoteMcpFixture();
    const { token } = await store.createMcpToken('Path reader', 'read', { allowedCanvasIds: ['product-roadmap'], tools: ['read_doc', 'download_file'] });
    const { client } = await sdkClient(base, token, { pathToken: token, headerToken: 'wrong-header' });
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual(['read_doc', 'download_file']);
    expect(tools.find(tool => tool.name === 'download_file')?.inputSchema.properties).not.toHaveProperty('destinationPath');
    expect((await client.callTool({ name: 'read_doc', arguments: { canvasId: 'outside', blockId: 'launch-checklist' } })).isError).toBe(true);
    const source = await client.callTool({ name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: 'launch-checklist' } });
    expect(source.isError).not.toBe(true);
    expect(toolJson<CanvasBlock>(source).id).toBe('launch-checklist');
    const invalidPath = await fetch(base + '/mcp/t/wrong-path', { method: 'POST', headers: rpcHeaders(token), body: JSON.stringify(listing) });
    expect(invalidPath.status).toBe(401);
    const entries = (await new CanvasStore(store.root).mcpActivity()).entries;
    expect(entries.map(entry => entry.outcome)).toEqual(['success', 'denied']);
    expect(entries.every(entry => entry.allowedCanvasIds?.[0] === 'product-roadmap' && entry.tools?.length === 2)).toBe(true);
  });

  it.each(['127.0.0.1', '::1', '::'])('writes through the real SDK and local API on %s, records revisions and attributes the actor', async host => {
    const { base, root, store } = await remoteMcpFixture(host);
    const { token } = await store.createMcpToken('Reviewed writer', 'write');
    const { client } = await sdkClient(base, token);
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === 'upload_file')?.inputSchema.properties).not.toHaveProperty('sourcePath');
    const created = toolJson<CanvasBlock>(await client.callTool({ name: 'create_doc', arguments: {
      canvasId: 'product-roadmap', title: 'HTTP revision proof', content: '# Original private source',
    } }));
    const changed = await client.callTool({ name: 'edit_doc', arguments: { canvasId: 'product-roadmap', blockId: created.id,
      content: '# Saved native HTTP edit', expectedContentHash: created.contentHash } });
    expect(changed.isError).not.toBe(true);
    const reopened = await new CanvasStore(root).getCanvas('product-roadmap');
    expect(reopened.blocks.find(block => block.id === created.id)?.content).toBe('# Saved native HTTP edit');
    const history = await store.documentHistory('product-roadmap', created.id);
    expect(history.commits[0].author).toBe('Codex - Reviewed writer');
    const entries = (await new CanvasStore(root).mcpActivity()).entries;
    expect(entries.map(entry => [entry.tool, entry.outcome])).toEqual([['edit_doc', 'success'], ['create_doc', 'success']]);
    expect(entries.every(entry => /^[a-f0-9]{40}$/.test(entry.revision ?? ''))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(token);
    expect(JSON.stringify(entries)).not.toContain('# Original private source');
  });

  it('records rejected JSON-RPC batch calls once per attempted tool without dispatching their document writes', async () => {
    const { base, root, store } = await remoteMcpFixture();
    const { token } = await store.createMcpToken('Batch reader', 'read');
    const { transport } = await sdkClient(base, token);
    const before = await store.getCanvas('product-roadmap');
    const batch = [null, 'ignored', 1, { method: 'tools/list' }, { method: 'tools/call' },
      { method: 'tools/call', params: { name: 'bad-name', arguments: null } },
      { method: 'tools/call', params: { name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: 'launch-checklist' } } }];
    const result = await rpcRequest(base, token, batch, transport.sessionId);
    expect(result.status).toBe(400);
    await result.text();
    await expect.poll(async () => (await new CanvasStore(root).mcpActivity()).entries.length).toBe(3);
    const entries = (await new CanvasStore(root).mcpActivity()).entries;
    expect(entries.map(entry => [entry.tool, entry.outcome])).toEqual([['read_doc', 'error'], ['invalid_tool', 'denied'], ['invalid_tool', 'denied']]);
    expect(await new CanvasStore(root).getCanvas('product-roadmap')).toEqual(before);
  });

  it('drops a non-SHA1 revision from the ledger while retaining the successful real document read', async () => {
    const { base, root, store } = await remoteMcpFixture();
    const canvas = await store.getCanvas('product-roadmap');
    const block = canvas.blocks.find(block => block.id === 'launch-checklist');
    if (!block) throw new Error('Missing fixture source');
    const repository = path.join(root, '.versions', block.id);
    await mkdir(repository, { recursive: true });
    execFileSync('git', ['init', '--object-format=sha256', '-q'], { cwd: repository });
    await writeFile(path.join(repository, 'source.md'), block.content);
    execFileSync('git', ['add', 'source.md'], { cwd: repository });
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'SHA256 fixture'], { cwd: repository });
    expect(await store.mcpDocumentRevision(block.id)).toMatch(/^[a-f0-9]{64}$/);
    const { token } = await store.createMcpToken('Revision reader', 'read');
    const { client } = await sdkClient(base, token);
    expect(toolJson<CanvasBlock>(await client.callTool({ name: 'read_doc', arguments: { canvasId: canvas.id, blockId: block.id } })).content).toBe(block.content);
    const entry = (await new CanvasStore(root).mcpActivity()).entries[0];
    expect(entry).toMatchObject({ tool: 'read_doc', outcome: 'success', documentIds: [block.id] });
    expect(entry).not.toHaveProperty('revision');
    expect(await readFile(path.join(repository, 'source.md'), 'utf8')).toBe(block.content);
  });

  it('terminates a session through the installed SDK and rejects further requests with its old ID', async () => {
    const { base, store } = await remoteMcpFixture();
    const baseline = mcpSessionCount();
    const { token } = await store.createMcpToken('Termination reader', 'read');
    const { transport } = await sdkClient(base, token);
    const sessionId = transport.sessionId;
    expect(mcpSessionCount()).toBe(baseline + 1);
    await transport.terminateSession();
    expect(mcpSessionCount()).toBe(baseline);
    expect((await rpcRequest(base, token, listing, sessionId)).status).toBe(404);
  });

  it('uses the internal API credential under workspace authentication and omits the fixed access-token actor suffix', async () => {
    const token = 'protected-workspace-token';
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', token);
    const { base, store, root } = await remoteMcpFixture();
    expect((await fetch(base + '/api/canvases/product-roadmap')).status).toBe(401);
    const { client } = await sdkClient(base, token);
    const created = toolJson<CanvasBlock>(await client.callTool({ name: 'create_doc', arguments: {
      canvasId: 'product-roadmap', title: 'Protected MCP write', content: '# Internal API proof',
    } }));
    expect((await new CanvasStore(root).getCanvas('product-roadmap')).blocks.find(block => block.id === created.id)?.content)
      .toBe('# Internal API proof');
    expect((await store.documentHistory('product-roadmap', created.id)).commits[0].author).toBe('Codex');
  });

  it('keeps proposal tokens read-only when an SDK client attempts document creation or automation Apply', async () => {
    const { base, root, store } = await remoteMcpFixture();
    const { token } = await store.createMcpToken('Proposal agent', 'propose');
    const { client } = await sdkClient(base, token);
    const before = await store.getCanvas('product-roadmap');
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).not.toContain('run_workspace_automation');
    expect(tools).not.toContain('create_doc');
    expect((await client.callTool({ name: 'create_doc', arguments: { canvasId: before.id,
      title: 'Unauthorized document', content: '# Must remain absent',
    } })).isError).toBe(true);
    expect((await client.callTool({ name: 'run_workspace_automation', arguments: { workspaceId: before.workspaceId,
      kind: 'purpose', dryRun: false, runId: 'not-an-approved-run', actionIds: [],
    } })).isError).toBe(true);
    expect(await new CanvasStore(root).getCanvas(before.id)).toEqual(before);
    await vi.waitFor(async () => expect((await store.mcpActivity()).entries.map(entry => [entry.tool, entry.outcome]))
      .toEqual([['run_workspace_automation', 'denied'], ['create_doc', 'denied']]));
  });

  it('checks token revocation on an established SDK session rather than retaining its old authorization', async () => {
    const { base, store } = await remoteMcpFixture();
    const created = await store.createMcpToken('Revoked reader', 'read');
    const { client, transport } = await sdkClient(base, created.token);
    const id = created.settings.mcpTokens?.find(token => token.name === 'Revoked reader')?.id;
    if (!id) throw new Error('Missing stored token ID');
    const revoked = await fetch(base + `/api/mcp/tokens/${id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    expect((await rpcRequest(base, created.token, listing, transport.sessionId)).status).toBe(401);
    await expect(client.listTools()).rejects.toThrow();
  });

  it('honors pre-cancelled SDK tool requests without a document write and keeps the session usable', async () => {
    const { base, root, store } = await remoteMcpFixture();
    const { token } = await store.createMcpToken('Cancellation writer', 'write');
    const { client } = await sdkClient(base, token);
    const before = await store.getCanvas('product-roadmap');
    const controller = new AbortController();
    const reason = new Error('Cancelled before sending the tool request');
    controller.abort(reason);
    await expect(client.callTool({ name: 'create_doc', arguments: { canvasId: before.id,
      title: 'Cancelled document', content: '# Should never be sent',
    } }, undefined, { signal: controller.signal })).rejects.toBe(reason);
    expect(await new CanvasStore(root).getCanvas(before.id)).toEqual(before);
    const recovered = await client.callTool({ name: 'read_doc', arguments: { canvasId: before.id, blockId: 'launch-checklist' } });
    expect(recovered.isError).not.toBe(true);
    expect(toolJson<CanvasBlock>(recovered).id).toBe('launch-checklist');
    expect((await store.mcpActivity()).entries.map(entry => entry.tool)).toEqual(['read_doc']);
  });
});

describe('MCP session namespace regression', () => {
  it('cannot reuse a session against a second TCP server for the same store', async () => {
    const first = await remoteMcpFixture();
    const second = await remoteMcpFixture('127.0.0.1', first.root);
    const { token } = await first.store.createMcpToken('Shared-store reader', 'read');
    const initial = await sdkClient(first.base, token);
    const result = await rpcRequest(second.base, token, listing, initial.transport.sessionId);
    await result.text();
    expect(result.status).toBe(404);
    const own = await sdkClient(second.base, token);
    expect((await own.client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('cannot reuse a session against another store even when both use the same process-wide token identity', async () => {
    vi.stubEnv('SYMBIKNOW_MCP_TOKEN', 'shared-process-mcp-token');
    const first = await remoteMcpFixture();
    const second = await remoteMcpFixture();
    await first.store.updateBlock('product-roadmap', 'launch-checklist', { content: '# Private root A' });
    await second.store.updateBlock('product-roadmap', 'launch-checklist', { content: '# Private root B' });
    const token = 'shared-process-mcp-token';
    const initial = await sdkClient(first.base, token);
    const leaked = await rpcRequest(second.base, token, { jsonrpc: '2.0', id: 71, method: 'tools/call', params: {
      name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: 'launch-checklist' },
    } }, initial.transport.sessionId);
    const leakedText = await leaked.text();
    expect(leaked.status).toBe(404);
    expect(leakedText).not.toContain('Private root A');
    const own = await sdkClient(second.base, token);
    expect(toolJson<CanvasBlock>(await own.client.callTool({ name: 'read_doc', arguments: {
      canvasId: 'product-roadmap', blockId: 'launch-checklist',
    } })).content).toBe('# Private root B');
    const created = toolJson<CanvasBlock>(await own.client.callTool({ name: 'create_doc', arguments: {
      canvasId: 'product-roadmap', title: 'Only in B', content: '# Root B write',
    } }));
    expect((await new CanvasStore(second.root).getCanvas('product-roadmap')).blocks.some(block => block.id === created.id)).toBe(true);
    expect((await new CanvasStore(first.root).getCanvas('product-roadmap')).blocks.some(block => block.id === created.id)).toBe(false);
    expect((await second.store.documentHistory('product-roadmap', created.id)).commits[0].author).toBe('Codex');
  });
});
