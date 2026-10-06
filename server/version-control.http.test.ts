import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import { DocumentVersions } from './version-control.js';

const execute = promisify(execFile);
const opened: Array<{ server: Server; root: string }> = [];

beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
});

afterEach(async () => {
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-native-version-http-'));
  const store = new CanvasStore(root);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'HTTP version history' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Guides' });
  const first = await store.createBlock(canvas.id, { title: 'Install client', content: '# Client installation\nInstall the client and configure the connection.' });
  const second = await store.createBlock(canvas.id, { title: 'Client installation', content: first.content });
  const server = await createApiServer({ dataDir: root });
  opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native server address');
  return { root, base: `http://127.0.0.1:${address.port}`, store, canvas, first, second };
}

async function request(base: string, route: string, body?: unknown, method = 'POST', headers: Record<string, string> = {}) {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function readCanvas(base: string, id: string): Promise<CanvasDocument> {
  return (await request(base, `/api/canvases/${id}`, undefined, 'GET')).body as CanvasDocument;
}

it('persists branch revisions, exposes native switch/merge/restore previews, reads them after restart and records deletion attribution', async () => {
  const { root, base, canvas, first, second } = await fixture();
  const route = `/api/canvases/${canvas.id}/blocks/${first.id}/versions`;
  const original = first.content;
  const initial = await request(base, route, undefined, 'GET');
  expect(initial.status).toBe(200);
  const revision = initial.body.commits[0].id as string;
  expect((await request(base, route + '/branches', { name: 'agents/draft' })).status).toBe(201);
  expect((await request(base, route + '/switch', { name: 'agents/draft' })).status).toBe(200);
  const draft = '# Reviewed branch\nPreserve the final newline.\n';
  expect((await request(base, `/api/canvases/${canvas.id}/blocks/${first.id}`, { content: draft }, 'PUT',
    { 'x-symbiknow-actor': 'Draft editor' })).status).toBe(200);
  expect((await request(base, route + '/switch', { name: 'main' })).status).toBe(200);
  const preview = await request(base, route + '/preview?kind=switch&name=agents%2Fdraft', undefined, 'GET');
  expect(preview).toMatchObject({ status: 200, body: { before: original, after: draft, scope: 'This document only', revision: { author: 'Draft editor' } } });
  expect((await readCanvas(base, canvas.id)).blocks.find(block => block.id === first.id)?.content).toBe(original);
  expect(await readFile(path.join(root, first.file), 'utf8')).toBe(original);
  expect((await request(base, route + '/preview?kind=merge&name=agents%2Fdraft', undefined, 'GET')).body.after).toBe(draft);
  expect((await request(base, route + '/merge', { name: 'agents/draft' }, 'POST', { 'x-symbiknow-actor': 'Merge reviewer' })).status).toBe(200);
  expect((await new CanvasStore(root).getCanvas(canvas.id)).blocks.find(block => block.id === first.id)?.content).toBe(draft);
  expect((await request(base, route + `/preview?kind=restore&revision=${revision}`, undefined, 'GET')).body).toMatchObject({ before: draft, after: original });
  expect((await request(base, route + '/restore', { revision }, 'POST', { 'x-symbiknow-actor': 'Restore reviewer' })).status).toBe(200);
  const restarted = new CanvasStore(root);
  expect((await restarted.getCanvas(canvas.id)).blocks.find(block => block.id === first.id)?.content).toBe(original);
  expect((await restarted.documentHistory(canvas.id, first.id)).commits[0]).toMatchObject({ author: 'Restore reviewer', message: `Restore revision ${revision.slice(0, 12)}` });
  expect((await restarted.getCanvas(canvas.id)).blocks.find(block => block.id === second.id)).toEqual(second);
  expect((await restarted.documentHistory(canvas.id, second.id)).branches).toEqual(['main']);
  expect((await request(base, `/api/canvases/${canvas.id}/blocks/${first.id}`, undefined, 'DELETE',
    { 'x-symbiknow-actor': 'Document deleter' })).status).toBe(200);
  expect((await request(base, route, undefined, 'GET')).status).toBe(404);
  const retained = new DocumentVersions(path.join(root, '.versions', first.id));
  expect((await retained.status()).commits[0]).toMatchObject({ author: 'Document deleter', message: expect.stringContaining('Delete') });
  expect(await retained.content()).toBe(original);
});

it('keeps private branch edits out of current source search until a guarded merge makes them visible', async () => {
  const { root, base, canvas, first } = await fixture();
  const document = `/api/canvases/${canvas.id}/blocks/${first.id}`;
  const versions = `${document}/versions`;
  expect((await request(base, versions + '/branches', { name: 'agents/private' })).status).toBe(201);
  const branch = await request(base, document + '?branch=agents%2Fprivate', undefined, 'GET');
  expect(branch.status).toBe(200);
  const hidden = '# Private branch\nThe nebula cipher deployment is ready.\n';
  const edited = await request(base, document + '?branch=agents%2Fprivate', {
    content: hidden, expectedContentHash: branch.body.contentHash,
  }, 'PUT');
  expect(edited).toMatchObject({ status: 200, body: { content: hidden, branch: 'agents/private' } });
  const stale = await request(base, document + '?branch=agents%2Fprivate', {
    content: '# Blind overwrite\n', expectedContentHash: branch.body.contentHash,
  }, 'PUT');
  expect(stale).toMatchObject({ status: 409, body: { currentContentHash: edited.body.contentHash } });
  expect((await request(base, document, undefined, 'GET')).body.content).toBe(first.content);
  expect(await readFile(path.join(root, first.file), 'utf8')).toBe(first.content);
  const before = await request(base, '/api/search?q=nebula%20cipher', undefined, 'GET');
  expect(before.status).toBe(200);
  expect((before.body as Array<{ blockId: string }>).some(hit => hit.blockId === first.id)).toBe(false);
  expect((await request(base, versions + '/merge', { name: 'agents/private' })).status).toBe(200);
  const after = await request(base, '/api/search?q=nebula%20cipher', undefined, 'GET');
  expect(after.status).toBe(200);
  expect(after.body).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: first.id })]));
});

it('pages saved history beyond one hundred revisions without repeating or dropping commits', async () => {
  const { root, base, canvas, first } = await fixture();
  const versions = new DocumentVersions(path.join(root, '.versions', first.id));
  const initialCount = (await versions.status({ limit: 200 })).commits.length;
  let latest = first.content;
  for (let index = 0; index < 101; index += 1) {
    latest = `# Saved revision ${index}\n`;
    expect(await versions.commit(latest, `Saved revision ${index}`)).toBe(true);
  }
  await writeFile(path.join(root, first.file), latest);
  const route = `/api/canvases/${canvas.id}/blocks/${first.id}/versions`;
  const firstPage = await request(base, `${route}?limit=50`, undefined, 'GET');
  const secondPage = await request(base, `${route}?limit=50&cursor=50`, undefined, 'GET');
  const finalPage = await request(base, `${route}?limit=50&cursor=100`, undefined, 'GET');
  expect(firstPage).toMatchObject({ status: 200, body: { nextCursor: '50' } });
  expect(secondPage).toMatchObject({ status: 200, body: { nextCursor: '100' } });
  expect(finalPage.status).toBe(200);
  expect(finalPage.body.nextCursor).toBeUndefined();
  const commits = [...firstPage.body.commits, ...secondPage.body.commits, ...finalPage.body.commits] as
    Array<{ id: string; createdAt: string }>;
  expect([firstPage.body.commits.length, secondPage.body.commits.length, finalPage.body.commits.length])
    .toEqual([50, 50, initialCount + 1]);
  expect(new Set(commits.map(commit => commit.id)).size).toBe(101 + initialCount);
  expect(commits.every(commit => !Number.isNaN(Date.parse(commit.createdAt)) && commit.createdAt.endsWith('Z'))).toBe(true);
}, 30_000);

it('keeps the active HTTP document branch after a failed filesystem import and retries it without losing the saved edit', async () => {
  const { root, base, store, canvas, first } = await fixture();
  await store.createDocumentBranch(canvas.id, first.id, 'draft');
  await store.switchDocumentBranch(canvas.id, first.id, 'draft');
  const repository = path.join(root, '.versions', first.id);
  const lock = path.join(repository, '.git', 'index.lock');
  const draft = '# Filesystem draft\nKeep this source and its active branch.\n';
  await writeFile(path.join(root, first.file), draft);
  await writeFile(lock, 'blocked');
  const route = `/api/canvases/${canvas.id}/blocks/${first.id}/versions`;
  expect((await request(base, route, undefined, 'GET')).status).toBe(500);
  expect((await execute('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repository })).stdout.trim()).toBe('draft');
  expect(await readFile(path.join(root, first.file), 'utf8')).toBe(draft);
  await rm(lock);
  const retried = await request(base, route, undefined, 'GET');
  expect(retried).toMatchObject({ status: 200, body: { current: 'draft', commits: [expect.objectContaining({ author: 'filesystem', message: 'Import filesystem edit' }),
    expect.any(Object), expect.any(Object)] } });
  expect((await new CanvasStore(root).getCanvas(canvas.id)).blocks.find(block => block.id === first.id)?.content).toBe(draft);
  expect((await new CanvasStore(root).documentHistory(canvas.id, first.id)).commits[0]).toMatchObject({ author: 'filesystem', message: 'Import filesystem edit' });
});
