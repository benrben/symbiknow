import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { internalToken } from './auth.js';
import { createProjectMcpServer } from './mcp.js';
import { recordMcpToolEvent } from './mcp-http-activity.js';
import { loopbackApi } from './mcp-http-protocol.js';
import type { McpHttpIdentity, McpHttpSession } from './mcp-http-types.js';
import type { CanvasStore } from './storage.js';
import { jevPrincipalHeaders, currentMcpIdentity } from './jev-api-principal.js';

const sessions = new Map<string, McpHttpSession>();
const idleLimit = 60 * 60 * 1000;

function expireIdleSessions(): void {
  for (const [id, session] of sessions) {
    if (Date.now() - session.seen > idleLimit) { sessions.delete(id); void session.close(); }
  }
}
setInterval(expireIdleSessions, 10 * 60 * 1000).unref();

export function existingSession(store: CanvasStore, request: IncomingMessage): McpHttpSession | undefined {
  const id = request.headers['mcp-session-id'];
  if (typeof id !== 'string') return undefined;
  const session = sessions.get(id);
  if (!session || session.storeRoot !== store.root || session.localPort !== request.socket.localPort) return undefined;
  return session;
}

function actorSuffix(identity: McpHttpIdentity): string | undefined {
  return ['env token', 'access token'].includes(identity.name) ? undefined : identity.name;
}

export async function createHttpMcpTransport(store: CanvasStore, identity: McpHttpIdentity,
  request: IncomingMessage): Promise<StreamableHTTPServerTransport> {
  const server = createProjectMcpServer(loopbackApi(request), fetch, {
    localFiles: false, headers: { authorization: `Bearer ${internalToken}`, ...jevPrincipalHeaders(identity.id) }, actorSuffix: actorSuffix(identity),
    access: identity.access, allowedCanvasIds: identity.allowedCanvasIds, tools: identity.tools,
    callerId: identity.id, canApprove: identity.canApprove, canConfigure: identity.canConfigure,
    resolvePermissions: () => currentMcpIdentity(store, identity.id),
    onToolCall: event => recordMcpToolEvent(store, identity, event),
  });
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => { sessions.set(id, { transport, close: () => server.close(), seen: Date.now(), tokenId: identity.id,
      storeRoot: store.root, localPort: request.socket.localPort }); },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  await server.connect(transport);
  return transport;
}

export function mcpSessionCount(): number { return sessions.size; }
