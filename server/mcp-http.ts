import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken } from './auth.js';
import type { CanvasStore } from './storage.js';
import { dispatchMcpRequest } from './mcp-http-activity.js';
import { jsonRpcError, parseMcpBody, requiresInitialization } from './mcp-http-protocol.js';
import { existingSession, createHttpMcpTransport } from './mcp-http-sessions.js';
import type { McpHttpIdentity, McpHttpSession } from './mcp-http-types.js';

export { mcpSessionCount } from './mcp-http-sessions.js';

async function authenticate(store: CanvasStore, request: IncomingMessage, response: ServerResponse, pathToken?: string) {
  const identity = await store.mcpTokenIdentity(pathToken || bearerToken(request));
  if (!identity) jsonRpcError(response, 401, 'Missing or invalid MCP token. Create one in Settings → Connect agents.',
    { 'www-authenticate': 'Bearer' });
  return identity;
}

async function dispatchExisting(store: CanvasStore, identity: McpHttpIdentity, existing: McpHttpSession,
  request: IncomingMessage, response: ServerResponse, parsed: unknown): Promise<void> {
  if (existing.tokenId !== identity.id) { jsonRpcError(response, 403, 'This MCP session belongs to another token.'); return; }
  existing.seen = Date.now();
  await dispatchMcpRequest(store, identity, existing.transport, request, response, parsed);
}

/**
 * Remote MCP over Streamable HTTP. Agents connect with a token from Settings,
 * as Authorization: Bearer <token> or in /mcp/t/<token> when they cannot set headers.
 */
export async function handleMcpHttp(store: CanvasStore, request: IncomingMessage, response: ServerResponse, pathToken?: string): Promise<void> {
  const identity = await authenticate(store, request, response, pathToken);
  if (!identity) return;
  const parsed = await parseMcpBody(request, response);
  if (!parsed.ok) return;
  const existing = existingSession(store, request);
  if (existing) { await dispatchExisting(store, identity, existing, request, response, parsed.value); return; }
  if (!requiresInitialization(request, response, parsed.value)) return;
  const transport = await createHttpMcpTransport(store, identity, request);
  await dispatchMcpRequest(store, identity, transport, request, response, parsed.value);
}
