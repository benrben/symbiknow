import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { externalTools } from './external-mcp.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('closes a connected client when tool discovery is cancelled', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const mcp = new McpServer({ name: 'discovery-cancellation-fixture', version: '1' });
  mcp.registerTool('ready', { inputSchema: {} }, async () => ({ content: [] }));
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
    entered.resolve();
    await release.promise;
    return { tools: [] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    await transport.handleRequest(request, response, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  close.push(async () => { release.resolve(); await mcp.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const closed = vi.spyOn(Client.prototype, 'close');
  const controller = new AbortController();
  const loading = externalTools([{ id: 'fixture', name: 'Fixture', enabled: true,
    url: `http://127.0.0.1:${address.port}` }], {}, vi.fn(), controller.signal);
  const rejected = expect(loading).rejects.toThrow();
  await entered.promise;
  controller.abort();
  await rejected;
  expect(closed.mock.instances.some(client => (client as Client).getServerVersion()?.name === 'discovery-cancellation-fixture')).toBe(true);
});

it('cancels a remote MCP write before its side effect commits', async () => {
  const entered = deferred<AbortSignal>();
  const release = deferred<void>();
  const cancelled = deferred<void>();
  let saved = false;
  const mcp = new McpServer({ name: 'cancellation-fixture', version: '1' });
  mcp.registerTool('write', { inputSchema: {} }, async (_args, extra) => {
    extra.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    entered.resolve(extra.signal);
    await release.promise;
    if (!extra.signal.aborted) saved = true;
    return { content: [{ type: 'text', text: 'finished' }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    await transport.handleRequest(request, response, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  close.push(async () => { release.resolve(); await mcp.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const loaded = await externalTools([{ id: 'fixture', name: 'Fixture', enabled: true,
    url: `http://127.0.0.1:${address.port}` }], {}, message => { throw new Error(message); });
  close.push(loaded.close);
  const controller = new AbortController();
  const invoked = loaded.tools[0].invoke({}, { signal: controller.signal }).then(
    () => 'completed', () => 'cancelled');
  const remoteSignal = await entered.promise;
  controller.abort();
  const status = await Promise.race([cancelled.promise.then(() => 'cancelled'),
    new Promise<string>(resolve => setTimeout(() => resolve('not cancelled'), 150))]);
  release.resolve();
  await invoked;
  expect(status).toBe('cancelled');
  expect(remoteSignal.aborted).toBe(true);
  expect(saved).toBe(false);
});
