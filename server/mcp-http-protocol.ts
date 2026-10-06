import type { IncomingMessage, ServerResponse } from 'node:http';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpHttpBody, McpHttpToolCall } from './mcp-http-types.js';

export function jsonRpcError(response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
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

export function requestBodyError(error: unknown): string { return error instanceof Error ? error.message : 'Invalid JSON'; }

export async function parseMcpBody(request: IncomingMessage, response: ServerResponse): Promise<McpHttpBody> {
  try { return { ok: true, value: await body(request) }; }
  catch (error) { jsonRpcError(response, 400, requestBodyError(error)); return { ok: false }; }
}

export function requiresInitialization(request: IncomingMessage, response: ServerResponse, parsed: unknown): boolean {
  if (request.headers['mcp-session-id']) {
    jsonRpcError(response, 404, 'Session not found. Start a new MCP session.');
    return false;
  }
  if (request.method !== 'POST' || !isInitializeRequest(parsed)) {
    jsonRpcError(response, 400, 'Send an initialize request to start an MCP session.');
    return false;
  }
  return true;
}

export function loopbackHost(address: string): string {
  const host = address.replace(/^::ffff:/, '');
  if (host === '::' || host === '0.0.0.0') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/** The API base reached over the same local socket as the incoming request. */
export function loopbackApi(request: IncomingMessage): string {
  return `http://${loopbackHost(request.socket.localAddress ?? '127.0.0.1')}:${request.socket.localPort}/api`;
}

function toolName(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : 'invalid_tool';
}

function toolCall(message: unknown): McpHttpToolCall | undefined {
  if (!message || typeof message !== 'object' || (message as { method?: unknown }).method !== 'tools/call') return undefined;
  const params = (message as { params?: { name?: unknown; arguments?: unknown } }).params;
  return { name: toolName(params?.name), args: params?.arguments };
}

export function toolCalls(parsed: unknown): McpHttpToolCall[] {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.flatMap(message => {
    const call = toolCall(message);
    return call ? [call] : [];
  });
}
