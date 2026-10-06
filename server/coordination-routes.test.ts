import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { CanvasBlock, CanvasDocument, CanvasTask } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const opened: Array<{ server: Server; root: string }> = [];
const taskRoute = '/api/canvases/product-roadmap/tasks';
async function app() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-coordination-'));
  const server = await createApiServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, root });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}
async function call<T>(base: string, route: string, method = 'GET', body?: unknown, actor = 'Reviewer') {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-symbiknow-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as T };
}
afterEach(async () => {
  for (const { server, root } of opened.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('public coordination HTTP requests', () => {
  it('persists stamped source ranges and rejects incomplete or invalid revision stamps without creating tasks', async () => {
    const base = await app();
    await new CanvasStore(opened.at(-1)!.root).ensureJevStamps('product-roadmap');
    const source = (await call<CanvasBlock>(base, '/api/canvases/product-roadmap/blocks/launch-checklist')).data;
    const reference = { claim: 'Review the saved source', passage: source.content.slice(0, 10), passageKind: 'exact',
      canvasId: 'product-roadmap', documentId: source.id, checkedAt: '2026-10-01T00:00:00Z',
      navigation: { kind: 'document', canvasId: 'product-roadmap', blockId: source.id } };
    const body = (stamp: Record<string, unknown>) => ({ title: 'Review source range', blockIds: [source.id],
      findingRef: { id: 'stamped-finding', title: 'Review source range', canvasId: 'product-roadmap', blockIds: [source.id], references: [{ ...reference, ...stamp }] } });
    for (const stamp of [{ start: 0 }, { end: 10 }, { start: 10, end: 10 }, { start: 11, end: 10 }, { start: -1, end: 10 },
      { sourceGeneration: 0 }, { metadataRevision: -1 }, { sourceGeneration: 1.5 }, { start: '0', end: 10 },
      { end: Number.MAX_SAFE_INTEGER + 1, start: 0 }, { incarnation: '' }]) {
      expect((await call(base, taskRoute, 'POST', body(stamp))).status).toBe(400);
    }
    expect((await call<CanvasTask[]>(base, taskRoute)).data).toEqual([]);
    const stamp = { incarnation: source.incarnation, sourceGeneration: source.sourceGeneration, metadataRevision: source.metadataRevision, start: 0, end: 10 };
    const created = await call<CanvasTask>(base, taskRoute, 'POST', body(stamp));
    expect(created.status).toBe(201);
    expect((await call<CanvasTask[]>(base, taskRoute)).data[0].findingRef?.references?.[0]).toMatchObject(stamp);
  });

  it('persists source provenance and selected task patches for another caller to read', async () => {
    const base = await app();
    const reference = { claim: 'Review required', passage: 'Release checklist', passageKind: 'exact', canvasId: 'product-roadmap', documentId: 'launch-checklist',
      documentTitle: ' Launch checklist ', contentHash: ' abc ', revision: ' initial ', checkedAt: '2026-10-01T00:00:00Z',
      navigation: { kind: 'document', canvasId: 'product-roadmap', blockId: 'launch-checklist' } };
    const findingRef = { id: 'finding', title: 'Review release', canvasId: 'product-roadmap', blockIds: ['launch-checklist'],
      references: [reference], evidence: [], suggestedOwner: 'Reviewer' };
    const created = await call<CanvasTask>(base, taskRoute, 'POST', { title: ' Review release ', dueDate: '2026-12-01', findingRef, blockIds: ['launch-checklist'] });
    expect(created.status).toBe(201);
    const updated = await call<CanvasTask>(base, `${taskRoute}/${created.data.id}`, 'PUT', { title: 'Ready for release', status: 'blocked', assignee: 'Owner', dueDate: null }, 'Updater');
    expect(updated.status).toBe(200);
    const saved = (await call<CanvasTask[]>(base, taskRoute)).data;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: 'Ready for release', status: 'blocked', assignee: 'Owner', createdBy: 'Reviewer', updatedBy: 'Updater',
      findingRef: { references: [{ ...reference, documentTitle: 'Launch checklist', contentHash: 'abc', revision: 'initial', checkedAt: '2026-10-01T00:00:00.000Z' }] } });
    expect(saved[0]).not.toHaveProperty('dueDate');
  });

  it('rejects invalid request fields without saving and accepts a corrected retry', async () => {
    const base = await app();
    const invalidBodies = [{ title: ' ' }, { title: 'Review', dueDate: '2026-02-30' }, { title: 'Review', blockIds: ['missing'] },
      { title: 'Review', findingRef: { id: 'finding', title: 'Review', canvasId: 'product-roadmap', blockIds: [], references: [null] } },
      { title: 'Review', dependsOnTaskIds: ['missing'] }];
    for (const body of invalidBodies) {
      const result = await call<{ error: string }>(base, taskRoute, 'POST', body);
      expect(result.status).toBe(400); expect(result.data.error.length).toBeGreaterThan(0);
    }
    expect((await call<CanvasTask[]>(base, taskRoute)).data).toEqual([]);
    const retry = await call<CanvasTask>(base, taskRoute, 'POST', { title: 'Review', dueDate: '2028-02-29', blockIds: ['launch-checklist'] });
    expect(retry.status).toBe(201);
    expect((await call<CanvasTask[]>(base, taskRoute)).data).toMatchObject([{ id: retry.data.id, title: 'Review', dueDate: '2028-02-29' }]);
  });

  it('rejects a conflicting edit, transfers the lease, and permits retry after release', async () => {
    const base = await app(); const doc = '/api/canvases/product-roadmap/blocks/launch-checklist';
    expect((await call(base, `${doc}/lock`, 'POST', { ttlSeconds: 29 }, 'Owner')).status).toBe(400);
    expect((await call(base, `${doc}/lock`, 'POST', { ttlSeconds: 30, note: 'Reviewing' }, 'Owner')).status).toBe(200);
    expect((await call(base, `${doc}/lock`, 'POST', {}, 'Other')).status).toBe(409);
    expect((await call(base, doc, 'PUT', { content: '# Conflicting draft' }, 'Other')).status).toBe(423);
    const takeover = await call<{ owner: string }>(base, `${doc}/lock`, 'POST', { force: true }, 'Other');
    expect(takeover.status).toBe(200); expect(takeover.data.owner).toBe('Other');
    expect((await call(base, `${doc}/lock`, 'DELETE', undefined, 'Owner')).status).toBe(409);
    expect((await call(base, `${doc}/lock?force`, 'DELETE', undefined, 'Owner')).status).toBe(200);
    const retried = await call<CanvasBlock>(base, doc, 'PUT', { content: '# Accepted retry' }, 'Reviewer');
    expect(retried.status).toBe(200);
    const saved = (await call<CanvasDocument>(base, '/api/canvases/product-roadmap')).data;
    expect(saved.blocks.find(block => block.id === 'launch-checklist')).toMatchObject({ content: '# Accepted retry' });
  });
});
