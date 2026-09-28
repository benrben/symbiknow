import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { CanvasStore } from './storage.js';
import { InvestigationStore } from './investigations.js';
import { createApiServer } from './index.js';

const roots: string[] = [];
const servers: Server[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-investigations-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return { root, store, investigations: new InvestigationStore(store) };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const input = { workspaceId: 'acme-team', canvasId: 'product-roadmap', title: 'Release investigation', visibility: 'private',
  question: 'What blocks release?', messages: [{ role: 'user', content: 'What blocks release?' },
    { role: 'assistant', content: 'Check the launch checklist.' }],
  sourceRefs: [{ canvasId: 'product-roadmap', blockId: 'launch-checklist', contentHash: '0123456789abcdef',
    revisionId: 'revision-1', excerpt: 'Test beta with customers' }],
  proposalRefs: [{ kind: 'chat', id: 'proposal-1', status: 'pending' }] } as const;
const researchSnapshot = {
  turns: [{ id: 1, query: 'What blocks release?', answer: 'Beta testing is unfinished.', status: 'complete', selection: 'jev',
    sources: [{ canvasId: 'product-roadmap', canvasName: 'Product Roadmap', blockId: 'launch-checklist',
      title: 'Launch checklist', excerpt: 'Test beta with customers', relevance: 0.91 }],
    patch: { query: 'What blocks release?', layout: 'roadmap',
      blocks: [{ id: 'risk', type: 'section', title: 'Release risk', content: 'Beta testing is unfinished.',
        sourceIds: ['product-roadmap:launch-checklist'] }], edges: [] } }],
  edits: { added: [{ id: 'user:note', turnId: 1, type: 'text', title: 'My note', content: 'Ask the beta team',
    markdown: '# My note\n\nAsk the beta team', sources: [], x: 410, y: 120 }],
  changed: { '1:risk': { title: 'Beta risk', x: 80, group: 'custom:risks' } }, deleted: [],
  addedEdges: [{ source: '1:risk', target: 'user:note', label: 'follow-up' }], deletedEdges: [] },
  layout: 'roadmap',
} as const;

describe('durable investigations', () => {
  it('persists and updates a research snapshot across restart with private access and revision checks', async () => {
    const { root, investigations } = await fixture();
    const created = await investigations.create({ ...input, researchSnapshot });
    expect(created.investigation.researchSnapshot).toEqual(researchSnapshot);
    const updatedSnapshot = { ...researchSnapshot, layout: 'kanban',
      edits: { ...researchSnapshot.edits, changed: { '1:risk': { title: 'Beta risk', x: 180 } } } };
    await expect(investigations.update(created.investigation.id, { expectedRevision: 9, researchSnapshot: updatedSnapshot }, created.accessKey))
      .rejects.toMatchObject({ status: 409 });
    const updated = await investigations.update(created.investigation.id, { expectedRevision: 1, researchSnapshot: updatedSnapshot }, created.accessKey);
    expect(updated.investigation).toMatchObject({ revision: 2, researchSnapshot: updatedSnapshot });
    const restartedStore = new CanvasStore(root);
    await restartedStore.init();
    const restarted = new InvestigationStore(restartedStore);
    await expect(restarted.get(created.investigation.id)).rejects.toMatchObject({ status: 404 });
    expect((await restarted.get(created.investigation.id, created.accessKey)).researchSnapshot).toEqual(updatedSnapshot);
  });

  it('rejects malformed and over-one-megabyte snapshots without changing a saved record', async () => {
    const { root, investigations } = await fixture();
    await expect(investigations.create({ ...input, researchSnapshot: { ...researchSnapshot, layout: 'spiral' } }))
      .rejects.toMatchObject({ status: 400 });
    await expect(investigations.create({ ...input, researchSnapshot: { ...researchSnapshot, edits: { ...researchSnapshot.edits, added: [{ id: 'broken' }] } } }))
      .rejects.toMatchObject({ status: 400 });
    const created = await investigations.create(input);
    const oversized = { ...researchSnapshot, turns: Array.from({ length: 5 }, (_, index) => ({ ...researchSnapshot.turns[0],
      id: index + 1, answer: 'x'.repeat(250_000) })) };
    await expect(investigations.update(created.investigation.id, { expectedRevision: 1, researchSnapshot: oversized }, created.accessKey))
      .rejects.toMatchObject({ status: 400 });
    expect(await investigations.get(created.investigation.id, created.accessKey)).toMatchObject({ revision: 1 });
    const file = path.join(root, 'investigations', `${created.investigation.id}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...stored, researchSnapshot: { turns: [], layout: 'invalid', edits: {} } }));
    await expect(investigations.get(created.investigation.id, created.accessKey)).rejects.toMatchObject({ status: 500 });
  });

  it('persists a private conversation and references across a store restart without saving its access key', async () => {
    const { root, investigations } = await fixture();
    const created = await investigations.create(input);
    expect(created.accessKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.investigation).toMatchObject({ title: input.title, visibility: 'private', revision: 1,
      messages: input.messages, sourceRefs: input.sourceRefs, proposalRefs: input.proposalRefs });
    expect(created.investigation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const file = path.join(root, 'investigations', `${created.investigation.id}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toContain(created.accessKey!);
    const restarted = new CanvasStore(root);
    await restarted.init();
    const reopened = new InvestigationStore(restarted);
    await expect(reopened.get(created.investigation.id)).rejects.toMatchObject({ status: 404 });
    expect(await reopened.get(created.investigation.id, created.accessKey)).toEqual(created.investigation);
    expect((await reopened.list({ workspaceId: 'acme-team' })).investigations).toEqual([]);
    expect((await reopened.list({ workspaceId: 'acme-team', privateKeys: [created.accessKey] })).investigations[0])
      .toMatchObject({ id: created.investigation.id, messageCount: 2, sourceCount: 1, proposalCount: 1, revision: 1 });
  });

  it('updates with revision checks, changes visibility, and deletes only with access', async () => {
    const { investigations } = await fixture();
    const created = await investigations.create(input);
    const id = created.investigation.id;
    await expect(investigations.update(id, { expectedRevision: 1, title: 'Wrong key' }, 'wrong'))
      .rejects.toMatchObject({ status: 404 });
    const updated = await investigations.update(id, { expectedRevision: 1, title: 'Launch blockers', visibility: 'shared',
      messages: [...input.messages, { role: 'user', content: 'Save this summary.' }] }, created.accessKey);
    expect(updated.investigation).toMatchObject({ title: 'Launch blockers', visibility: 'shared', revision: 2, messages: expect.any(Array) });
    expect(updated.investigation.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(investigations.update(id, { expectedRevision: 1, title: 'Stale save' })).rejects.toMatchObject({ status: 409 });
    expect((await investigations.list({ workspaceId: 'acme-team' })).investigations).toHaveLength(1);
    const privateAgain = await investigations.update(id, { expectedRevision: 2, visibility: 'private' });
    expect(privateAgain.accessKey).toBeTruthy();
    expect(privateAgain.accessKey).not.toBe(created.accessKey);
    await expect(investigations.get(id, created.accessKey)).rejects.toMatchObject({ status: 404 });
    await expect(investigations.delete(id)).rejects.toMatchObject({ status: 404 });
    expect(await investigations.delete(id, privateAgain.accessKey)).toEqual({ id, deleted: true });
    await expect(investigations.get(id, privateAgain.accessKey)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects invalid data, cross-workspace canvas links, and path-like IDs', async () => {
    const { investigations } = await fixture();
    await expect(investigations.create({ ...input, title: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(investigations.create({ ...input, canvasId: 'other-canvas' })).rejects.toMatchObject({ status: 400 });
    await expect(investigations.create({ ...input, sourceRefs: [{ canvasId: '../escape', blockId: 'x' }] }))
      .rejects.toMatchObject({ status: 400 });
    await expect(investigations.get('../escape')).rejects.toMatchObject({ status: 400 });
  });

  it('serves the create, list, get, patch, and delete HTTP contract', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-investigations-http-'));
    roots.push(root);
    const server = await createApiServer({ dataDir: root });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const base = `http://127.0.0.1:${address.port}`;
    const json = { 'content-type': 'application/json' };
    const created = await fetch(`${base}/api/investigations`, { method: 'POST', headers: json,
      body: JSON.stringify({ ...input, researchSnapshot }) });
    expect(created.status).toBe(201);
    const result = await created.json() as Awaited<ReturnType<InvestigationStore['create']>>;
    const id = result.investigation.id;
    const privateKey = result.accessKey!;
    const hidden = await fetch(`${base}/api/investigations/${id}`);
    expect(hidden.status).toBe(404);
    const listed = await fetch(`${base}/api/investigations/list`, { method: 'POST', headers: json,
      body: JSON.stringify({ workspaceId: 'acme-team', privateKeys: [privateKey] }) });
    expect(await listed.json()).toMatchObject({ investigations: [{ id, visibility: 'private' }] });
    const reopened = await fetch(`${base}/api/investigations/${id}`, { headers: { 'x-investigation-key': privateKey } });
    expect(await reopened.json()).toMatchObject({ id, title: input.title, revision: 1, researchSnapshot });
    const patched = await fetch(`${base}/api/investigations/${id}`, { method: 'PATCH',
      headers: { ...json, 'x-investigation-key': privateKey },
      body: JSON.stringify({ expectedRevision: 1, title: 'Updated', researchSnapshot: { ...researchSnapshot, layout: 'kanban' } }) });
    expect(await patched.json()).toMatchObject({ investigation: { id, title: 'Updated', revision: 2,
      researchSnapshot: { layout: 'kanban' } } });
    const deleted = await fetch(`${base}/api/investigations/${id}`, { method: 'DELETE', headers: { 'x-investigation-key': privateKey } });
    expect(await deleted.json()).toEqual({ id, deleted: true });
  });
});
