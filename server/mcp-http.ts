import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { bearerToken, internalToken } from './auth.js';
import { canCallMcpTool, createProjectMcpServer } from './mcp.js';
import { mcpActivityRefs, mcpResultIds, safeMcpError, type McpAccess } from './mcp-activity.js';
import type { CanvasStore } from './storage.js';

type Session = { transport: StreamableHTTPServerTransport; close: () => Promise<void>; seen: number; tokenId: string };
type Identity = { id: string; name: string; access: McpAccess; allowedCanvasIds?: string[]; tools?: string[] };
type ToolCall = { name: string; args: unknown };
type CallContext = { completed: Map<string, number> };

const sessions = new Map<string, Session>();
const callContext = new AsyncLocalStorage<CallContext>();
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

function toolCalls(parsed: unknown): ToolCall[] {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.flatMap(message => {
    if (!message || typeof message !== 'object' || (message as { method?: unknown }).method !== 'tools/call') return [];
    const params = (message as { params?: { name?: unknown; arguments?: unknown } }).params;
    const name = typeof params?.name === 'string' && /^[a-z0-9_]{1,64}$/.test(params.name) ? params.name : 'invalid_tool';
    return [{ name, args: params?.arguments }];
  });
}

async function recordCall(store: CanvasStore, identity: Identity, call: ToolCall, startedAt: string,
  endedAt: string, outcome: 'success' | 'error' | 'denied', result?: unknown, reason?: unknown): Promise<void> {
  const refs = mcpActivityRefs(call.args);
  const returned = mcpResultIds(result);
  if (returned.documentId && !refs.documentIds.includes(returned.documentId)) refs.documentIds.push(returned.documentId);
  let revision = returned.revision;
  const revisionTools = new Set(['create_doc', 'edit_doc', 'delete_doc', 'upload_file', 'merge_documents', 'restore_revision',
    'switch_branch', 'merge_branch', 'read_doc', 'download_file', 'list_versions']);
  if (!revision && outcome === 'success' && revisionTools.has(call.name) && refs.canvasIds.length === 1 && refs.documentIds.length === 1) {
    revision = await store.mcpDocumentRevision(refs.documentIds[0]);
  }
  if (revision && !/^[0-9a-f]{40}$/i.test(revision)) revision = undefined;
  await store.recordMcpActivity({ tokenId: identity.id, tokenName: identity.name, access: identity.access,
    ...(identity.allowedCanvasIds ? { allowedCanvasIds: identity.allowedCanvasIds } : {}),
    ...(identity.tools ? { tools: identity.tools } : {}),
    tool: call.name, startedAt, endedAt, outcome, ...(outcome === 'success' ? {} : { error: safeMcpError(outcome, reason) }),
    ...refs, ...(revision ? { revision } : {}) });
}

async function dispatch(store: CanvasStore, identity: Identity, transport: StreamableHTTPServerTransport,
  request: IncomingMessage, response: ServerResponse, parsed: unknown): Promise<void> {
  const startedAt = new Date().toISOString();
  const calls = toolCalls(parsed);
  const context: CallContext = { completed: new Map() };
  try { await callContext.run(context, () => transport.handleRequest(request, response, parsed)); }
  finally {
    for (const call of calls) {
      const completed = context.completed.get(call.name) ?? 0;
      if (completed) { context.completed.set(call.name, completed - 1); continue; }
      const denied = !canCallMcpTool(identity.access, call.name, identity.tools);
      await recordCall(store, identity, call, startedAt, new Date().toISOString(), denied ? 'denied' : 'error');
    }
  }
}

/**
 * Remote MCP over Streamable HTTP. Agents on other machines connect with an MCP token from Settings,
 * either as `Authorization: Bearer <token>` or in the path `/mcp/t/<token>` for connectors that cannot set headers.
 */
export async function handleMcpHttp(store: CanvasStore, request: IncomingMessage, response: ServerResponse, pathToken?: string): Promise<void> {
  const identity = await store.mcpTokenIdentity(pathToken || bearerToken(request));
  if (!identity) {
    jsonRpcError(response, 401, 'Missing or invalid MCP token. Create one in Settings → Connect agents.', { 'www-authenticate': 'Bearer' });
    return;
  }
  let parsed: unknown;
  try { parsed = await body(request); }
  catch (error) { jsonRpcError(response, 400, error instanceof Error ? error.message : 'Invalid JSON'); return; }

  const sessionId = request.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
  if (existing) {
    if (existing.tokenId !== identity.id) { jsonRpcError(response, 403, 'This MCP session belongs to another token.'); return; }
    existing.seen = Date.now();
    await dispatch(store, identity, existing.transport, request, response, parsed);
    return;
  }
  if (sessionId) { jsonRpcError(response, 404, 'Session not found. Start a new MCP session.'); return; }
  if (request.method !== 'POST' || !isInitializeRequest(parsed)) {
    jsonRpcError(response, 400, 'Send an initialize request to start an MCP session.');
    return;
  }

  const server = createProjectMcpServer(loopbackApi(request), fetch, {
    localFiles: false, headers: { authorization: `Bearer ${internalToken}` },
    actorSuffix: identity.name === 'env token' || identity.name === 'access token' ? undefined : identity.name,
    access: identity.access,
    allowedCanvasIds: identity.allowedCanvasIds,
    tools: identity.tools,
    onToolCall: async event => {
      const context = callContext.getStore();
      context?.completed.set(event.tool, (context.completed.get(event.tool) ?? 0) + 1);
      await recordCall(store, identity, { name: event.tool, args: event.args }, event.startedAt, event.endedAt,
        event.outcome, event.result);
    },
  });
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => { sessions.set(id, { transport, close: () => server.close(), seen: Date.now(), tokenId: identity.id }); },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  await server.connect(transport);
  await dispatch(store, identity, transport, request, response, parsed);
}

export function mcpSessionCount(): number { return sessions.size; }
