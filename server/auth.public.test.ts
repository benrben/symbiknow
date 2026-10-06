import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { IncomingMessage, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { accessToken, accessTokens, bearerToken, cleanActor, hasApiAccess, internalToken, publicOrigin, requestActor, sessionCookie } from './auth.js';
import { createApiServer } from './index.js';

const servers: Server[] = [];
const directories: string[] = [];
beforeEach(() => {
  for (const name of ['SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'PUBLIC_URL']) vi.stubEnv(name, '');
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-auth-'));
  directories.push(root);
  const server = await createApiServer({ dataDir: root });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native API address');
  return { root, base: `http://127.0.0.1:${address.port}` };
}

function cookie(token: string, legacy = false): string {
  const digest = createHmac('sha256', token).update(legacy ? 'allteam-session-v1' : 'symbiknow-session-v1').digest('hex');
  return `${legacy ? 'allteam_session' : 'symbiknow_session'}=${digest}`;
}

it('preserves first-entry and empty-array header semantics on actual native IncomingMessage and Socket objects', () => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'primary-secret');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', 'legacy-secret');
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  try {
    const values: Record<string, string[]> = {
      authorization: ['bEaReR  primary-secret ', 'Bearer wrong-token'],
      cookie: [cookie('legacy-secret', true), 'symbiknow_session=wrong'],
      'x-symbiknow-actor': ['  Alice <unsafe>  ', 'Ignored actor'],
      'x-forwarded-proto': ['https, http', 'http'], 'x-forwarded-host': ['canvas.example, proxy.example', 'ignored.example'],
    };
    for (const [name, value] of Object.entries(values)) request.headers[name] = value;
    expect(bearerToken(request)).toBe('primary-secret');
    expect(hasApiAccess(request)).toBe(true);
    expect(requestActor(request)).toBe('Alice unsafe');
    expect(publicOrigin(request)).toBe('https://canvas.example');
    expect(sessionCookie(request)).toContain('; Secure');
    request.headers.authorization = 'not a bearer token';
    expect(hasApiAccess(request)).toBe(true);
    request.headers.cookie = 'other=value=with=equals';
    const empty: Record<string, string[]> = { authorization: [], cookie: [], 'x-symbiknow-actor': [], 'x-forwarded-proto': [], 'x-forwarded-host': [] };
    for (const [name, value] of Object.entries(empty)) request.headers[name] = value;
    request.headers.host = 'native.example:8787';
    expect(bearerToken(request)).toBe('');
    expect(hasApiAccess(request)).toBe(false);
    expect(publicOrigin(request)).toBe('http://native.example:8787');
    expect(sessionCookie(request)).not.toContain('; Secure');
    request.headers['x-allteam-actor'] = 'Legacy collaborator';
    expect(requestActor(request)).toBe('Legacy collaborator');
    delete request.headers['x-allteam-actor'];
    expect(requestActor(request, 'embedded host')).toBe('embedded host');
    request.headers.authorization = 'Bearer ' + internalToken;
    expect(hasApiAccess(request)).toBe(true);
    expect(cleanActor({ private: 'source' })).toBe('');
  } finally { socket.destroy(); }
});

it('keeps migrated credentials and cookies valid through real API requests and changes new sessions to the preferred token', async () => {
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', 'legacy-secret');
  const { base } = await fixture();
  const login = (token: unknown, headers: Record<string, string> = {}) => fetch(base + '/api/session', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token }) });
  const legacy = await login('legacy-secret');
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get('set-cookie')?.split(';')[0]).toBe(cookie('legacy-secret'));
  expect(legacy.headers.get('set-cookie')).not.toContain('; Secure');
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'primary-secret');
  expect(accessTokens()).toEqual(['primary-secret', 'legacy-secret']);
  expect(accessToken()).toBe('primary-secret');
  const migrationHeaders: Record<string, string>[] = [{ cookie: cookie('legacy-secret', true) }, { cookie: cookie('legacy-secret') },
    { authorization: 'Bearer legacy-secret' }, { authorization: 'Bearer primary-secret' }];
  for (const headers of migrationHeaders) {
    expect((await fetch(base + '/api/workspaces', { headers })).status).toBe(200);
  }
  const migrated = await login('legacy-secret', { 'x-forwarded-proto': ' https, http ' });
  expect(migrated.status).toBe(200);
  expect(migrated.headers.get('set-cookie')).toBe(`${cookie('primary-secret')}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure`);
  expect((await login(123)).status).toBe(401);
  const info = await fetch(base + '/api/mcp/info', { headers: { authorization: 'Bearer primary-secret',
    'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'public.example, internal.example' } }).then(response => response.json());
  expect(info).toMatchObject({ origin: 'https://public.example', endpoint: 'https://public.example/mcp', publicUrlConfigured: false });
  vi.stubEnv('PUBLIC_URL', 'https://fixed.example/app///');
  expect(await fetch(base + '/api/mcp/info', { headers: { authorization: 'Bearer primary-secret' } }).then(response => response.json()))
    .toMatchObject({ origin: 'https://fixed.example/app', endpoint: 'https://fixed.example/app/mcp', publicUrlConfigured: true });
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  expect((await fetch(base + '/api/workspaces', { headers: { cookie: cookie('legacy-secret', true) } })).status).toBe(401);
  expect((await fetch(base + '/api/workspaces', { headers: { cookie: cookie('primary-secret') } })).status).toBe(200);
  const logout = await fetch(base + '/api/session', { method: 'DELETE' });
  expect(logout.headers.getSetCookie()).toEqual([
    'symbiknow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    'allteam_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
  ]);
});

it('sets Secure sessions and discovers the origin from a real trusted TLS socket without forwarded headers', async () => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'tls-secret');
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-auth-tls-'));
  directories.push(root);
  const keyFile = path.join(root, 'key.pem');
  const certFile = path.join(root, 'cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE']);
  const key = await readFile(keyFile);
  const cert = await readFile(certFile);
  const api = await createApiServer({ dataDir: root });
  const tls = createHttpsServer({ key, cert }, (request, response) => { api.emit('request', request, response); });
  servers.push(tls);
  await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', resolve));
  const address = tls.address();
  if (!address || typeof address === 'string') throw new Error('Missing native TLS address');
  const base = `https://127.0.0.1:${address.port}`;
  const request = (route: string, input?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown }>((resolve, reject) => {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const outgoing = httpsRequest(base + route, { ca: cert, method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
  const login = await request('/api/session', { token: 'tls-secret' });
  expect(login.status).toBe(200);
  expect(login.headers['set-cookie']).toEqual([`${cookie('tls-secret')}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure`]);
  const authenticated = await request('/api/session', undefined, { cookie: cookie('tls-secret') });
  expect(authenticated.body).toEqual({ authRequired: true, authenticated: true });
  const info = await request('/api/mcp/info', undefined, { cookie: cookie('tls-secret') });
  expect(info.status).toBe(200);
  expect(info.body).toMatchObject({ origin: base, endpoint: base + '/mcp', publicUrlConfigured: false });
});
