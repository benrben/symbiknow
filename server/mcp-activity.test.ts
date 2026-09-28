import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import { appendMcpActivity, mcpActivityRefs, readMcpActivity, safeMcpError } from './mcp-activity.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('MCP activity ledger', () => {
  it('logs effective scope and denies a remote token targeting another canvas', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-scope-http-'));
    directories.push(dataDir);
    const server = await createApiServer({ dataDir });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      const base = 'http://127.0.0.1:' + address.port;
      const created = await fetch(base + '/api/mcp/tokens', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Scoped agent', access: 'read', allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'] }) });
      expect(created.status).toBe(201);
      const token = (await created.json() as { token: string }).token;
      const client = new Client({ name: 'scoped-client', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'),
        { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
      try {
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['read_doc']);
        const denied = await client.callTool({ name: 'read_doc', arguments: { canvasId: 'other-canvas', blockId: 'launch-checklist' } });
        expect(denied.isError).toBe(true);
        const allowed = await client.callTool({ name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: 'launch-checklist' } });
        expect(allowed.isError).not.toBe(true);
      } finally { await client.close(); }
      const entries = (await new CanvasStore(dataDir).mcpActivity()).entries;
      expect(entries.map(entry => [entry.outcome, entry.canvasIds])).toEqual(expect.arrayContaining([
        ['denied', ['other-canvas']], ['success', ['product-roadmap']],
      ]));
      expect(entries.every(entry => entry.allowedCanvasIds?.join() === 'product-roadmap' && entry.tools?.join() === 'read_doc')).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('keeps only safe IDs, redacts failure details, and bounds persisted entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-activity-'));
    directories.push(root);
    const file = path.join(root, 'activity.json');
    expect(mcpActivityRefs({ canvasId: 'roadmap', blockId: 'doc-1', content: 'secret source',
      mergeBlockIds: ['doc-2', '<unsafe>', 'doc-2'], expectedContentHashes: { 'doc-1': 'secret' } }))
      .toEqual({ canvasIds: ['roadmap'], documentIds: ['doc-1', 'doc-2'] });
    expect(safeMcpError('error', new Error('secret source'))).not.toContain('secret source');
    const base = { tokenId: 'token-1', tokenName: 'agent', access: 'read' as const, tool: 'read_doc',
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', outcome: 'success' as const,
      canvasIds: ['roadmap'], documentIds: ['doc-1'] };
    await writeFile(file, JSON.stringify(Array.from({ length: 500 }, (_, index) => ({ ...base, id: String(index) }))));
    const added = await appendMcpActivity(file, base);
    const entries = (await readMcpActivity(file)).entries;
    expect(entries).toHaveLength(500);
    expect(entries[0].id).toBe(added.id);
    expect(entries.at(-1)?.id).toBe('498');
    expect((await readFile(file, 'utf8'))).not.toContain('secret source');
  });

  it('records remote read, failed, denied, and write calls with token identity and document revision', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-activity-http-'));
    directories.push(dataDir);
    const server = await createApiServer({ dataDir });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      const base = 'http://127.0.0.1:' + address.port;
      const tokenResponse = await fetch(base + '/api/mcp/tokens', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Audit agent', access: 'read' }) });
      const created = await tokenResponse.json() as { token: string; settings: { mcpTokens: Array<{ id: string }> } };
      const client = new Client({ name: 'audit-client', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'),
        { requestInit: { headers: { authorization: 'Bearer ' + created.token } } }));
      try {
        await client.callTool({ name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: 'missing' } });
        await client.callTool({ name: 'read_doc', arguments: { canvasId: 'product-roadmap', content: 'invalid secret argument' } });
        await client.callTool({ name: 'edit_doc', arguments: { canvasId: 'product-roadmap', blockId: 'missing', content: 'secret content' } });
        await client.callTool({ name: 'list_canvases', arguments: {} });
      } finally { await client.close(); }
      const writeResponse = await fetch(base + '/api/mcp/tokens', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Writer', access: 'write' }) });
      const writerToken = (await writeResponse.json() as { token: string }).token;
      const writer = new Client({ name: 'writer-client', version: '1.0.0' });
      await writer.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'),
        { requestInit: { headers: { authorization: 'Bearer ' + writerToken } } }));
      try {
        const createdDoc = await writer.callTool({ name: 'create_doc', arguments: { canvasId: 'product-roadmap', title: 'Activity proof', content: 'private document body' } });
        const document = JSON.parse((createdDoc.content as Array<{ text: string }>)[0].text) as { id: string };
        await writer.callTool({ name: 'delete_doc', arguments: { canvasId: 'product-roadmap', blockId: document.id } });
      } finally { await writer.close(); }
      const store = new CanvasStore(dataDir);
      const entries = (await store.mcpActivity()).entries;
      const apiEntries = await (await fetch(base + '/api/mcp/activity')).json() as { entries: typeof entries };
      expect(apiEntries.entries).toEqual(entries);
      expect(entries.map(entry => [entry.tool, entry.outcome])).toEqual(expect.arrayContaining([
        ['read_doc', 'error'], ['edit_doc', 'denied'], ['list_canvases', 'success'], ['create_doc', 'success'], ['delete_doc', 'success'],
      ]));
      expect(entries.filter(entry => entry.access === 'read').every(entry => entry.tokenId === created.settings.mcpTokens[0].id && entry.tokenName === 'Audit agent')).toBe(true);
      expect(entries.find(entry => entry.tool === 'read_doc' && entry.documentIds.length)?.documentIds).toEqual(['missing']);
      expect(entries.find(entry => entry.tool === 'create_doc')?.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(entries.find(entry => entry.tool === 'delete_doc')?.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(JSON.stringify(entries)).not.toContain(created.token);
      expect(JSON.stringify(entries)).not.toContain('secret content');
      expect(JSON.stringify(entries)).not.toContain('invalid secret argument');
      expect(JSON.stringify(entries)).not.toContain('private document body');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
