import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { RouteContext } from './api-context.js';
import { readBody, sendJson } from './api-http.js';
import { ApiError } from './errors.js';
import { internalToken } from './auth.js';
import { workspaceOwnerPrincipal, jevPrincipalHeaders } from './jev-api-principal.js';
import { createProjectMcpServer } from './mcp.js';
import { createStoreApiFetcher } from './api-inprocess.js';
import { recordMcpToolEvent } from './mcp-http-activity.js';

const callSchema = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }).strict();

async function browserMcp(context: RouteContext, operation: (client: Client) => Promise<unknown>): Promise<unknown> {
  const server = createProjectMcpServer('http://symbi.internal/api', createStoreApiFetcher(context.store, context), {
    localFiles: false, callerId: 'browser-owner', access: 'write', canApprove: true, canConfigure: true,
    headers: { authorization: `Bearer ${internalToken}`, ...jevPrincipalHeaders('browser-owner') },
    onToolCall: event => recordMcpToolEvent(context.store, { id: 'browser-owner', name: 'Browser agent', access: 'write' }, event),
  });
  const client = new Client({ name: 'browser-agent', version: '0.2.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    return await operation(client);
  } finally { await Promise.all([client.close(), server.close()]); }
}

/** Browser agents discover and execute the same MCP server using the owner's current session. */
export async function mcpBrowserRoute(context: RouteContext): Promise<boolean> {
  if (context.route !== '/api/mcp/browser' || !['GET', 'POST'].includes(context.method)) return false;
  workspaceOwnerPrincipal(context.request);
  context.signal.throwIfAborted();
  if (context.method === 'GET') {
    sendJson(context.response, 200, await browserMcp(context, client => client.listTools(undefined, { signal: context.signal })));
  } else {
    const parsed = callSchema.safeParse(await readBody(context.request));
    if (!parsed.success) throw new ApiError(400, 'A canonical tool name and arguments are required');
    sendJson(context.response, 200, await browserMcp(context, client => client.callTool(parsed.data, undefined, { signal: context.signal })));
  }
  return true;
}
