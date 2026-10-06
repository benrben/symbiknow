import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApiServer } from './index.js';
import { createProjectMcpServer } from './mcp.js';
import { CanvasStore } from './storage.js';

it('keeps a three-document MCP review fixture scoped, bounded, read-only, and offline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-mcp-review-'));
  let api: Awaited<ReturnType<typeof createApiServer>> | undefined;
  let mcp: ReturnType<typeof createProjectMcpServer> | undefined;
  let client: Client | undefined;
  try {
    vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '1');
    vi.stubEnv('SYMBI_MODEL_ROOT', '');
    const store = new CanvasStore(root);
    await store.init();
    const workspace = (await store.listWorkspaces())[0];
    const allowed = await store.createCanvas(workspace.id, { name: 'Operations evidence' });
    const privateCanvas = await store.createCanvas(workspace.id, { name: 'Private evidence' });
    const runbook = await store.createBlock(allowed.id, { title: 'Rollback anchor', content: '# Rollback anchor\nRestore the prior release.' });
    await store.createBlock(allowed.id, { title: 'Release notes', content: '# Release notes\nCheck service health.' });
    await store.createBlock(privateCanvas.id, { title: 'Private nebula cipher', content: '# Private nebula cipher\nKeep hidden.' });
    const before = await readFile(path.join(root, runbook.file), 'utf8');
    const { token } = await store.createMcpToken('Review reader', 'read', { allowedCanvasIds: [allowed.id] });
    const provider = vi.fn(async () => { throw new Error('Review fixture must not call a provider'); }) as unknown as typeof fetch;
    api = await createApiServer({ dataDir: root, fetcher: provider });
    await new Promise<void>(resolve => api!.listen(0, '127.0.0.1', resolve));
    const address = api.address();
    if (!address || typeof address === 'string') throw new Error('Missing review fixture port');
    mcp = createProjectMcpServer(`http://127.0.0.1:${address.port}/api`, fetch, { access: 'read',
      allowedCanvasIds: [allowed.id], headers: { authorization: `Bearer ${token}` } });
    client = new Client({ name: 'review-fixture', version: '1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['ask_symbi', 'symbi_reflex', 'read_canvas', 'search_docs', 'read_doc']));
    expect(tools).not.toContain('jev_do');
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client!.callTool({ name, arguments: args });
      const text = (response.content as Array<{ text: string }>)[0].text;
      return { error: response.isError === true,
        value: response.isError ? { error: text } : JSON.parse(text) as Record<string, unknown> };
    };
    const listed = (await call('list_canvases')).value as unknown as Array<{ canvases: Array<Record<string, unknown>> }>;
    expect(listed.flatMap(item => item.canvases)).toEqual([expect.objectContaining({ id: allowed.id,
      documentCount: 2, lastUpdatedMeaning: 'canvas metadata file modification time', lastUpdatedAt: expect.any(String) })]);
    const firstPage = (await call('read_canvas', { canvasId: allowed.id, includeContent: false, limit: 1 })).value;
    expect(firstPage).toMatchObject({ blocks: [expect.objectContaining({ content: '', contentLoaded: false })], totalBlocks: 2,
      nextCursor: '1' });
    const secondPage = (await call('read_canvas', { canvasId: allowed.id, includeContent: false, limit: 1, cursor: '1' })).value;
    expect(secondPage).toMatchObject({ blocks: [expect.objectContaining({ content: '', contentLoaded: false })], totalBlocks: 2 });
    expect((await call('read_canvas', { canvasId: privateCanvas.id })).error).toBe(true);
    expect((await call('read_doc', { canvasId: allowed.id, blockId: runbook.id })).value)
      .toMatchObject({ content: before, contentHash: runbook.contentHash });
    expect((await call('read_doc', { canvasId: privateCanvas.id, blockId: runbook.id })).error).toBe(true);
    const search = (await call('search_docs', { query: 'rollback anchor', canvasId: allowed.id, limit: 1 })).value;
    expect(search).toMatchObject({ items: [expect.objectContaining({ canvasId: allowed.id, blockId: runbook.id,
      matchIn: 'title' })] });
    const hiddenSearch = (await call('search_docs', { query: 'nebula cipher', limit: 5 })).value;
    expect(hiddenSearch).toMatchObject({ items: [] });
    const semantic = (await call('ask_symbi', { question: 'rollback anchor', mode: 'semantic', canvasId: allowed.id })).value;
    expect(semantic.providerUsage).toMatchObject({ requests: 0 });
    expect((semantic.matches as Array<{ canvasId: string }>).every(item => item.canvasId === allowed.id)).toBe(true);
    const checked = (await call('symbi_reflex', { claim: 'The runbook says to restore the prior release',
      canvasId: allowed.id, documentIds: [runbook.id] })).value;
    expect(checked.verdict).toBe('insufficient_evidence');
    expect(checked.providerUsage).toMatchObject({ requests: 0 });
    expect((checked.passages as Array<{ canvasId: string }>).every(item => item.canvasId === allowed.id)).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, runbook.file), 'utf8')).toBe(before);
  } finally {
    await client?.close();
    await mcp?.close();
    if (api) { api.closeAllConnections(); await new Promise<void>(resolve => api!.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
