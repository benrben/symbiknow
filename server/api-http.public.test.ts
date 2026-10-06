import { randomUUID } from 'node:crypto';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { request as nativeRequest, type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasBlock, WorkspaceSummary } from '../shared/types.js';
import { remoteMcpFixture, sdkClient, toolJson } from './mcp-http.test.fixture.js';
import { CanvasStore } from './storage.js';

const accessToken = 'native-http-body-boundary';
const assets: string[] = [];
let previousAccessToken: string | undefined;
beforeEach(() => {
  previousAccessToken = process.env.SYMBIKNOW_ACCESS_TOKEN;
  process.env.SYMBIKNOW_ACCESS_TOKEN = accessToken;
});
afterEach(async () => {
  if (previousAccessToken === undefined) delete process.env.SYMBIKNOW_ACCESS_TOKEN;
  else process.env.SYMBIKNOW_ACCESS_TOKEN = previousAccessToken;
  for (const file of assets.splice(0)) await rm(file, { force: true });
});

function request(base: string, route: string, options: {
  method?: string; body?: string; headers?: Record<string, string>;
} = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = nativeRequest(new URL(route, base), {
      method: options.method ?? 'POST', headers: { authorization: 'Bearer ' + accessToken, ...options.headers },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.once('error', reject);
    outgoing.end(options.body);
  });
}

async function asset(extension: string, body: string): Promise<{ file: string; route: string }> {
  const route = '/native-http-' + randomUUID() + extension;
  const file = path.resolve('dist', route.slice(1));
  await writeFile(file, body, { flag: 'wx' });
  assets.push(file);
  return { file, route };
}

it.each([undefined, '{"name":"Must not persist"}'])('rejects an actually absent Content-Type before parsing a native HTTP body: %s', async body => {
  const { base, root } = await remoteMcpFixture();
  const manifest = path.join(root, 'workspaces.json');
  const before = await readFile(manifest, 'utf8');
  const rejected = await request(base, '/api/workspaces', { body });
  expect(rejected.status).toBe(415);
  expect(JSON.parse(rejected.body)).toEqual({ error: 'Send the request body as application/json' });
  expect(rejected.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(rejected.headers['cache-control']).toBe('no-store');
  expect(await readFile(manifest, 'utf8')).toBe(before);
  const created = await request(base, '/api/workspaces', {
    headers: { 'content-type': 'Application/JSON; charset=utf-8' }, body: '{"name":"Native retry"}',
  });
  expect(created.status).toBe(201);
  const workspace = JSON.parse(created.body) as WorkspaceSummary;
  expect(workspace.name).toBe('Native retry');
  expect(await new CanvasStore(root).listWorkspaces()).toContainEqual(workspace);
});

it.each(['', '{', 'null', '[]', '"text"', '42', 'true'])('returns a JSON client error without writing malformed native input: %s', async body => {
  const { base, root } = await remoteMcpFixture();
  const manifest = path.join(root, 'workspaces.json');
  const before = await readFile(manifest, 'utf8');
  const rejected = await request(base, '/api/workspaces', { headers: { 'content-type': 'application/json' }, body });
  expect(rejected.status).toBe(400);
  expect(JSON.parse(rejected.body)).toEqual({ error: 'Expected a JSON object' });
  expect(rejected.headers['cache-control']).toBe('no-store');
  expect(await readFile(manifest, 'utf8')).toBe(before);
  const valid = await request(base, '/api/workspaces', { headers: { 'content-type': 'application/json' }, body: '{"name":"Recovered JSON"}' });
  expect(valid.status).toBe(201);
  expect(await new CanvasStore(root).listWorkspaces()).toContainEqual(JSON.parse(valid.body));
});

it('enforces the native two-million-byte limit including multibyte JSON and remains usable after a 413', async () => {
  const { base, root } = await remoteMcpFixture();
  const manifest = path.join(root, 'workspaces.json');
  const before = await readFile(manifest, 'utf8');
  const empty = JSON.stringify({ name: 'Exact byte boundary', padding: '' });
  const remaining = 2_000_000 - Buffer.byteLength(empty);
  const acceptedBody = JSON.stringify({ name: 'Exact byte boundary',
    padding: 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2) });
  expect(Buffer.byteLength(acceptedBody)).toBe(2_000_000);
  const tooLarge = acceptedBody + ' ';
  const rejected = await request(base, '/api/workspaces', { headers: { 'content-type': 'application/json' }, body: tooLarge });
  expect(rejected.status).toBe(413);
  expect(JSON.parse(rejected.body)).toEqual({ error: 'Request body is too large' });
  expect(rejected.headers['cache-control']).toBe('no-store');
  expect(await readFile(manifest, 'utf8')).toBe(before);
  const accepted = await request(base, '/api/workspaces', { headers: { 'content-type': 'application/json' }, body: acceptedBody });
  expect(accepted.status).toBe(201);
  expect(await new CanvasStore(root).listWorkspaces()).toContainEqual(JSON.parse(accepted.body));
});

it('preserves origin and access validation order before native body parsing, then accepts authenticated SDK writes with disk and Git readback', async () => {
  const { base, root, store } = await remoteMcpFixture();
  const manifest = path.join(root, 'workspaces.json');
  const before = await readFile(manifest, 'utf8');
  const sandbox = await request(base, '/api/workspaces', { body: '{broken',
    headers: { origin: 'null', authorization: 'Bearer invalid' } });
  expect(sandbox.status).toBe(403);
  expect(JSON.parse(sandbox.body)).toEqual({ error: 'Requests from sandboxed documents are not allowed' });
  const unauthenticated = await request(base, '/api/workspaces', { body: '{broken', headers: { authorization: 'Bearer invalid' } });
  expect(unauthenticated.status).toBe(401);
  expect(JSON.parse(unauthenticated.body)).toEqual({ error: 'Sign in with the workspace access token' });
  const wrongType = await request(base, '/api/workspaces', { body: '{broken', headers: { 'content-type': 'text/plain' } });
  expect(wrongType.status).toBe(415);
  expect(await readFile(manifest, 'utf8')).toBe(before);
  const { token } = await store.createMcpToken('HTTP native tools', 'write');
  const { client } = await sdkClient(base, token);
  const result = await client.callTool({ name: 'create_doc', arguments: {
    canvasId: 'product-roadmap', title: 'SDK after invalid HTTP', content: '# Native SDK recovery',
  } });
  expect(result.isError).not.toBe(true);
  const document = toolJson<CanvasBlock>(result);
  const fresh = new CanvasStore(root);
  expect((await fresh.getCanvas('product-roadmap')).blocks.find(block => block.id === document.id)?.content).toBe('# Native SDK recovery');
  expect(await readFile(path.join(root, document.file), 'utf8')).toBe('# Native SDK recovery');
  expect((await fresh.documentHistory('product-roadmap', document.id)).commits[0].author).toBe('Codex - HTTP native tools');
});

it('serves native static bytes, fallback pages, content types and cache headers without weakening traversal protection', async () => {
  const { base } = await remoteMcpFixture();
  const home = await request(base, '/', { method: 'GET' });
  expect(home.status).toBe(200);
  expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(home.headers['cache-control']).toBe('no-cache');
  expect(home.headers['x-content-type-options']).toBe('nosniff');
  const missingRoute = await request(base, '/native-http-route-' + randomUUID(), { method: 'GET' });
  expect(missingRoute.status).toBe(200);
  expect(missingRoute.body).toBe(home.body);
  const directory = await request(base, '/assets', { method: 'GET' });
  expect(directory.status).toBe(200);
  expect(directory.body).toBe(home.body);
  for (const [extension, type] of [['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
    ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.woff2', 'font/woff2'],
    ['.ttf', 'font/ttf'], ['.binary', 'application/octet-stream']]) {
    const created = await asset(extension, 'Native static bytes');
    const response = await request(base, created.route, { method: 'GET' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(type);
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toBe('Native static bytes');
  }
  const immutableRoute = '/assets/native-http-' + randomUUID() + '.css';
  const immutableFile = path.resolve('dist', immutableRoute.slice(1));
  await writeFile(immutableFile, 'body { color: red; }', { flag: 'wx' });
  assets.push(immutableFile);
  const immutable = await request(base, immutableRoute, { method: 'GET' });
  expect(immutable.status).toBe(200);
  expect(immutable.headers['content-type']).toBe('text/css; charset=utf-8');
  expect(immutable.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(immutable.body).toBe('body { color: red; }');
  const missingAsset = await request(base, '/native-http-missing-' + randomUUID() + '.js', { method: 'GET' });
  expect(missingAsset.status).toBe(404);
  expect(JSON.parse(missingAsset.body)).toEqual({ error: 'App asset not found' });
  const traversal = await request(base, '/..%2f..%2fetc%2fpasswd', { method: 'GET' });
  expect(traversal.status).toBe(400);
  expect(JSON.parse(traversal.body)).toEqual({ error: 'Invalid app path' });
});

it('does not replace a native permission failure with a missing-asset fallback and serves the repaired file afterward', async () => {
  const { base } = await remoteMcpFixture();
  const created = await asset('.txt', 'Native permission source');
  await chmod(created.file, 0);
  try {
    const failed = await request(base, created.route, { method: 'GET' });
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body)).toEqual({ error: 'Internal server error' });
    expect(failed.headers['cache-control']).toBe('no-store');
  } finally { await chmod(created.file, 0o644); }
  const repaired = await request(base, created.route, { method: 'GET' });
  expect(repaired.status).toBe(200);
  expect(repaired.body).toBe('Native permission source');
});
