import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createProjectMcpServer } from './mcp.js';

const connections: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  vi.restoreAllMocks();
});

async function fixture() {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let missingJob = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const request = { path: url.pathname + url.search, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    requests.push(request);
    if (request.path === '/api/canvases/canvas%2Fone/blocks/doc%2Fone') return Response.json({ title: 'Fallback source' });
    if (request.path.includes('/progress')) return Response.json({ documents: [{ jobId: 'job-1', durable: true }] });
    if (request.path.includes('view=jev_job')) return Response.json(missingJob ? null : { id: 'job-1', state: 'complete' });
    return Response.json({ path: request.path, body: request.body });
  }) as unknown as typeof fetch;
  const server = createProjectMcpServer('http://127.0.0.1:8787/api', fetcher, { legacyBrainTools: true });
  const client = new Client({ name: 'jev-compat-boundary', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  connections.push({ client, server });
  async function call(name: string, args: Record<string, unknown>) {
    const output = await client.callTool({ name, arguments: args });
    const text = (output.content as Array<{ text: string }>)[0].text;
    return { output, text, value: output.isError ? undefined : JSON.parse(text) as Record<string, unknown> };
  }
  async function read(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await call(name, args);
    if (response.output.isError) throw new Error(response.text);
    return response.value!;
  }
  return { call, read, requests, setMissingJob: (value: boolean) => { missingJob = value; } };
}

it('preserves compatibility read routes, block-title fallback and encoded state paging', async () => {
  const f = await fixture();
  const canvasId = 'canvas/one';
  expect((await f.read('find_by', { canvasId, query: 'release' })).body)
    .toMatchObject({ question: 'release', mode: 'semantic', canvasId });
  expect((await f.read('find_by', { canvasId, blockId: 'doc/one', limit: 7, cursor: 'page/2' })).body)
    .toMatchObject({ question: 'Fallback source', limit: 7, cursor: 'page/2' });
  expect((await f.read('find_by', { canvasId })).body).toMatchObject({ question: '' });
  expect((await f.read('related', { canvasId, blockId: 'doc/one', limit: 7, cursor: 'page/2' })).body)
    .toMatchObject({ canvasId, blockId: 'doc/one', limit: 7, cursor: 'page/2' });
  expect((await f.read('jev_profile', { canvasId, blockId: 'doc/one', query: 'release', limit: 7, cursor: 'page/2' })).path)
    .toBe('/api/canvases/canvas%2Fone/jev/agent/state?view=jev_profile&blockId=doc%2Fone&query=release&limit=7&cursor=page%2F2');
  expect((await f.read('memory_map', { canvasId })).path)
    .toBe('/api/canvases/canvas%2Fone/jev/agent/state?view=memory_map');
  expect(f.requests.map(request => [request.method, request.path])).toEqual([
    ['POST', '/api/symbi/find'], ['GET', '/api/canvases/canvas%2Fone/blocks/doc%2Fone'],
    ['POST', '/api/symbi/find'], ['POST', '/api/symbi/find'], ['POST', '/api/symbi/related'],
    ['GET', '/api/canvases/canvas%2Fone/jev/agent/state?view=jev_profile&blockId=doc%2Fone&query=release&limit=7&cursor=page%2F2'],
    ['GET', '/api/canvases/canvas%2Fone/jev/agent/state?view=memory_map'],
  ]);
});

it('keeps scoped job progress and makes missing jobs visible', async () => {
  const f = await fixture();
  expect(await f.read('jev_job', { canvasId: 'canvas/one', jobId: 'job-1' }))
    .toMatchObject({ id: 'job-1', progress: { jobId: 'job-1', durable: true } });
  f.setMissingJob(true);
  const missing = await f.call('jev_job', { canvasId: 'canvas/one', jobId: 'missing' });
  expect(missing.output.isError).toBe(true);
  expect(missing.text).toContain('Job not found in the granted scope');
});
