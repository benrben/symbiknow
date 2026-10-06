import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const roots: string[] = [];
const servers: Server[] = [];
const canvasRoute = '/api/canvases/product-roadmap';

beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
  vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function listen(root?: string) {
  const dataDir = root ?? await mkdtemp(path.join(tmpdir(), 'allteam-without-jev-actions-'));
  if (!root) roots.push(dataDir);
  const server = await createApiServer({ dataDir });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native listening address');
  return { root: dataDir, base: `http://127.0.0.1:${address.port}` };
}

async function request(base: string, route: string, method = 'GET', body?: unknown) {
  return fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Manual API writer' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

it('keeps the public SDK independent of the application runtime', async () => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const engine = ['server/jev.ts', 'server/jev-answers.ts', 'server/jev-transport.ts', 'server/jev-provider-error.ts', 'server/sdk.ts', 'server/errors.ts'];
  const dependencies: string[] = [];
  for (const file of engine) {
    const source = await readFile(path.join(repository, file), 'utf8');
    const emitted = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
    for (const imported of ts.preProcessFile(emitted, true, true).importedFiles) {
      const resolved = path.relative(repository, path.resolve(repository, path.dirname(file), imported.fileName))
        .replace(/\.[cm]?[jt]sx?$/, '') + '.ts';
      if (imported.fileName.startsWith('.') && !engine.includes(resolved)) dependencies.push(`${file}: ${imported.fileName}`);
    }
  }
  expect(dependencies, 'The standalone SDK must not acquire storage or application lifecycle dependencies').toEqual([]);
});

it('returns 404 for every removed Jev action route without changing native documents or creating feature journals', async () => {
  const { base, root } = await listen();
  const before = await request(base, canvasRoute).then(response => response.json());
  const files = await readdir(root);
  const routes: Array<[string, string]> = [
    ['POST', `${canvasRoute}/insights`], ['POST', `${canvasRoute}/insights/apply`],
    ['POST', `${canvasRoute}/insights/feedback`], ['GET', `${canvasRoute}/jev-inbox`],
    ['POST', `${canvasRoute}/jev-inbox/finding/dismiss`], ['POST', `${canvasRoute}/jev-inbox/finding/apply`],
    ['POST', `${canvasRoute}/intake/preview`], ['POST', `${canvasRoute}/duplicates`],
    ['POST', `${canvasRoute}/cross-connections`], ['POST', `${canvasRoute}/quality`],
    ['POST', `${canvasRoute}/automations`], ['POST', `${canvasRoute}/merge`],
    ['POST', '/api/merges/merge/undo'], ['GET', `${canvasRoute}/tasks/insights`],
    ['POST', `${canvasRoute}/tasks/insights/apply`], ['GET', `${canvasRoute}/tasks`],
    ['POST', `${canvasRoute}/tasks`], ['POST', '/api/workspaces/acme-team/automations'],
    ['GET', '/api/jev-runs/run'], ['POST', '/api/jev-runs/run/undo'],
    ['GET', '/api/jev/usage'], ['GET', '/api/jev/calibration'],
    ['GET', '/api/settings/jev-feedback'], ['GET', '/api/settings/jev-correctness'],
  ];
  for (const [method, route] of routes) {
    const response = await request(base, route, method, method === 'POST' ? {} : undefined);
    expect(response.status, `${method} ${route}`).toBe(404);
    expect(await response.json()).toEqual({ error: 'Route not found' });
  }
  expect(await request(base, canvasRoute).then(response => response.json())).toEqual(before);
  expect(await readdir(root)).toEqual(files);
});

it('retains actual manual document, layout, settings and Git history writes across a native server restart', async () => {
  const first = await listen();
  const changed = await request(first.base, `${canvasRoute}/blocks/roadmap-overview`, 'PUT', { content: '# Manual retained source' });
  expect(changed.status).toBe(200);
  const document = await changed.json() as CanvasBlock;
  expect(await readFile(path.join(first.root, document.file), 'utf8')).toBe('# Manual retained source');
  expect((await request(first.base, `${canvasRoute}/layout`, 'PUT', { positions: [{ blockId: document.id, x: -120, y: 450 }] })).status).toBe(200);
  expect((await request(first.base, '/api/settings', 'PUT', { model: 'openai/gpt-4o-mini' })).status).toBe(200);
  const restarted = await listen(first.root);
  const canvas = await request(restarted.base, canvasRoute).then(response => response.json()) as CanvasDocument;
  expect(canvas.blocks.find(block => block.id === document.id)).toMatchObject({ content: '# Manual retained source', x: -120, y: 450 });
  expect(await request(restarted.base, '/api/settings').then(response => response.json())).toMatchObject({ model: 'openai/gpt-4o-mini' });
  const history = await new CanvasStore(first.root).documentHistory('product-roadmap', document.id);
  expect(history.commits[0].author).toBe('Manual API writer');
  expect(history.commits).toHaveLength(2);
});
