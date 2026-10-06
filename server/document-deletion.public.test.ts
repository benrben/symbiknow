import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { documentReviewState } from '../shared/document-state';
import { createApiServer } from './index';
import { CanvasStore } from './storage';
import { DocumentVersions } from './version-control';

const opened: Array<{ server: Server; root: string }> = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-reviewed-delete-'));
  const store = new CanvasStore(root); await store.init();
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native port unavailable');
  const base = `http://127.0.0.1:${address.port}/api`;
  const canvas = await store.getCanvas('product-roadmap');
  const block = await store.createBlock(canvas.id, { title: 'Reviewed creation', content: '# Original evidence' }, 'Agent');
  const route = `/canvases/${canvas.id}/blocks/${block.id}`;
  const request = (init: RequestInit) => fetch(base + route, init);
  const json = (value: unknown, method = 'DELETE') => request({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const saved = async () => { const fresh = new CanvasStore(root); await fresh.init(); return fresh.getCanvas(canvas.id, true); };
  const history = () => new DocumentVersions(path.join(root, '.versions', block.id)).status();
  return { root, base, store, canvas, block, route, request, json, saved, history };
}
afterEach(async () => {
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('reviewed document writes through native HTTP and the serialized store', () => {
  it.each([{}, { requireUnreferenced: false }, { expectedDocumentState: undefined }, { unknownLegacyField: 'retained compatibility' }])
    ('retains ordinary JSON DELETE compatibility for %j', async body => {
      const current = await fixture(); const response = await current.json(body);
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
      expect((await current.saved()).blocks.some(block => block.id === current.block.id)).toBe(false);
      expect((await current.history()).commits[0].author).toBe('api');
    });
  it('retains ordinary empty DELETE and explicit zero-length HTTP requests', async () => {
    const current = await fixture();
    const response = await current.request({ method: 'DELETE', headers: { 'content-length': '0' } });
    expect(response.status).toBe(200);
    expect((await current.saved()).blocks.some(block => block.id === current.block.id)).toBe(false);
  });
  it('accepts a chunked JSON DELETE with reviewed state through the native Node client', async () => {
    const current = await fixture();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(current.base + current.route, { method: 'DELETE', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!));
      });
      request.on('error', reject);
      request.write(JSON.stringify({ expectedDocumentState: documentReviewState(current.block), requireUnreferenced: true })); request.end();
    });
    expect(status).toBe(200); expect((await current.saved()).blocks.some(block => block.id === current.block.id)).toBe(false);
  });
  it.each([{ expectedDocumentState: null }, { expectedDocumentState: 4 }, { expectedDocumentState: {} },
    { expectedSavedCrossLinks: null }, { expectedSavedCrossLinks: 4 }, { expectedSavedCrossLinks: {} },
    { requireUnreferenced: null }, { requireUnreferenced: 'true' }, { requireUnreferenced: 1 }])
    ('rejects malformed preconditions %j without changing data or native history, then retries', async body => {
      const current = await fixture(); const before = await current.saved(); const history = await current.history();
      const response = await current.json(body);
      expect(response.status).toBe(400); expect((await response.json()).error).toBe('Invalid document deletion preconditions');
      expect(await current.saved()).toEqual(before); expect(await current.history()).toEqual(history);
      expect((await current.json({ expectedDocumentState: documentReviewState(current.block) })).status).toBe(200);
    });
  it.each([{ body: '[]', type: 'application/json', status: 400 }, { body: '{broken', type: 'application/json', status: 400 },
    { body: '{}', type: 'text/plain', status: 415 }, { body: 'x'.repeat(2_000_001), type: 'application/json', status: 413 }])
    ('rejects invalid transport input with $status before writing', async ({ body, type, status }) => {
      const current = await fixture(); const before = await current.saved(); const history = await current.history();
      expect((await current.request({ method: 'DELETE', headers: { 'content-type': type }, body })).status).toBe(status);
      expect(await current.saved()).toEqual(before); expect(await current.history()).toEqual(history);
    });
  it.each(['DELETE', 'PUT'])('rejects stale review state before a %s commit and accepts a repaired review', async method => {
    const current = await fixture(); const review = documentReviewState(current.block);
    const changed = await current.store.updateBlock(current.canvas.id, current.block.id, { tags: ['human-reviewed'] }, 'Human');
    const history = await current.history();
    const response = await current.json({ expectedDocumentState: review, ...(method === 'PUT' ? { content: '# Obsolete overwrite' } : {}) }, method);
    expect(response.status).toBe(409); expect((await response.json()).error).toMatch(/changed since review/);
    expect((await current.saved()).blocks.find(block => block.id === current.block.id)).toEqual(changed);
    expect(await current.history()).toEqual(history);
    expect((await current.json({ expectedDocumentState: documentReviewState(changed), ...(method === 'PUT' ? { content: '# Current reviewed update' } : {}) }, method)).status).toBe(200);
    const saved = (await current.saved()).blocks.find(block => block.id === current.block.id);
    if (method === 'PUT') expect(saved!.content).toBe('# Current reviewed update'); else expect(saved).toBeUndefined();
  });
  it.each([null, 4, {}])('rejects an invalid saved-reference review on PUT (%j) before history or disk changes', async expectedSavedCrossLinks => {
    const current = await fixture(); const before = await current.saved(); const history = await current.history();
    const response = await current.json({ expectedSavedCrossLinks, content: '# Unreviewed overwrite' }, 'PUT');
    expect(response.status).toBe(409); expect((await response.json()).error).toMatch(/saved source links/);
    expect(await current.saved()).toEqual(before); expect(await current.history()).toEqual(history);
    expect((await current.json({ expectedSavedCrossLinks: '[]', content: '# Reviewed retry' }, 'PUT')).status).toBe(200);
  });
  it.each(['DELETE', 'PUT'])('reviews saved outgoing links to archived targets before %s and accepts a matching review', async method => {
    const current = await fixture(); const other = await current.store.createCanvas(current.canvas.workspaceId, { name: 'Hidden target' });
    const target = await current.store.createBlock(other.id, { title: 'Saved source', content: '# Evidence to retain' });
    const crossLinks = [{ canvasId: other.id, blockId: target.id, relation: 'related' as const }];
    await current.store.updateBlock(current.canvas.id, current.block.id, { crossLinks });
    await current.store.updateBlock(other.id, target.id, { archived: true });
    const filtered = (await current.saved()).blocks.find(block => block.id === current.block.id)!;
    expect(filtered.crossLinks).toBeUndefined();
    const history = await current.history();
    const payload = { expectedDocumentState: documentReviewState(filtered), ...(method === 'PUT' ? { content: '# Reviewed restore', crossLinks: [] } : {}) };
    expect((await current.json({ ...payload, expectedSavedCrossLinks: '[]' }, method)).status).toBe(409);
    const file = path.join(current.root, 'canvases', current.canvas.id + '.json');
    expect(JSON.parse(await readFile(file, 'utf8')).blocks.find((block: { id: string }) => block.id === current.block.id).crossLinks).toEqual(crossLinks);
    expect(await current.history()).toEqual(history);
    expect((await current.json({ ...payload, expectedSavedCrossLinks: JSON.stringify(crossLinks) }, method)).status).toBe(200);
    const saved = (await current.saved()).blocks.find(block => block.id === current.block.id);
    if (method === 'PUT') {
      expect(saved).toMatchObject({ content: '# Reviewed restore' });
      expect(JSON.parse(await readFile(file, 'utf8')).blocks.find((block: { id: string }) => block.id === current.block.id).crossLinks).toBeUndefined();
    } else expect(saved).toBeUndefined();
    const fresh = new CanvasStore(current.root); await fresh.init();
    expect((await fresh.getCanvas(other.id, true)).blocks.find(block => block.id === target.id)).toMatchObject({ content: target.content, archived: true });
  });
  it('compares metadata inside the native write queue after an already queued human edit', async () => {
    const current = await fixture(); const history = await current.history();
    const editing = current.store.updateBlock(current.canvas.id, current.block.id, { title: 'Queued human title', tags: ['keep'] }, 'Human');
    const deleting = current.store.deleteBlock(current.canvas.id, current.block.id, 'Agent', { expectedDocumentState: documentReviewState(current.block), requireUnreferenced: true });
    const [edit, deletion] = await Promise.allSettled([editing, deleting]);
    expect(edit.status).toBe('fulfilled'); expect(deletion.status).toBe('rejected');
    if (deletion.status === 'rejected') expect(deletion.reason.status).toBe(409);
    expect((await current.saved()).blocks.find(block => block.id === current.block.id)).toMatchObject({ title: 'Queued human title', tags: ['keep'] });
    expect(await current.history()).toEqual(history);
  });
  it.each([true, false])('checks incoming references when requested (%s) and retains ordinary deletion behavior', async required => {
    const current = await fixture(); const source = current.canvas.blocks[0];
    await current.store.updateBlock(current.canvas.id, source.id, { links: [...source.links, current.block.id] });
    const response = await current.json({ expectedDocumentState: documentReviewState(current.block), requireUnreferenced: required });
    expect(response.status).toBe(required ? 409 : 200);
    const saved = await current.saved();
    expect(saved.blocks.some(block => block.id === current.block.id)).toBe(required);
    expect(saved.blocks.find(block => block.id === source.id)!.links.includes(current.block.id)).toBe(required);
  });
  it('reviews relation maps by meaning while ignoring native transient locks', async () => {
    const current = await fixture(); const [first, second] = current.canvas.blocks;
    const linked = await current.store.updateBlock(current.canvas.id, current.block.id, {
      links: [first.id, second.id], linkTypes: { [second.id]: 'related', [first.id]: 'implements' },
    });
    const review = documentReviewState(linked);
    await current.store.updateBlock(current.canvas.id, current.block.id, { linkTypes: { [first.id]: 'implements', [second.id]: 'related' } });
    const locked = await fetch(current.base + current.route + '/lock', { method: 'POST', headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Human' }, body: JSON.stringify({ note: 'Review in progress' }) });
    expect(locked.status).toBe(200);
    const response = await current.json({ expectedDocumentState: review });
    expect(response.status).toBe(423); expect((await response.json()).error).toMatch(/editing this document/i);
    expect((await fetch(current.base + current.route + '/lock', { method: 'DELETE', headers: { 'x-symbiknow-actor': 'Human' } })).status).toBe(200);
    expect((await current.json({ expectedDocumentState: review })).status).toBe(200);
  });
  it('keeps large content out of the review token and safely restores a native one-megabyte edit', async () => {
    const current = await fixture(); const block = await current.store.updateBlock(current.canvas.id, current.block.id, { content: 'A'.repeat(1_000_000) });
    expect(documentReviewState(block).length).toBeLessThan(1000);
    expect((await current.json({ expectedDocumentState: documentReviewState(block), content: 'B'.repeat(1_000_000) }, 'PUT')).status).toBe(200);
    expect((await current.saved()).blocks.find(item => item.id === block.id)!.content).toBe('B'.repeat(1_000_000));
  });
  it('retains archived cross-canvas references and can retry after their deliberate removal', async () => {
    const current = await fixture(); const other = await current.store.createCanvas(current.canvas.workspaceId, { name: 'Referenced evidence' });
    const source = await current.store.createBlock(other.id, { title: 'Archived source', content: '# Saved evidence' });
    await current.store.updateBlock(other.id, source.id, { crossLinks: [{ canvasId: current.canvas.id, blockId: current.block.id }], archived: true });
    expect((await current.json({ expectedDocumentState: documentReviewState(current.block), requireUnreferenced: true })).status).toBe(409);
    expect((await current.saved()).blocks.find(block => block.id === current.block.id)).toEqual(current.block);
    await current.store.updateBlock(other.id, source.id, { crossLinks: [] });
    expect((await current.json({ expectedDocumentState: documentReviewState(current.block), requireUnreferenced: true })).status).toBe(200);
  });
  it('refuses a checked deletion when another canvas cannot be read, then recovers after repair', async () => {
    const current = await fixture(); const other = await current.store.createCanvas(current.canvas.workspaceId, { name: 'Other evidence' });
    const file = path.join(current.root, 'canvases', other.id + '.json'); const original = await readFile(file, 'utf8');
    await writeFile(file, '{broken');
    expect((await current.json({ expectedDocumentState: documentReviewState(current.block), requireUnreferenced: true })).status).toBe(500);
    expect((await current.saved()).blocks.find(block => block.id === current.block.id)).toEqual(current.block);
    await writeFile(file, original);
    expect((await current.json({ expectedDocumentState: documentReviewState(current.block), requireUnreferenced: true })).status).toBe(200);
  });
});
