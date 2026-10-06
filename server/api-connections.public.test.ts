import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, documentServer, catalogServer, request } from './api-connections.test.fixture.js';
import { CanvasStore } from './storage.js';

afterEach(() => vi.unstubAllEnvs());

it('rejects a malformed http URL as client input and can successfully test a corrected native MCP URL', async () => {
  const app = await fixture();
  const malformed = await request(app.base, '/api/mcp/servers/test', { url: 'http://' });
  expect(malformed.status).toBe(400);
  const remote = await documentServer();
  expect(await request(app.base, '/api/mcp/servers/test', { url: remote.url })).toMatchObject({ status: 200, body: {
    ok: true, server: 'Native document library', tools: [{ name: 'read_document', description: 'Reads a persisted document' }],
  } });
});

it.each([{}, { url: 42 }, { id: 'unknown' }, { url: '' }, { url: 'file:///outside' }])
  ('keeps missing and unsupported URL validation for %j without changing settings', async body => {
    const app = await fixture();
    expect(await request(app.base, '/api/mcp/servers/test', body)).toMatchObject({ status: 400,
      body: { error: 'Enter an http or https MCP server URL' } });
    expect((await new CanvasStore(app.root).getSettings()).mcpServers).toEqual([]);
  });

it.each(['Named remote', '', 17])('preserves name %j defaults in native connection failures and can retry with credentials', async name => {
  const app = await fixture();
  const remote = await documentServer({ authorization: 'Bearer remote-key' });
  const failed = await request(app.base, '/api/mcp/servers/test', { name, url: remote.url });
  expect(failed.status).toBe(502);
  const label = typeof name === 'string' && name ? name : 'MCP server';
  expect(failed.body.error).toContain(`Could not connect to ${label}:`);
  expect(remote.observed[0].headers.authorization).toBeUndefined();
  expect((await request(app.base, '/api/settings', { secrets: { TOKEN: 'remote-key' } }, 'PUT')).status).toBe(200);
  expect((await request(app.base, '/api/mcp/servers/test', { name, url: remote.url, bearerSecret: 'TOKEN' })).status).toBe(200);
});

it('retains saved URL/header fallbacks for non-string overrides while explicit empty authorization clears the saved bearer', async () => {
  const app = await fixture();
  const remote = await documentServer({ authorization: 'Bearer remote-key', 'x-team': 'Engineering' });
  await request(app.base, '/api/settings', { secrets: { TOKEN: 'remote-key' },
    mcpServers: [{ id: 'library', name: 'Saved library', url: remote.url, bearerSecret: 'TOKEN', headers: { 'X-Team': 'Engineering' } }] }, 'PUT');
  for (const headers of [null, false, 'ignored']) {
    expect((await request(app.base, '/api/mcp/servers/test', { id: 'library', url: 42, headers })).status).toBe(200);
  }
  expect((await request(app.base, '/api/mcp/servers/test', { id: 'library', url: '' })).status).toBe(400);
  const cleared = await request(app.base, '/api/mcp/servers/test', { id: 'library', bearerSecret: '' });
  expect(cleared.status).toBe(502);
  expect(remote.observed.at(-1)?.headers.authorization).toBeUndefined();
  expect((await request(app.base, '/api/mcp/servers/test', { id: 'library', bearerSecret: 'TOKEN' })).status).toBe(200);
  expect((await new CanvasStore(app.root).secretSettings()).mcpServers?.[0].bearerSecret).toBe('TOKEN');
});

it('tests explicit drafts and legacy saved servers at header bounds and preserves non-string bearer defaults', async () => {
  const app = await fixture();
  const remote = await documentServer();
  const headers = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`X-${index}`, index ? 'value' : 'x'.repeat(1000)]));
  const valid = await request(app.base, '/api/mcp/servers/test', { name: 'Bounded draft', url: remote.url, headers, bearerSecret: 42 });
  expect(valid.status).toBe(200);
  expect(remote.observed[0].headers['x-0']).toHaveLength(1000);
  await request(app.base, '/api/settings', { mcpServers: [{ id: 'legacy', name: 'Legacy library', url: remote.url }] }, 'PUT');
  const settingsFile = path.join(app.root, 'settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  delete settings.mcpServers[0].headers;
  await writeFile(settingsFile, JSON.stringify(settings));
  expect((await request(app.base, '/api/mcp/servers/test', { id: 'legacy' })).status).toBe(200);
  expect((await request(app.base, '/api/mcp/servers/test', { id: 'unknown', url: remote.url })).status).toBe(200);
  expect((await new CanvasStore(app.root).secretSettings()).mcpServers?.[0]).not.toHaveProperty('headers');
  const client = new Client({ name: 'native-document-reader', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(remote.url));
  try {
    await client.connect(transport);
    const read = await client.callTool({ name: 'read_document', arguments: { blockId: remote.block.id } });
    expect(read.content).toEqual([{ type: 'text', text: '# Actual persisted MCP source\n' }]);
    expect((await new CanvasStore(remote.root).getCanvas('product-roadmap')).blocks.find(block => block.id === remote.block.id)?.content)
      .toBe('# Actual persisted MCP source\n');
    expect((await remote.store.documentHistory('product-roadmap', remote.block.id)).commits[0].message).toContain('Create');
  } finally { await transport.terminateSession(); await client.close(); }
});

it('serves real token creation, SDK access, activity and session counts, then revokes the persisted credential', async () => {
  const app = await fixture();
  const beforeInfo = await request(app.base, '/api/mcp/info', undefined, 'GET');
  expect(beforeInfo).toMatchObject({ status: 200, body: { origin: app.base, endpoint: `${app.base}/mcp`, publicUrlConfigured: false, accessProtected: false } });
  const document = await request(app.base, '/api/canvases/product-roadmap/blocks', { title: 'Token readback', content: '# Persisted through the API\n' });
  expect(document.status).toBe(201);
  const created = await request(app.base, '/api/mcp/tokens', { name: 'Native reader', allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'] });
  expect(created.status).toBe(201);
  const token = created.body.token as string;
  const tokenId = created.body.settings.mcpTokens[0].id as string;
  expect(created.body.settings.mcpTokens[0]).toMatchObject({ access: 'read', allowedCanvasIds: ['product-roadmap'], tools: ['read_doc'] });
  const file = path.join(app.root, 'settings.json');
  expect(await readFile(file, 'utf8')).not.toContain(token);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const client = new Client({ name: 'connection-native-reader', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(app.base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['read_doc']);
    const read = await client.callTool({ name: 'read_doc', arguments: { canvasId: 'product-roadmap', blockId: document.body.id } });
    expect(JSON.parse((read.content as Array<{ text: string }>)[0].text)).toMatchObject({ content: '# Persisted through the API\n' });
    const info = await request(app.base, '/api/mcp/info', undefined, 'GET');
    expect(info.body.activeSessions).toBe(beforeInfo.body.activeSessions + 1);
    const activity = await request(app.base, '/api/mcp/activity', undefined, 'GET');
    expect(activity.body.entries[0]).toMatchObject({ tool: 'read_doc', outcome: 'success', tokenName: 'Native reader' });
    expect((await new CanvasStore(app.root).mcpActivity()).entries).toEqual(activity.body.entries);
    expect((await new CanvasStore(app.root).getCanvas('product-roadmap')).blocks.find(block => block.id === document.body.id)?.content)
      .toBe('# Persisted through the API\n');
  } finally { await transport.terminateSession(); await client.close(); }
  expect((await request(app.base, '/api/mcp/info', undefined, 'GET')).body.activeSessions).toBe(beforeInfo.body.activeSessions);
  const encodedId = tokenId.replaceAll('-', '%2D');
  expect((await request(app.base, `/api/mcp/tokens/${encodedId}`, undefined, 'DELETE')).status).toBe(200);
  expect((await new CanvasStore(app.root).getSettings()).mcpTokens).toEqual([]);
  expect((await request(app.base, `/api/mcp/tokens/${tokenId}`, undefined, 'DELETE')).status).toBe(404);
  const rejected = new Client({ name: 'revoked-reader', version: '1.0' });
  try {
    await expect(rejected.connect(new StreamableHTTPClientTransport(new URL(app.base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))).rejects.toThrow();
  } finally { await rejected.close(); }
});

it('reports the configured public origin and access protection through authenticated HTTP', async () => {
  vi.stubEnv('PUBLIC_URL', 'https://workspace.example///');
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'workspace-native-key');
  const app = await fixture();
  expect((await request(app.base, '/api/mcp/info', undefined, 'GET')).status).toBe(401);
  const info = await request(app.base, '/api/mcp/info', undefined, 'GET', { authorization: 'Bearer workspace-native-key' });
  expect(info).toMatchObject({ status: 200, body: { origin: 'https://workspace.example', endpoint: 'https://workspace.example/mcp', publicUrlConfigured: true, accessProtected: true } });
});

it('loads the actual custom model catalog, reports authentication failure and retries after native catalog repair without changing settings', async () => {
  const app = await fixture();
  const catalog = await catalogServer();
  await request(app.base, '/api/settings', { provider: 'custom', baseUrl: catalog.url + '/v1', providerKeys: { custom: 'provider-native-key' } }, 'PUT');
  const before = await readFile(path.join(app.root, 'settings.json'), 'utf8');
  const failed = await request(app.base, '/api/models', undefined, 'GET');
  expect(failed).toMatchObject({ status: 502, body: { error: 'The provider rejected the API key. Save a valid key first.' } });
  await writeFile(catalog.file, JSON.stringify({ status: 200, data: [{ id: 'z-model' }, { id: 'a-model' }] }));
  expect(await request(app.base, '/api/models?provider=custom', undefined, 'GET')).toEqual({ status: 200,
    body: [{ id: 'a-model', name: 'a-model' }, { id: 'z-model', name: 'z-model' }] });
  expect(catalog.observed).toEqual([{ url: '/v1/models', authorization: 'Bearer provider-native-key' },
    { url: '/v1/models', authorization: 'Bearer provider-native-key' }]);
  expect((await request(app.base, '/api/models?provider=invalid', undefined, 'GET')).status).toBe(400);
  expect(await readFile(path.join(app.root, 'settings.json'), 'utf8')).toBe(before);
  expect((await new CanvasStore(app.root).secretSettings()).providerKeys?.custom).toBe('provider-native-key');
});

it.each([['non-string value', { 'X-Team': 4 }], ['array', ['value']], ['invalid name', { 'bad\nheader': 'value' }],
  ['invalid value', { 'X-Team': 'Engineering\nInjected' }], ['oversized value', { 'X-Team': 'x'.repeat(1001) }],
  ['null-byte value', { 'X-Team': 'Engineering\u0000Injected' }], ['non-byte value', { 'X-Team': 'Engineering 😀' }],
  ['too many headers', Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`X-${index}`, 'value']))]])
  ('rejects %s headers before contacting the native MCP server and succeeds after correcting them', async (_name, headers) => {
    const app = await fixture();
    const remote = await documentServer();
    const malformed = await request(app.base, '/api/mcp/servers/test', { url: remote.url, headers });
    expect(malformed.status).toBe(400);
    expect(remote.observed).toEqual([]);
    const valid = await request(app.base, '/api/mcp/servers/test', { url: remote.url, headers: { 'X-Team': 'Engineering' } });
    expect(valid.status).toBe(200);
    expect(remote.observed[0].headers['x-team']).toBe('Engineering');
  });

it('tests a saved server by id with its saved authentication and headers without changing persisted settings', async () => {
  const app = await fixture();
  const remote = await documentServer({ authorization: 'Bearer native-remote-key', 'x-team': 'Engineering' });
  expect((await request(app.base, '/api/settings', { secrets: { REMOTE_KEY: 'native-remote-key', TEAM: 'Engineering' },
    mcpServers: [{ id: 'library', name: 'Saved library', url: remote.url, bearerSecret: 'REMOTE_KEY', headers: { 'X-Team': '${secret:TEAM}' } }] }, 'PUT')).status).toBe(200);
  const before = await readFile(path.join(app.root, 'settings.json'), 'utf8');
  const tested = await request(app.base, '/api/mcp/servers/test', { id: 'library' });
  expect(tested.status).toBe(200);
  expect(tested.body.tools).toEqual([{ name: 'read_document', description: 'Reads a persisted document' }]);
  expect(remote.observed[0].headers).toMatchObject({ authorization: 'Bearer native-remote-key', 'x-team': 'Engineering' });
  expect(await readFile(path.join(app.root, 'settings.json'), 'utf8')).toBe(before);
  expect((await new CanvasStore(app.root).secretSettings()).mcpServers?.[0]).toMatchObject({ id: 'library', bearerSecret: 'REMOTE_KEY' });
});

it('rejects an unknown bearer secret before connecting and can test after that secret is saved', async () => {
  const app = await fixture();
  const remote = await documentServer({ authorization: 'Bearer native-remote-key' });
  const missing = await request(app.base, '/api/mcp/servers/test', { url: remote.url, bearerSecret: 'REMOTE_KEY' });
  expect(missing.status).toBe(400);
  expect(missing.body.error).toContain('REMOTE_KEY');
  expect(remote.observed).toEqual([]);
  expect((await request(app.base, '/api/settings', { secrets: { REMOTE_KEY: 'native-remote-key' } }, 'PUT')).status).toBe(200);
  expect((await request(app.base, '/api/mcp/servers/test', { url: remote.url, bearerSecret: 'REMOTE_KEY' })).status).toBe(200);
});

it('requires a saved bearer secret rather than accepting an inherited object property as a credential', async () => {
  const app = await fixture();
  const remote = await documentServer({ authorization: 'Bearer remote-key' });
  expect((await request(app.base, '/api/mcp/servers/test', { url: remote.url, bearerSecret: 'toString' })).status).toBe(400);
  expect(remote.observed).toEqual([]);
  await request(app.base, '/api/settings', { secrets: { TOKEN: 'remote-key' } }, 'PUT');
  expect((await request(app.base, '/api/mcp/servers/test', { url: remote.url, bearerSecret: 'TOKEN' })).status).toBe(200);
});
