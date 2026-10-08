import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { acceptanceReflexProvider } from '../features/acceptance-reflex-provider.js';
import { createApiServer } from './index.js';
import { createProjectMcpServer } from './mcp.js';
import { CanvasStore } from './storage.js';
import type { JevJob, JevWorkspaceState } from '../shared/jev-types.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native HTTP address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
function decoded(result: Awaited<ReturnType<Client['callTool']>>): JevJob {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as JevJob;
}

it('preserves native scoped MCP read arguments and bounded request jobs, rejects missing jobs and foreign canvas access', async () => {
  for (const key of ['SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'SYMBIKNOW_MCP_TOKEN', 'ALLTEAM_MCP_TOKEN', 'CANVAS_API_TOKEN']) vi.stubEnv(key, '');
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-reflex-api-boundary-'));
  const provider = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const result = await acceptanceReflexProvider('https://api.typesafe.ai/v1/systemone', { method: 'POST', body });
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(await result.text());
  });
  const providerBase = await listen(provider);
  const api = await createApiServer({ dataDir: root, fetcher: (_url, options) => fetch(providerBase, options) });
  const base = await listen(api);
  const request = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + '/api' + route,
    { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const store = new CanvasStore(root);
  const token = await store.createMcpToken('Scoped native boundary', 'propose', { allowedCanvasIds: ['product-roadmap'],
    tools: ['jev_profile', 'find_by', 'jev_do', 'jev_job'] });
  const headers = { authorization: `Bearer ${token.token}` };
  const mcp = createProjectMcpServer(base + '/api', fetch, { headers,  });
  const client = new Client({ name: 'scoped-boundary-client', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    expect((await request('/canvases/product-roadmap/jev')).status).toBe(200);
    const denied = await request('/canvases/engineering/jev/agent/state?view=jev_profile', 'GET', undefined, headers);
    expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ error: 'This caller does not permit those tool arguments or canvases' });
    const unknown = await request('/canvases/nonexistent/jev/agent/state?view=jev_profile', 'GET', undefined, headers);
    expect(unknown.status).toBe(403); expect(await unknown.json()).toEqual({ error: 'This caller does not permit those tool arguments or canvases' });
    await request('/settings', 'PUT', { secrets: { TYPESAFE_API_KEY: 'native-boundary-key' } });
    expect((await request('/canvases/product-roadmap/jev/settings', 'PUT', { externalProcessing: true,
      modes: { profile: 'auto' } })).status).toBe(200);
    await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('recall');
    expect((await client.callTool({ name: 'recall', arguments: { canvasId: 'product-roadmap', query: 'launch' } })).isError).toBe(true);
    const read = await client.callTool({ name: 'find_by', arguments: { canvasId: 'product-roadmap', blockId: 'roadmap-overview', query: 'launch' } });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    const first = decoded(await client.callTool({ name: 'jev_do', arguments: { action: 'profile', canvasId: 'product-roadmap', query: 'launch', blockIds: ['roadmap-overview'] } }));
    const second = decoded(await client.callTool({ name: 'jev_do', arguments: { action: 'profile', canvasId: 'product-roadmap', query: 'launch delivery', blockIds: ['roadmap-overview'] } }));
    expect(first.request).toMatchObject({ action: 'profile', query: 'launch', blockIds: ['roadmap-overview'] });
    expect(second.request).toMatchObject({ action: 'profile', query: 'launch delivery', blockIds: ['roadmap-overview'] });
    await expect.poll(async () => {
      const state = await request('/canvases/product-roadmap/jev').then(response => response.json()) as JevWorkspaceState;
      return [first.id, second.id].map(id => state.jobs.find(job => job.id === id)?.state);
    }).toEqual(['completed', 'completed']);
    expect((await client.callTool({ name: 'jev_job', arguments: { canvasId: 'product-roadmap', jobId: first.id } })).isError).not.toBe(true);
    const missing = await client.callTool({ name: 'jev_job', arguments: { canvasId: 'product-roadmap', jobId: 'missing' } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0].text).toContain('Job not found in the granted scope');
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'roadmap-overview')?.headline).toBeUndefined();
  } finally {
    await client.close(); await mcp.close(); await close(api); await close(provider);
    await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  }
});
