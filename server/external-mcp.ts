import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHash } from 'node:crypto';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import type { ExternalMcpServer } from '../shared/types.js';
import { ApiError } from './errors.js';
import { resolvedHeaders } from './settings.js';
import { discoverMcpTools } from './mcp-client-tools.js';

async function closeClient(client: Client): Promise<void> {
  try { await client.close(); }
  catch { console.warn('Could not close an external MCP connection.'); }
}

async function closeClients(clients: Client[]): Promise<void> {
  await Promise.all(clients.map(closeClient));
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let rejectAborted!: (reason?: unknown) => void;
  const abort = () => rejectAborted(signal?.reason);
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      rejectAborted = reject;
      timer = setTimeout(() => reject(new Error(message)), ms);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** Connect using the canonical Streamable HTTP transport. */
export async function connectExternal(server: ExternalMcpServer, secrets: Record<string, string>, timeoutMs = 8000,
  signal?: AbortSignal): Promise<Client> {
  signal?.throwIfAborted();
  const headers = resolvedHeaders(server, secrets);
  const url = new URL(server.url);
  const streamable = new Client({ name: 'symbiknow', version: '0.2.0' });
  try {
    await withTimeout(streamable.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } })), timeoutMs, 'timed out', signal);
    return streamable;
  } catch (error) {
    await closeClient(streamable);
    signal?.throwIfAborted();
    throw new ApiError(502, `Could not connect to ${server.name}: ${error instanceof Error ? error.message : 'connection failed'}`);
  }
}

export async function testExternal(server: ExternalMcpServer, secrets: Record<string, string>) {
  const client = await connectExternal(server, secrets);
  try {
    const tools = await withTimeout(discoverMcpTools(client), 8000, 'listing tools timed out');
    return { ok: true, server: client.getServerVersion()?.name ?? server.name,
      tools: tools.map(item => ({ name: item.name, description: item.description ?? '' })) };
  } finally { await closeClient(client); }
}

function toolName(server: ExternalMcpServer, name: string): string {
  const raw = `${server.id}__${name}`;
  const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (normalized === raw && raw.length <= 64) return raw;
  const suffix = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  return `${normalized.slice(0, 53)}_${suffix}`;
}

function textOutput(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text'
    ? String((part as { text?: unknown }).text ?? '') : JSON.stringify(part)).join('\n');
}

/** Load tools from every enabled outside MCP server. Servers that fail are reported and skipped. */
export async function externalTools(servers: ExternalMcpServer[], secrets: Record<string, string>,
  onWarning: (message: string) => void, signal?: AbortSignal): Promise<{ tools: StructuredToolInterface[]; close: () => Promise<void> }> {
  signal?.throwIfAborted();
  const clients: Client[] = [];
  const loaded = await Promise.allSettled(servers.filter(server => server.enabled).map(async server => {
    let client: Client | undefined;
    try {
      client = await connectExternal(server, secrets, 6000, signal);
      clients.push(client);
      const tools = await withTimeout(discoverMcpTools(client, signal), 6000, 'listing tools timed out', signal);
      return tools.map(item => new DynamicStructuredTool({
        name: toolName(server, item.name),
        description: `[${server.name}] ${item.description ?? item.name}`,
        schema: (item.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        func: async (args: Record<string, unknown>, _manager, config) => {
          const signals = [signal, config?.signal].filter((value): value is AbortSignal => Boolean(value));
          const currentSignal = signals.length ? AbortSignal.any(signals) : undefined;
          currentSignal?.throwIfAborted();
          const output = await client!.callTool({ name: item.name, arguments: args }, undefined, { signal: currentSignal });
          const text = textOutput(output.content);
          return output.isError ? `Error from ${server.name}: ${text}` : text;
        },
      }) as StructuredToolInterface);
    } catch (error) {
      if (client) {
        clients.splice(clients.indexOf(client), 1);
        await closeClient(client);
      }
      if (signal?.aborted) throw error;
      onWarning(`${server.name} is unavailable: ${error instanceof Error ? error.message : 'connection failed'}`);
      return [];
    }
  }));
  const failed = loaded.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    await closeClients(clients);
    throw failed.reason;
  }
  // The rejection check above guarantees every result is fulfilled here.
  const tools = loaded.flatMap(result => (result as PromiseFulfilledResult<StructuredToolInterface[]>).value);
  return { tools, close: () => closeClients(clients) };
}
