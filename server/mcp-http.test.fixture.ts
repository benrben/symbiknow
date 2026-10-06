import { afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const servers: Array<{ server: Server; root: string }> = [];
const connections: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
export async function remoteMcpFixture(host = '127.0.0.1', existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(path.join(tmpdir(), 'symbiknow-mcp-http-'));
  const server = await createApiServer({ dataDir: root });
  servers.push({ server, root });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing MCP server address');
  const clientHost = host === '::1' ? '[::1]' : '127.0.0.1';
  const base = `http://${clientHost}:${address.port}`;
  return { base, root, store: new CanvasStore(root) };
}

export async function sdkClient(base: string, token: string,
  options: { pathToken?: string; headerToken?: string; name?: string } = {}) {
  const endpoint = base + '/mcp' + (options.pathToken ? '/t/' + encodeURIComponent(options.pathToken) : '');
  const client = new Client({ name: options.name ?? 'codex-mcp-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: 'Bearer ' + (options.headerToken ?? token) } },
  });
  connections.push({ client, transport });
  await client.connect(transport);
  return { client, transport };
}

export function rpcHeaders(token: string, sessionId?: string): Record<string, string> {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }) };
}
export function rpcRequest(base: string, token: string, input: unknown, sessionId?: string, method = 'POST') {
  return fetch(base + '/mcp', { method, headers: rpcHeaders(token, sessionId),
    body: input === undefined ? undefined : JSON.stringify(input) });
}
export function toolJson<T>(result: unknown): T {
  const content = (result as { content?: Array<{ text?: unknown }> }).content;
  if (!Array.isArray(content) || typeof content[0]?.text !== 'string') throw new Error('Missing MCP text result');
  return JSON.parse(content[0].text) as T;
}

afterEach(async () => {
  const cleanup = await Promise.allSettled(connections.splice(0).map(async ({ client, transport }) => {
    try { await transport.terminateSession(); }
    catch (error) {
      if (!(error instanceof StreamableHTTPError) || error.code === undefined || ![401, 404].includes(error.code)) throw error;
    } finally { await client.close(); }
  }));
  for (const { server, root } of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
});
