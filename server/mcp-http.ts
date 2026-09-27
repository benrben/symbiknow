import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { bearerToken, internalToken } from './auth.js';
import { createProjectMcpServer } from './mcp.js';
import type { CanvasStore } from './storage.js';

type Session = { transport: StreamableHTTPServerTransport; close: () => Promise<void>; seen: number };

const sessions = new Map<string, Session>();
const idleLimit = 60 * 60 * 1000;

setInterval(() => {
  for (const [id, session] of sessions) {
    if (Date.now() - session.seen > idleLimit) { sessions.delete(id); void session.close(); }
  }
}, 10 * 60 * 1000).unref();

function jsonRpcError(response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length;
    if (bytes > 4_000_000) throw new Error('Request body is too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The API base this process listens on, reached over the same local socket as the incoming request. */
function loopbackApi(request: IncomingMessage): string {
  const address = (request.socket.localAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  const host = address === '::' || address === '0.0.0.0' ? '127.0.0.1' : address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${request.socket.localPort}/api`;
}

/**
 * Remote MCP over Streamable HTTP. Agents on other machines connect with an MCP token from Settings,
 * either as `Authorization: Bearer <token>` or in the path `/mcp/t/<token>` for connectors that cannot set headers.
 */
export async function handleMcpHttp(store: CanvasStore, request: IncomingMessage, response: ServerResponse, pathToken?: string): Promise<void> {
  const tokenName = await store.verifyMcpToken(pathToken || bearerToken(request));
  if (!tokenName) {
    jsonRpcError(response, 401, 'Missing or invalid MCP token. Create one in Settings → Connect agents.', { 'www-authenticate': 'Bearer' });
    return;
  }
  let parsed: unknown;
  try { parsed = await body(request); }
  catch (error) { jsonRpcError(response, 400, error instanceof Error ? error.message : 'Invalid JSON'); return; }

  const sessionId = request.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
  if (existing) {
    existing.seen = Date.now();
    await existing.transport.handleRequest(request, response, parsed);
    return;
  }
  if (sessionId) { jsonRpcError(response, 404, 'Session not found. Start a new MCP session.'); return; }
  if (request.method !== 'POST' || !isInitializeRequest(parsed)) {
    jsonRpcError(response, 400, 'Send an initialize request to start an MCP session.');
    return;
  }

  const server = createProjectMcpServer(loopbackApi(request), fetch, {
    localFiles: false, headers: { authorization: `Bearer ${internalToken}` },
    actorSuffix: tokenName === 'env token' || tokenName === 'access token' ? undefined : tokenName,
  });
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => { sessions.set(id, { transport, close: () => server.close(), seen: Date.now() }); },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  await server.connect(transport);
  await transport.handleRequest(request, response, parsed);
}

export function mcpSessionCount(): number { return sessions.size; }
