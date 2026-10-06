import { z } from 'zod';
import { validateHeaderValue } from 'node:http';
import type { ExternalMcpServer } from '../shared/types.js';
import { ApiError } from './errors.js';
import type { PrivateSettings } from './settings.js';

const headers = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  z.string().max(1000).refine(validHeaderValue))
  .refine(value => Object.keys(value).length <= 10);

function validHeaderValue(value: string): boolean {
  try { validateHeaderValue('MCP header', value); return true; }
  catch { return false; }
}

function serverName(value: unknown): string {
  return typeof value === 'string' && value ? value : 'MCP server';
}

function serverUrl(value: unknown, known: ExternalMcpServer | undefined): string {
  return typeof value === 'string' ? value : known?.url ?? '';
}

function bearerSecret(value: unknown, known: ExternalMcpServer | undefined): string | undefined {
  const selected = value === undefined ? known?.bearerSecret : value;
  return typeof selected === 'string' && selected ? selected : undefined;
}

function serverHeaders(value: unknown, known: ExternalMcpServer | undefined): unknown {
  return value && typeof value === 'object' ? value : known?.headers ?? {};
}

function checkedUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) throw new ApiError(400, 'Enter an http or https MCP server URL');
  try { new URL(url); }
  catch { throw new ApiError(400, 'Enter a valid http or https MCP server URL'); }
}

function checkedHeaders(value: unknown): Record<string, string> {
  const parsed = headers.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'headers must contain at most 10 valid header names and string values of at most 1000 characters');
  return parsed.data;
}

function checkedBearer(name: string | undefined, secrets: Record<string, string>): void {
  if (name && !Object.hasOwn(secrets, name)) throw new ApiError(400, `Secret ${name} is not saved`);
}

export function candidateServer(body: Record<string, unknown>, settings: PrivateSettings): ExternalMcpServer {
  const known = (settings.mcpServers ?? []).find(item => item.id === body.id);
  const url = serverUrl(body.url, known);
  const secret = bearerSecret(body.bearerSecret, known);
  checkedUrl(url);
  const selectedHeaders = checkedHeaders(serverHeaders(body.headers, known));
  checkedBearer(secret, settings.secrets ?? {});
  return { id: 'test', name: serverName(body.name), enabled: true, url, bearerSecret: secret, headers: selectedHeaders };
}
