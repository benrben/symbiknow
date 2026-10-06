import { afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function requestBody(request: IncomingMessage): Promise<{ method?: string } | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { method?: string } : undefined;
}

export async function notebook(root: string) {
  const entered = deferred<AbortSignal>();
  const release = deferred<void>();
  const notebookFile = path.join(root, 'connected-notebook.md');
  await writeFile(notebookFile, 'The release requires QA approval.');
  const boundary = { holdListing: false, rejectListing: false, rejectConnect: false, calls: [] as string[],
    requests: [] as Array<{ method: string | undefined; rpc: string | undefined; authorization: string | undefined }>,
    streams: new Set<ServerResponse>(), closedStreams: 0 };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const connections: McpServer[] = [];

  async function connectedTransport(): Promise<StreamableHTTPServerTransport> {
    const mcp = new McpServer({ name: 'Native connected notebook', version: '1' });
    connections.push(mcp);
    mcp.registerTool('read_note', { description: 'Read the connected release notebook', inputSchema: {} }, async () => {
      boundary.calls.push('read_note');
      return { content: [{ type: 'text', text: await readFile(notebookFile, 'utf8') }] };
    });
    mcp.registerTool('write_note', { description: 'Update the connected release notebook', inputSchema: { text: z.string() } }, async ({ text }) => {
      boundary.calls.push('write_note');
      await writeFile(notebookFile, text);
      return { content: [{ type: 'text', text: await readFile(notebookFile, 'utf8') }] };
    });
    mcp.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      entered.resolve(extra.signal);
      if (boundary.holdListing) await release.promise;
      if (boundary.rejectListing) throw new McpError(ErrorCode.InternalError, 'Native notebook discovery failed');
      return { tools: [
        { name: 'read_note', description: 'Read the connected release notebook', inputSchema: { type: 'object' as const, properties: {} } },
        { name: 'write_note', description: 'Update the connected release notebook', inputSchema: { type: 'object' as const,
          properties: { text: { type: 'string' } }, required: ['text'] } },
      ] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { sessions.set(id, transport); } });
    await mcp.connect(transport);
    return transport;
  }

  async function requestedTransport(request: IncomingMessage, body: { method?: string } | undefined) {
    const id = request.headers['mcp-session-id'];
    if (typeof id === 'string') return sessions.get(id);
    if (body?.method !== 'initialize') return undefined;
    return connectedTransport();
  }

  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    boundary.requests.push({ method: request.method, rpc: body?.method, authorization: request.headers.authorization });
    if (boundary.rejectConnect) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":"Native notebook offline"}');
      return;
    }
    const transport = await requestedTransport(request, body);
    if (!transport) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.method === 'GET') {
      boundary.streams.add(response);
      response.on('close', () => { boundary.streams.delete(response); boundary.closedStreams++; });
    }
    await transport.handleRequest(request, response, body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { release.resolve(); await Promise.all(connections.map(connection => connection.close())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native MCP fixture port');
  const config = { id: 'notes', name: 'Connected notebook', url: `http://127.0.0.1:${address.port}`, enabled: true };
  return { boundary, config, notebookFile, entered, release };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
