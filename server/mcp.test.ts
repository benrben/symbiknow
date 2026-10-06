import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApiServer } from './index.js';
import { createProjectMcpServer } from './mcp.js';
import { CanvasStore } from './storage.js';

const opened: Array<{ http: Server; dataDir: string }> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { http, dataDir } of opened.splice(0)) {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
  for (const dataDir of temporaryDirectories.splice(0)) await rm(dataDir, { recursive: true, force: true });
});

describe('project MCP', () => {
  it('validates and exposes token canvas and tool scope', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-mcp-scope-'));
    const store = new CanvasStore(dataDir);
    temporaryDirectories.push(dataDir);
    await store.init();
    const created = await store.createMcpToken('Scoped reader', 'read', { allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'] });
    expect(created.settings.mcpTokens?.[0]).toMatchObject({ name: 'Scoped reader', access: 'read',
      allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'] });
    expect(await store.mcpTokenIdentity(created.token)).toMatchObject({ allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'] });
    await expect(store.createMcpToken('Bad canvas', 'read', { allowedCanvasIds: ['missing'] })).rejects.toMatchObject({ status: 400 });
    await expect(store.createMcpToken('Bad tool', 'read', { tools: ['edit_doc'] })).rejects.toMatchObject({ status: 400 });
    await expect(store.createMcpToken('Unknown tool', 'write', { tools: ['unknown_tool'] })).rejects.toMatchObject({ status: 400 });
  });

  it('enforces canvas scope for direct reads and search results', async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname === '/api/workspaces') return Response.json([{ id: 'team', name: 'Team', canvases: [
        { id: 'canvas-a', name: 'A' }, { id: 'canvas-b', name: 'B' }] }]);
      if (url.pathname === '/api/search') return Response.json([{ canvasId: 'canvas-a', blockId: 'a' }, { canvasId: 'canvas-b', blockId: 'b' }]);
      return Response.json({ id: 'canvas-a', blocks: [] });
    }) as unknown as typeof fetch;
    const server = createProjectMcpServer('http://127.0.0.1:8787/api', fetcher, {
      access: 'write', allowedCanvasIds: ['canvas-a'], tools: ['list_canvases', 'read_canvas', 'search_docs'],
    });
    const client = new Client({ name: 'scoped-agent', version: '0.1.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).not.toContain('edit_doc');
      const parse = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        return { response, value: response.isError ? null : JSON.parse((response.content as Array<{ text: string }>)[0].text) as unknown };
      };
      expect((await parse('list_canvases', {})).value).toMatchObject([{ canvases: [{ id: 'canvas-a' }] }]);
      expect((await parse('search_docs', { query: 'plan' })).value).toEqual([{ canvasId: 'canvas-a', blockId: 'a' }]);
      expect((await parse('read_canvas', { canvasId: 'canvas-b' })).response.isError).toBe(true);
      expect((await parse('read_canvas', { canvasId: 'canvas-a' })).response.isError).not.toBe(true);
      expect((await parse('connect_across_canvases', { canvasId: 'canvas-a' })).response.isError).toBe(true);
      expect((await parse('find_duplicates', { canvasId: 'canvas-a', crossCanvas: true })).response.isError).toBe(true);
      expect((await parse('run_workspace_automation', { workspaceId: 'team', kind: 'tidy' })).response.isError).toBe(true);
      expect(requests).not.toContain('/api/canvases/canvas-b');
      expect(requests).not.toContain('/api/canvases/canvas-a/cross-connections');
      expect(requests).not.toContain('/api/workspaces/team/automations');
    } finally { await client.close(); await server.close(); }
  });
  it('limits read and propose tokens to their advertised tools and blocks proposal execution', async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => { requests.push(String(input)); return Response.json({ ok: true }); }) as unknown as typeof fetch;
    for (const access of ['read', 'propose'] as const) {
      const server = createProjectMcpServer('http://127.0.0.1:8787/api', fetcher, { access });
      const client = new Client({ name: 'limited-agent', version: '0.1.0' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      try {
        const names = (await client.listTools()).tools.map(tool => tool.name);
        expect(names).toContain('read_doc');
        expect(names).not.toContain('edit_doc');
        expect(names).not.toContain('create_task');
        expect(names).not.toContain('run_workspace_automation');
        if (access === 'propose') {
          const denied = await client.callTool({ name: 'run_workspace_automation', arguments: {
            workspaceId: 'workspace-a', kind: 'tidy', dryRun: false, actionIds: ['a-1'],
          } });
          expect(denied.isError).toBe(true);
        }
      } finally { await client.close(); await server.close(); }
    }
    expect(requests).toEqual([]);
  });
  it('shares the HTTP canvas with agents and supports full file transfer and branches', async () => {
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'local-access');
    vi.stubEnv('ALLTEAM_AGENT_NAME', 'Legacy agent');
    vi.stubEnv('SYMBIKNOW_AGENT_NAME', 'SymbiKnow agent');
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-mcp-'));
    const http = await createApiServer({ dataDir });
    opened.push({ http, dataDir });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const server = createProjectMcpServer(`http://127.0.0.1:${address.port}/api`);
    const client = new Client({ name: 'test-agent', version: '0.1.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect(client.getServerVersion()?.name).toBe('symbiknow');
    expect(client.getInstructions()).toContain('people and AI organize ideas and build knowledge together');
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const output = await client.callTool({ name, arguments: args });
      if (output.isError) throw new Error(JSON.stringify(output.content));
      return JSON.parse(((output.content as Array<{ text: string }>)[0]).text) as T;
    };
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'read_canvas', 'upload_file', 'download_file', 'create_branch', 'switch_branch', 'merge_branch', 'restore_revision', 'search_docs', 'create_doc', 'edit_doc', 'create_task', 'update_task', 'list_tasks',
      ]));
      const page = await call<{ id: string; kind: string; content: string }>('create_doc', { canvasId: 'product-roadmap', title: 'Page', kind: 'html', content: '<h1>Page</h1>' });
      expect(page).toMatchObject({ kind: 'html', content: '---\nformat: html\n---\n<h1>Page</h1>' });
      expect((await call<{ commits: Array<{ author: string }> }>('list_versions', { canvasId: 'product-roadmap', blockId: page.id })).commits[0].author).toBe('SymbiKnow agent');
      vi.stubEnv('SYMBIKNOW_AGENT_NAME', '');
      const legacyPage = await call<{ id: string }>('create_doc', { canvasId: 'product-roadmap', title: 'Legacy agent page' });
      expect((await call<{ commits: Array<{ author: string }> }>('list_versions', { canvasId: 'product-roadmap', blockId: legacyPage.id })).commits[0].author).toBe('Legacy agent');
      const created = await call<{ id: string; content: string }>('upload_file', { canvasId: 'product-roadmap', filename: 'agent.html', content: '<h1>Agent page</h1>' });
      expect(created.content).toContain('format: html');
      const createdHash = (await call<{ contentHash: string }>('read_doc', { canvasId: 'product-roadmap', blockId: created.id })).contentHash;
      const replaced = await call<{ content: string; overwritten: boolean; contentHash: string }>('upload_file', { canvasId: 'product-roadmap', blockId: created.id,
        filename: 'agent.md', content: '# Whole replacement', expectedContentHash: createdHash });
      expect(replaced).toMatchObject({ content: '# Whole replacement', overwritten: true });
      const downloaded = await call<{ content: string }>('download_file', { canvasId: 'product-roadmap', blockId: created.id });
      expect(downloaded.content).toBe('# Whole replacement');
      expect(await readFile(path.join(dataDir, 'docs', `${created.id}.md`), 'utf8')).toBe(downloaded.content);
      await call('create_branch', { canvasId: 'product-roadmap', blockId: created.id, name: 'agents/draft' });
      await call('switch_branch', { canvasId: 'product-roadmap', blockId: created.id, name: 'agents/draft' });
      await call('edit_doc', { canvasId: 'product-roadmap', blockId: created.id, content: '# Branch edit', expectedContentHash: replaced.contentHash });
      await call('switch_branch', { canvasId: 'product-roadmap', blockId: created.id, name: 'main' });
      expect((await call<{ content: string }>('read_doc', { canvasId: 'product-roadmap', blockId: created.id })).content).toBe('# Whole replacement');
      await call('merge_branch', { canvasId: 'product-roadmap', blockId: created.id, name: 'agents/draft' });
      expect((await call<{ content: string }>('read_doc', { canvasId: 'product-roadmap', blockId: created.id })).content).toBe('# Branch edit');
      expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['ask_symbi', 'symbi_reflex', 'delete_task', 'delete_branch']));
      expect(tools.tools.map(tool => tool.name)).not.toContain('jev_do');
      expect(client.getInstructions()).not.toContain('Jev');
      for (const name of ['recall', 'analyze_canvas', 'regroup_canvas', 'find_duplicates', 'merge_documents', 'undo_merge',
        'connect_across_canvases', 'score_documents', 'run_workspace_automation']) {
        expect(tools.tools.some(tool => tool.name === name)).toBe(false);
        expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
      }
      const task = await call<{ id: string }>('create_task', { canvasId: 'product-roadmap', title: 'Native review', blockIds: [page.id] });
      await call('update_task', { canvasId: 'product-roadmap', taskId: task.id, status: 'done' });
      expect(await call('list_tasks', { canvasId: 'product-roadmap' })).toEqual(await new CanvasStore(dataDir).listTasks('product-roadmap'));
      expect((await new CanvasStore(dataDir).listTasks('product-roadmap'))[0]).toMatchObject({ id: task.id, status: 'done', blockIds: [page.id] });
    } finally { await client.close(); await server.close(); }
  });
});
