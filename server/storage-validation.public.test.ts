import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import type { StoredCanvas } from './storage-shapes.js';
import { DocumentVersions } from './version-control.js';

let directory: string;
let store: CanvasStore;
let canvasId: string;
let workspaceId: string;
const servers: Server[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-storage-validation-'));
  store = new CanvasStore(directory);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Validation' });
  workspaceId = workspace.id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Documents' })).id;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await rm(directory, { recursive: true, force: true });
});

async function api(): Promise<string> {
  const server = await createApiServer({ dataDir: directory });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native server address');
  return `http://127.0.0.1:${address.port}`;
}

async function request(base: string, route: string, input: unknown, method = 'PUT'): Promise<Response> {
  return fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

it.each(['malformed', 'stale'] as const)('refuses a %s content hash after a native outside edit and retries the current version', async mode => {
  const block = await store.createBlock(canvasId, { title: 'Reviewed document', content: '# Original' });
  const file = path.join(directory, 'canvases', canvasId + '.json');
  const before = await readFile(file, 'utf8');
  const history = await store.documentHistory(canvasId, block.id);
  await writeFile(path.join(directory, block.file), '# Human edit outside the app');
  const base = await api();
  const route = `/api/canvases/${canvasId}/blocks/${block.id}`;
  const current = (await new CanvasStore(directory).getCanvas(canvasId)).blocks[0];
  const rejected = await request(base, route, { content: '# Obsolete overwrite', expectedContentHash: mode === 'malformed' ? 123 : block.contentHash });
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({ error: 'This document changed since you read it. Read it again and reapply your edit.',
    currentContentHash: current.contentHash });
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await readFile(path.join(directory, block.file), 'utf8')).toBe('# Human edit outside the app');
  expect(await new DocumentVersions(path.join(directory, '.versions', block.id)).status()).toEqual(history);
  const retry = await request(base, route, { content: '# Current reviewed edit', expectedContentHash: current.contentHash });
  expect(retry.status).toBe(200);
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0]).toMatchObject({ content: '# Current reviewed edit' });
  const committed = await store.documentHistory(canvasId, block.id);
  expect(committed.commits[0].message).toBe('Edit Reviewed document');
  expect(committed.commits[1]).toMatchObject({ author: 'filesystem', message: 'Import filesystem edit' });
});

it.each([null, 'not an array', Array.from({ length: 21 }, () => ({ canvasId: 'remote', blockId: 'document' }))])
  ('rejects invalid cross-link collections %j before content, metadata or Git changes and retries a valid edit', async crossLinks => {
    const block = await store.createBlock(canvasId, { title: 'Reviewed document', content: '# Original' });
    const file = path.join(directory, 'canvases', canvasId + '.json');
    const before = await readFile(file, 'utf8');
    const history = await store.documentHistory(canvasId, block.id);
    const base = await api();
    const route = `/api/canvases/${canvasId}/blocks/${block.id}`;
    const failed = await request(base, route, { content: '# Rejected edit', crossLinks });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: 'crossLinks must contain at most 20 links' });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readFile(path.join(directory, block.file), 'utf8')).toBe('# Original');
    expect(await store.documentHistory(canvasId, block.id)).toEqual(history);
    const retried = await request(base, route, { content: '# Accepted edit', crossLinks: [] });
    expect(retried.status).toBe(200);
    expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0]).toMatchObject({ content: '# Accepted edit' });
    expect((await store.documentHistory(canvasId, block.id)).commits[0].message).toBe('Edit Reviewed document');
  });

it('clears an empty layout group through HTTP, preserves an omitted group, and persists both after restart', async () => {
  const first = await store.createBlock(canvasId, { title: 'Clear group', group: 'custom:release' });
  const second = await store.createBlock(canvasId, { title: 'Retain group', group: 'lane:review' });
  const base = await api();
  const response = await request(base, `/api/canvases/${canvasId}/layout`, { positions: [
    { blockId: first.id, x: -400, y: 500, group: '' },
    { blockId: second.id, x: 300, y: 500 },
  ] });
  expect(response.status).toBe(200);
  const canvas = await new CanvasStore(directory).getCanvas(canvasId);
  expect(canvas.blocks[0]).toMatchObject({ x: -400, y: 500 });
  expect(canvas.blocks[0].group).toBeUndefined();
  expect(canvas.blocks[1]).toMatchObject({ x: 300, y: 500, group: 'lane:review' });
});

it('places documents inward from the positive coordinate limit and preserves the non-overlapping geometry on disk', async () => {
  const corner = await store.createBlock(canvasId, { title: 'Corner', x: 1_000_000, y: 1_000_000 });
  const base = await api();
  const added = await request(base, `/api/canvases/${canvasId}/blocks`, { title: 'Inward column', x: 1_000_000, y: 1_000_000 }, 'POST');
  expect(added.status).toBe(201);
  expect(await added.json()).toMatchObject({ x: 999_568, y: 1_000_000 });
  await store.updateBlock(canvasId, corner.id, { x: 997_500, width: 5000 });
  const next = await request(base, `/api/canvases/${canvasId}/blocks`, { title: 'Inward row', x: 1_000_000, y: 1_000_000 }, 'POST');
  expect(next.status).toBe(201);
  expect(await next.json()).toMatchObject({ x: 1_000_000, y: 999_648 });
  const canvas = await new CanvasStore(directory).getCanvas(canvasId);
  expect(canvas.blocks.map(block => [block.x, block.y])).toEqual([[997_500, 1_000_000], [999_568, 1_000_000], [1_000_000, 999_648]]);
  expect(canvas.blocks[2].y + canvas.blocks[2].height + 32).toBeLessThanOrEqual(corner.y);
});

it('rejects a fully occupied bounded candidate strip without creating files, then retries after a public layout repair', async () => {
  const seed = await store.createBlock(canvasId, { title: 'Saved card', x: 997_500, y: -1_000_000 });
  await store.updateBlock(canvasId, seed.id, { width: 5000, height: 5000 });
  const file = path.join(directory, 'canvases', canvasId + '.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
  const source = saved.blocks[0];
  // Model a valid dense canvas restored from disk, without hundreds of fixture-only Git commits.
  const blocks = Array.from({ length: 400 }, (_, index) => ({ ...source,
    id: index === 0 ? seed.id : `dense-${index}`, file: index === 0 ? seed.file : `docs/dense-${index}.md`, y: -1_000_000 + index * 5000 }));
  await Promise.all(blocks.slice(1).map(block => writeFile(path.join(directory, block.file), seed.content)));
  await writeFile(file, JSON.stringify({ ...saved, blocks }));
  const before = await readFile(file, 'utf8');
  const documents = await readdir(path.join(directory, 'docs'));
  const versions = await readdir(path.join(directory, '.versions'));
  const base = await api();
  const rejected = await request(base, `/api/canvases/${canvasId}/blocks`, { title: 'No room', x: 1_000_000, y: 1_000_000 }, 'POST');
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({ error: 'No free position is available near the requested coordinates' });
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await readdir(path.join(directory, 'docs'))).toEqual(documents);
  expect(await readdir(path.join(directory, '.versions'))).toEqual(versions);
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks).toHaveLength(400);
  const repaired = await request(base, `/api/canvases/${canvasId}/layout`, { positions: blocks.map(block => ({ blockId: block.id, x: -1_000_000, y: block.y })) });
  expect(repaired.status).toBe(200);
  const retry = await request(base, `/api/canvases/${canvasId}/blocks`, { title: 'Room after repair', x: 1_000_000, y: 1_000_000 }, 'POST');
  expect(retry.status).toBe(201);
  const created = await retry.json() as CanvasBlock;
  expect(created).toMatchObject({ x: 1_000_000, y: 1_000_000 });
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks.find(block => block.id === created.id)).toMatchObject({ title: 'Room after repair' });
  expect((await store.documentHistory(canvasId, created.id)).commits[0].message).toBe('Create Room after repair');
});
