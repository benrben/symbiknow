import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as nativeRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { reportStartupFailure, start } from './index.js';
import { CanvasStore } from './storage.js';
const commandPlanFile = (root: string, id: string) => path.join(root, 'jev', 'workspaces', id, 'command-plans.json');

const roots: string[] = [];
const servers: Server[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const connections: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
const documentRoute = '/api/canvases/product-roadmap/blocks/roadmap-overview';

beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
});

afterEach(async () => {
  for (const { client, transport } of connections.splice(0)) {
    try { await transport.terminateSession(); }
    finally { await client.close(); }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>(resolve => {
      child.once('close', () => resolve());
      child.kill('SIGTERM');
    });
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-index-startup-'));
  roots.push(root);
  return root;
}

async function listen(root: string, host?: string) {
  const server = await start(0, root, host);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native listening address');
  const authority = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return { server, address, base: `http://${authority}:${address.port}` };
}

async function request<T>(base: string, route: string, token = '', method = 'GET', body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-symbiknow-actor': 'Native startup writer' };
  if (token) headers.authorization = 'Bearer ' + token;
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as T };
}

async function commandLine(root: string, host: string, token: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url))], {
    env: { ...process.env, DATA_DIR: root, PORT: '0', HOST: host, SYMBIKNOW_ACCESS_TOKEN: token, ALLTEAM_ACCESS_TOKEN: '' },
    stdio: 'pipe',
  });
  children.push(child);
  child.stdin.end();
  const output = { stdout: '', stderr: '' };
  child.stderr.on('data', chunk => { output.stderr += String(chunk); });
  const base = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`Native startup exited before listening: ${code ?? signal}; ${output.stderr}`)));
    child.stdout.on('data', chunk => {
      output.stdout += String(chunk);
      const match = output.stdout.match(/SymbiKnow API listening on (http:\/\/\S+) \(remote MCP at \/mcp\)/);
      if (match) resolve(match[1]);
    });
  });
  return { child, output, base };
}

it('binds IPv6 loopback, protects source reads and writes, and reloads the authenticated write and its actual Git author after restart', async () => {
  const root = await directory();
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'ipv6-secret');
  const first = await listen(root, '::1');
  expect(first.address).toMatchObject({ address: '::1', family: 'IPv6' });
  expect(new URL(first.base).hostname).toBe('[::1]');
  expect(await request(first.base, '/api/session')).toEqual({ status: 200, body: { authRequired: true, authenticated: false } });
  expect((await request(first.base, '/api/canvases/product-roadmap')).status).toBe(401);
  const canvas = (await request<CanvasDocument>(first.base, '/api/canvases/product-roadmap', 'ipv6-secret')).body;
  const source = canvas.blocks.find(block => block.id === 'roadmap-overview');
  if (!source) throw new Error('Missing native source document');
  const saved = await readFile(path.join(root, source.file), 'utf8');
  expect((await request(first.base, documentRoute, '', 'PUT', { content: '# Unauthorized IPv6' })).status).toBe(401);
  expect(await readFile(path.join(root, source.file), 'utf8')).toBe(saved);
  const changed = await request<CanvasBlock>(first.base, documentRoute, 'ipv6-secret', 'PUT', { content: '# Authenticated IPv6' });
  expect(changed.status).toBe(200);
  expect(changed.body.content).toBe('# Authenticated IPv6');
  expect(await readFile(path.join(root, source.file), 'utf8')).toBe('# Authenticated IPv6');
  const restarted = await listen(root, '::1');
  const reloaded = await request<CanvasDocument>(restarted.base, '/api/canvases/product-roadmap', 'ipv6-secret');
  expect(reloaded.body.blocks.find(block => block.id === source.id)?.content).toBe('# Authenticated IPv6');
  const history = await new CanvasStore(root).documentHistory('product-roadmap', source.id);
  expect(history.commits[0].author).toBe('Native startup writer');
  expect(history.commits).toHaveLength(2);
});

it('keeps default IPv4 and explicit localhost reachable without credentials and reads a public write after a native restart', async () => {
  const root = await directory();
  const first = await listen(root);
  expect(first.address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  expect(await request(first.base, '/api/session')).toEqual({ status: 200, body: { authRequired: false, authenticated: true } });
  const changed = await request<CanvasBlock>(first.base, documentRoute, '', 'PUT', { content: '# Local default write' });
  expect(changed.status).toBe(200);
  const restarted = await listen(root, 'localhost');
  const localhost = `http://localhost:${restarted.address.port}`;
  const canvas = await request<CanvasDocument>(localhost, '/api/canvases/product-roadmap');
  expect(canvas.status).toBe(200);
  expect(canvas.body.blocks.find(block => block.id === 'roadmap-overview')?.content).toBe('# Local default write');
  expect((await new CanvasStore(root).documentHistory('product-roadmap', 'roadmap-overview')).commits[0].author).toBe('Native startup writer');
});

it('binds the native wildcard host with and without a token and keeps the token-protected listener authenticated', async () => {
  const first = await listen(await directory(), '0.0.0.0');
  expect(first.address.address).toBe('0.0.0.0');
  const firstBase = `http://127.0.0.1:${first.address.port}`;
  expect((await request(firstBase, '/api/workspaces')).status).toBe(200);
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'wildcard-secret');
  const second = await listen(await directory(), '0.0.0.0');
  expect(second.address.address).toBe('0.0.0.0');
  const secondBase = `http://127.0.0.1:${second.address.port}`;
  expect((await request(secondBase, '/api/workspaces')).status).toBe(401);
  expect((await request(secondBase, '/api/workspaces', 'wrong-secret')).status).toBe(401);
  expect((await request(secondBase, '/api/workspaces', 'wildcard-secret')).status).toBe(200);
});

it('emits a correctly bracketed IPv6 CLI URL that serves authenticated HTTP writes and real persisted document history', async () => {
  const root = await directory();
  const cli = await commandLine(root, '::1', 'cli-secret');
  expect(cli.base).toMatch(/^http:\/\/\[::1\]:\d+$/);
  expect((await request(cli.base, '/api/workspaces')).status).toBe(401);
  expect((await request(cli.base, documentRoute, 'cli-secret', 'PUT', { content: '# Native CLI IPv6' })).status).toBe(200);
  const store = new CanvasStore(root);
  const canvas = await store.getCanvas('product-roadmap');
  expect(canvas.blocks.find(block => block.id === 'roadmap-overview')?.content).toBe('# Native CLI IPv6');
  expect((await store.documentHistory('product-roadmap', 'roadmap-overview')).commits[0].author).toBe('Native startup writer');
  expect(cli.output.stderr).not.toContain('HOST exposes');
});

it.each(['', 'cli-wildcard-secret'])('emits the native wildcard exposure warning only when the CLI access token is absent: %j', async token => {
  const cli = await commandLine(await directory(), '0.0.0.0', token);
  const url = new URL(cli.base);
  expect(url.hostname).toBe('0.0.0.0');
  const reachable = `http://127.0.0.1:${url.port}`;
  expect((await request(reachable, '/api/workspaces')).status).toBe(token ? 401 : 200);
  if (token) {
    expect((await request(reachable, '/api/workspaces', token)).status).toBe(200);
    expect(cli.output.stderr).not.toContain('HOST exposes');
  } else {
    expect(cli.output.stderr).toContain('Warning: HOST exposes the canvas beyond this machine without SYMBIKNOW_ACCESS_TOKEN.');
    expect(cli.output.stderr).toContain('Anyone who can reach it can read and change documents.');
  }
});

it('surfaces a native occupied-port failure and allows an independent retry while the original listener stays usable', async () => {
  const occupied = await listen(await directory(), '::1');
  const root = await directory();
  const error = await start(occupied.address.port, root, '::1').catch(failure => failure as unknown);
  expect(error).toMatchObject({ code: 'EADDRINUSE' });
  const previous = process.exitCode;
  try {
    reportStartupFailure(error);
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = previous; }
  expect((await request(occupied.base, '/api/workspaces')).status).toBe(200);
  const retry = await listen(root, '::1');
  expect((await request(retry.base, '/api/workspaces')).status).toBe(200);
  expect(retry.address.port).not.toBe(occupied.address.port);
});

it('rejects invalid port values before writing files or opening a listener', async () => {
  const root = await directory();
  for (const port of [Number.NaN, 1.5, -1, 65536]) {
    await expect(start(port, root, '::1')).rejects.toThrow('PORT must be a valid TCP port');
    expect(await readdir(root)).toEqual([]);
  }
});

it('keeps static GET and API dispatch distinct, preserves sandbox protection and recovers from a genuine malformed manifest', async () => {
  const root = await directory();
  const api = await listen(root, '::1');
  const home = await fetch(api.base + '/');
  expect(home.status).toBe(200);
  expect(home.headers.get('content-type')).toContain('text/html');
  expect(await home.text()).toContain('<html');
  expect((await request(api.base, '/', '', 'POST', {})).status).toBe(404);
  expect((await request(api.base, '/api/no-such-startup-route')).status).toBe(404);
  const sandbox = await fetch(api.base + '/api/workspaces', { method: 'POST',
    headers: { origin: 'null', 'content-type': 'application/json' }, body: '{"name":"Unsafe origin"}' });
  expect(sandbox.status).toBe(403);
  const manifest = path.join(root, 'workspaces.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, '{');
  expect(await request(api.base, '/api/workspaces')).toEqual({ status: 500, body: { error: 'Internal server error' } });
  expect(await readFile(manifest, 'utf8')).toBe('{');
  await writeFile(manifest, original);
  expect((await request(api.base, '/api/workspaces')).status).toBe(200);
  expect(await readFile(manifest, 'utf8')).toBe(original);
});

it('dispatches bearer and path-token MCP sessions over native IPv6 SDK connections and persists the actual tool write', async () => {
  const root = await directory();
  const api = await listen(root, '::1');
  const store = new CanvasStore(root);
  const { token, settings } = await store.createMcpToken('Native IPv6 agent', 'write');
  for (const pathToken of [false, true]) {
    const client = new Client({ name: 'Native startup SDK', version: '1.0.0' });
    const endpoint = api.base + (pathToken ? '/mcp/t/' + encodeURIComponent(token) : '/mcp');
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: pathToken ? {} : { authorization: 'Bearer ' + token } },
    });
    connections.push({ client, transport });
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('upload_file');
    const created = await client.callTool({ name: 'upload_file', arguments: {
      mode: 'create', canvasId: 'product-roadmap', filename: pathToken ? 'path-token.md' : 'bearer-token.md', idempotencyKey: pathToken ? 'path-source' : 'bearer-source', title: pathToken ? 'Path-token source' : 'Bearer-token source', content: '# Native startup SDK source',
    } });
    expect(created.isError).not.toBe(true);
    const content = created.content as Array<{ type: string; text?: string }>;
    if (typeof content[0]?.text !== 'string') throw new Error('Missing native MCP document result');
    const receipt = JSON.parse(content[0].text) as { blockId: string };
    const document = await store.getCanvasBlock('product-roadmap', receipt.blockId);
    expect(await readFile(path.join(root, document.file), 'utf8')).toBe('# Native startup SDK source');
    const fresh = new CanvasStore(root);
    expect((await fresh.getCanvas('product-roadmap')).blocks.find(block => block.id === document.id)?.content).toBe('# Native startup SDK source');
    expect((await fresh.documentHistory('product-roadmap', document.id)).commits[0].author).toBe(settings.mcpTokens![0].id);
    const finished = new Promise<boolean>(resolve => api.server.once('request', (_incoming, response) => {
      response.once('close', () => resolve(response.writableFinished));
    }));
    const rejected = await client.callTool({ name: 'unknown_startup_tool', arguments: {} });
    expect(rejected.isError).toBe(true);
    expect(await finished).toBe(true);
    await expect.poll(async () => (await new CanvasStore(root).mcpActivity()).entries.some(entry =>
      entry.tool === 'unknown_startup_tool' && entry.outcome === 'denied')).toBe(true);
  }
});

it('cancels a genuinely disconnected partial native HTTP body without writing and keeps subsequent requests usable', async () => {
  const root = await directory();
  const api = await listen(root, '::1');
  const manifest = path.join(root, 'workspaces.json');
  const before = await readFile(manifest, 'utf8');
  let observedClose!: Promise<boolean>;
  const received = new Promise<void>(resolve => {
    api.server.once('request', (incoming, response) => {
      observedClose = new Promise<boolean>(closed => response.once('close', () => closed(response.writableFinished)));
      incoming.once('data', () => resolve());
    });
  });
  const outgoing = nativeRequest(new URL('/api/workspaces', api.base), {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '100' },
  });
  const failed = new Promise<string | undefined>(resolve => outgoing.once('error', error => resolve((error as NodeJS.ErrnoException).code)));
  outgoing.write('{');
  await received;
  outgoing.destroy();
  expect(await observedClose).toBe(false);
  expect(await failed).toBe('ECONNRESET');
  expect((await request(api.base, '/api/workspaces')).status).toBe(200);
  expect(await readFile(manifest, 'utf8')).toBe(before);
  expect((await request(api.base, '/api/workspaces', '', 'POST', { name: 'Retry after native disconnect' })).status).toBe(201);
  expect((await new CanvasStore(root).listWorkspaces()).map(workspace => workspace.name)).toContain('Retry after native disconnect');
});

it('ignores damaged retired command plans while keeping ordinary knowledge and automatic Reflex available across restart', async () => {
  const root = await directory(); const store = new CanvasStore(root); await store.init();
  const file = commandPlanFile(root, 'acme-team');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '{');
  const visible = vi.spyOn(console, 'error');
  try {
    const api = await listen(root);
    expect(visible.mock.calls.some(call => String(call[0]).includes('request plans require recovery'))).toBe(false);
    expect((await request(api.base, '/api/workspaces')).status).toBe(200);
    expect((await request(api.base, '/api/workspaces/acme-team/jev/state')).status).toBe(200);
    expect(await readFile(file, 'utf8')).toBe('{');
    await new Promise<void>(resolve => api.server.close(() => resolve()));
    const repaired = await listen(root);
    expect((await request(repaired.base, '/api/workspaces/acme-team/jev/state')).status).toBe(200);
  } finally { visible.mockRestore(); }
});
