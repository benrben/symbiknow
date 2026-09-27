import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import type { ExternalMcpServer } from '../shared/types.js';
import { ApiError } from './errors.js';
import { resolvedHeaders } from './settings.js';

const maxToolsPerServer = 40;

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** Connect over Streamable HTTP, falling back to the older SSE transport. */
export async function connectExternal(server: ExternalMcpServer, secrets: Record<string, string>, timeoutMs = 8000): Promise<Client> {
  const headers = resolvedHeaders(server, secrets);
  const url = new URL(server.url);
  const streamable = new Client({ name: 'symbiknow', version: '0.2.0' });
  try {
    await withTimeout(streamable.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } })), timeoutMs, 'timed out');
    return streamable;
  } catch {
    await streamable.close().catch(() => undefined);
  }
  const sse = new Client({ name: 'symbiknow', version: '0.2.0' });
  try {
    await withTimeout(sse.connect(new SSEClientTransport(url, { requestInit: { headers },
      eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } })),
    timeoutMs, 'timed out');
    return sse;
  } catch (error) {
    await sse.close().catch(() => undefined);
    throw new ApiError(502, `Could not connect to ${server.name}: ${error instanceof Error ? error.message : 'connection failed'}`);
  }
}

export async function testExternal(server: ExternalMcpServer, secrets: Record<string, string>) {
  const client = await connectExternal(server, secrets);
  try {
    const { tools } = await withTimeout(client.listTools(), 8000, 'listing tools timed out');
    return { ok: true, server: client.getServerVersion()?.name ?? server.name,
      tools: tools.map(item => ({ name: item.name, description: item.description ?? '' })) };
  } finally { await client.close().catch(() => undefined); }
}

function toolName(server: ExternalMcpServer, name: string): string {
  return `${server.id}__${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function textOutput(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text'
    ? String((part as { text?: unknown }).text ?? '') : JSON.stringify(part)).join('\n').slice(0, 60_000);
}

/** Load tools from every enabled outside MCP server. Servers that fail are reported and skipped. */
export async function externalTools(servers: ExternalMcpServer[], secrets: Record<string, string>,
  onWarning: (message: string) => void): Promise<{ tools: StructuredToolInterface[]; close: () => Promise<void> }> {
  const clients: Client[] = [];
  const loaded = await Promise.all(servers.filter(server => server.enabled).map(async server => {
    try {
      const client = await connectExternal(server, secrets, 6000);
      clients.push(client);
      const { tools } = await withTimeout(client.listTools(), 6000, 'listing tools timed out');
      return tools.slice(0, maxToolsPerServer).map(item => new DynamicStructuredTool({
        name: toolName(server, item.name),
        description: `[${server.name}] ${item.description ?? item.name}`.slice(0, 1000),
        schema: (item.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        func: async (args: Record<string, unknown>) => {
          const output = await client.callTool({ name: item.name, arguments: args });
          const text = textOutput(output.content);
          return output.isError ? `Error from ${server.name}: ${text}` : text;
        },
      }) as StructuredToolInterface);
    } catch (error) {
      onWarning(`${server.name} is unavailable: ${error instanceof Error ? error.message : 'connection failed'}`);
      return [];
    }
  }));
  return { tools: loaded.flat(), close: async () => { await Promise.all(clients.map(client => client.close().catch(() => undefined))); } };
}
