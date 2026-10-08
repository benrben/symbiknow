import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { connectProjectMcpServer, createProjectMcpServer, runProjectMcpCli, startProjectMcpServer } from './mcp.js';

const servers: McpServer[] = [];
const clients: Client[] = [];
const initialExitCode = process.exitCode;
beforeEach(() => {
  for (const key of ['CANVAS_API_URL', 'CANVAS_API_TOKEN', 'SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'SYMBIKNOW_AGENT_NAME', 'ALLTEAM_AGENT_NAME']) vi.stubEnv(key, '');
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  process.exitCode = initialExitCode;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe('MCP factory and host lifecycle', () => {
  it('exposes default stdio connection cleanup to embedded hosts', async () => {
    const listeners = process.stdin.listenerCount('data');
    const server = await connectProjectMcpServer();
    servers.push(server);
    expect(process.stdin.listenerCount('data')).toBe(listeners + 1);
    await server.close();
    expect(process.stdin.listenerCount('data')).toBe(listeners);
  });

  it('starts an SDK client connection through the CLI entry only for its own module', async () => {
    const moduleUrl = new URL('./mcp.ts', import.meta.url).href;
    const modulePath = fileURLToPath(moduleUrl);
    const notStarted = vi.fn(async () => {});
    await runProjectMcpCli(moduleUrl, ['node'], notStarted);
    await runProjectMcpCli(moduleUrl, ['node', fileURLToPath(import.meta.url)], notStarted);
    expect(notStarted).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'local-stdio-agent', access: 'write' })));
    const client = new Client({ name: 'host-client', version: '1.0.0' });
    clients.push(client);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([runProjectMcpCli(moduleUrl, ['node', modulePath], () => startProjectMcpServer(serverSide)), client.connect(clientSide)]);
    expect(client.getServerVersion()).toEqual({ name: 'symbiknow', version: '0.2.0' });
    expect((await client.listTools()).tools.some(tool => tool.name === 'read_doc')).toBe(true);
    expect(process.exitCode).toBe(initialExitCode);
  });

  it('reports a real transport startup failure and sets the CLI exit code', async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const transport = new StdioServerTransport(input, output);
    await transport.start();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runProjectMcpCli(new URL('./mcp.ts', import.meta.url).href, ['node', fileURLToPath(new URL('./mcp.ts', import.meta.url))],
        () => startProjectMcpServer(transport));
      expect(process.exitCode).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('already started') }));
    } finally { await transport.close(); input.destroy(); output.destroy(); }
  });

  it('uses the configured default API and safe actor before client initialization', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return Response.json([]);
    }) as unknown as typeof fetch;
    vi.stubEnv('CANVAS_API_URL', 'http://127.0.0.1:9898/custom-api/');
    vi.stubGlobal('fetch', fetcher);
    const server = createProjectMcpServer();
    servers.push(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const response = new Promise<JSONRPCMessage>(resolve => { clientSide.onmessage = resolve; });
    await server.connect(serverSide); await clientSide.start();
    try {
      await clientSide.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_canvases', arguments: {} } });
      expect(await response).toMatchObject({ id: 1, result: { content: [{ type: 'text', text: '[]' }] } });
      expect(requests).toEqual([{ url: 'http://127.0.0.1:9898/custom-api/workspaces?stats=1', headers: {
        'x-symbiknow-actor': 'local-stdio-agent',
        'x-symbiknow-agent-name': 'MCP agent',
        'x-symbiknow-mcp-tool': 'list_canvases',
        'x-symbiknow-agent-transport': 'mcp',
      } }]);
    } finally { await clientSide.close(); }
  });
});
