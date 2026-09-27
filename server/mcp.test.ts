import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApiServer } from './index.js';
import { createProjectMcpServer } from './mcp.js';

const opened: Array<{ http: Server; dataDir: string }> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { http, dataDir } of opened.splice(0)) {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

describe('project MCP', () => {
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
        'read_canvas', 'upload_file', 'download_file', 'create_branch', 'switch_branch', 'merge_branch', 'restore_revision', 'regroup_canvas',
        'find_duplicates', 'merge_documents', 'undo_merge', 'connect_across_canvases', 'score_documents', 'run_workspace_automation',
      ]));
      const page = await call<{ id: string; kind: string; content: string }>('create_doc', { canvasId: 'product-roadmap', title: 'Page', kind: 'html', content: '<h1>Page</h1>' });
      expect(page).toMatchObject({ kind: 'markdown', content: '---\nformat: html\n---\n<h1>Page</h1>' });
      expect((await call<{ commits: Array<{ author: string }> }>('list_versions', { canvasId: 'product-roadmap', blockId: page.id })).commits[0].author).toBe('SymbiKnow agent');
      vi.stubEnv('SYMBIKNOW_AGENT_NAME', '');
      const legacyPage = await call<{ id: string }>('create_doc', { canvasId: 'product-roadmap', title: 'Legacy agent page' });
      expect((await call<{ commits: Array<{ author: string }> }>('list_versions', { canvasId: 'product-roadmap', blockId: legacyPage.id })).commits[0].author).toBe('Legacy agent');
      const created = await call<{ id: string; content: string }>('upload_file', { canvasId: 'product-roadmap', filename: 'agent.html', content: '<h1>Agent page</h1>' });
      expect(created.content).toContain('format: html');
      const replaced = await call<{ content: string; overwritten: boolean }>('upload_file', { canvasId: 'product-roadmap', blockId: created.id, filename: 'agent.md', content: '# Whole replacement' });
      expect(replaced).toMatchObject({ content: '# Whole replacement', overwritten: true });
      const downloaded = await call<{ content: string }>('download_file', { canvasId: 'product-roadmap', blockId: created.id });
      expect(downloaded.content).toBe('# Whole replacement');
      expect(await readFile(path.join(dataDir, 'docs', `${created.id}.md`), 'utf8')).toBe(downloaded.content);
      await call('create_branch', { canvasId: 'product-roadmap', blockId: created.id, name: 'agents/draft' });
      await call('switch_branch', { canvasId: 'product-roadmap', blockId: created.id, name: 'agents/draft' });
      await call('edit_doc', { canvasId: 'product-roadmap', blockId: created.id, content: '# Branch edit' });
      await call('switch_branch', { canvasId: 'product-roadmap', blockId: created.id, name: 'main' });
      expect((await call<{ content: string }>('read_doc', { canvasId: 'product-roadmap', blockId: created.id })).content).toBe('# Whole replacement');
      await call('merge_branch', { canvasId: 'product-roadmap', blockId: created.id, name: 'agents/draft' });
      expect((await call<{ content: string }>('read_doc', { canvasId: 'product-roadmap', blockId: created.id })).content).toBe('# Branch edit');
      const keep = await call<{ id: string; contentHash: string; content: string }>('read_doc', { canvasId: 'product-roadmap', blockId: page.id });
      const fold = await call<{ id: string; contentHash: string }>('read_doc', { canvasId: 'product-roadmap', blockId: legacyPage.id });
      const merge = await call<{ mergeId: string; archivedBlockIds: string[] }>('merge_documents', {
        canvasId: 'product-roadmap', keepBlockId: keep.id, mergeBlockIds: [fold.id], content: '# Combined page',
        expectedContentHashes: { [keep.id]: keep.contentHash, [fold.id]: fold.contentHash },
      });
      expect(merge.archivedBlockIds).toEqual([fold.id]);
      expect((await call<{ content: string }>('read_doc', { canvasId: 'product-roadmap', blockId: keep.id })).content).toBe('# Combined page');
      expect(await call('undo_merge', { mergeId: merge.mergeId })).toEqual({ mergeId: merge.mergeId, reverted: true });
      expect((await call<{ content: string }>('read_doc', { canvasId: 'product-roadmap', blockId: keep.id })).content).toBe(keep.content);
      expect((await call<{ id: string }>('read_doc', { canvasId: 'product-roadmap', blockId: fold.id })).id).toBe(fold.id);
    } finally { await client.close(); await server.close(); }
  });

  it('maps new Jev tools to preview and analysis routes with safe defaults', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const server = createProjectMcpServer('http://127.0.0.1:8787/api', fetcher);
    const client = new Client({ name: 'test-agent', version: '0.1.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
      await call('find_duplicates', { canvasId: 'canvas-a', blockId: 'doc-a', crossCanvas: true });
      await call('connect_across_canvases', { canvasId: 'canvas-a' });
      await call('score_documents', { canvasId: 'canvas-a' });
      await call('run_workspace_automation', { workspaceId: 'workspace-a', kind: 'tidy' });
      await call('run_workspace_automation', { workspaceId: 'workspace-a', kind: 'tidy', dryRun: false,
        runId: 'run-1', actionIds: ['a-1'] });
      await call('undo_merge', { mergeId: '12345678-1234-1234-1234-123456789abc' });
      const invalidUndo = await call('undo_merge', { mergeId: 'not-a-merge-id' });
      expect(invalidUndo.isError).toBe(true);
      const invalid = await call('merge_documents', { canvasId: 'canvas-a', keepBlockId: 'doc-a',
        mergeBlockIds: ['doc-b'], content: '# Combined', expectedContentHashes: { 'doc-a': 'hash-a' } });
      expect(invalid.isError).toBe(true);
      expect(requests).toEqual([
        { path: '/api/canvases/canvas-a/duplicates', body: { blockId: 'doc-a', crossCanvas: true } },
        { path: '/api/canvases/canvas-a/cross-connections', body: {} },
        { path: '/api/canvases/canvas-a/quality', body: {} },
        { path: '/api/workspaces/workspace-a/automations', body: { kind: 'tidy', dryRun: true } },
        { path: '/api/workspaces/workspace-a/automations', body: { kind: 'tidy', dryRun: false, runId: 'run-1', actionIds: ['a-1'] } },
        { path: '/api/merges/12345678-1234-1234-1234-123456789abc/undo', body: {} },
      ]);
    } finally { await client.close(); await server.close(); }
  });
});
