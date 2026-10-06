import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { InvestigationStore } from './investigations.js';
import { CanvasStore } from './storage.js';
import { chatHttpFixture, jsonRequest } from './api-chat.test.fixture.js';

const input = { workspaceId: 'acme-team', canvasId: 'product-roadmap', title: 'Private HTTP investigation',
  visibility: 'private', messages: [{ role: 'user', content: 'What remains?' }] };

describe('HTTP investigation keys and persistence', () => {
  it('forwards the private key for GET, PATCH and DELETE while wrong or missing keys cannot read or mutate', async () => {
    const { base, store, root } = await chatHttpFixture();
    const created = await jsonRequest(base, '/api/investigations', input);
    expect(created.status).toBe(201);
    const result = await created.json();
    const { id } = result.investigation;
    const key = result.accessKey as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const route = `/api/investigations/${id}`;
    const file = path.join(root, 'investigations', `${id}.json`);
    const original = await readFile(file, 'utf8');
    expect(original).not.toContain(key);
    const deniedHeaders: Record<string, string>[] = [{}, { 'x-investigation-key': 'wrong-key' }];
    for (const headers of deniedHeaders) {
      expect((await fetch(base + route, { headers })).status).toBe(404);
      for (const method of ['PATCH', 'DELETE']) {
        const denied = await jsonRequest(base, route, { expectedRevision: 1, title: 'Unauthorized update' }, method,
          headers['x-investigation-key']);
        expect(denied.status).toBe(404);
      }
      expect(await readFile(file, 'utf8')).toBe(original);
    }
    expect(await fetch(base + route, { headers: { 'x-investigation-key': key } }).then(response => response.json()))
      .toEqual(result.investigation);
    const list = await jsonRequest(base, '/api/investigations/list', { workspaceId: input.workspaceId });
    expect(await list.json()).toEqual({ investigations: [] });
    const keyed = await jsonRequest(base, '/api/investigations/list', { workspaceId: input.workspaceId, privateKeys: [key] });
    expect(await keyed.json()).toMatchObject({ investigations: [{ id, revision: 1, messageCount: 1 }] });
    const patched = await jsonRequest(base, route, { expectedRevision: 1, title: 'Saved from HTTP',
      messages: [...input.messages, { role: 'assistant', content: 'Verified findings' }] }, 'PATCH', key);
    expect(patched.status).toBe(200);
    const updated = await patched.json();
    expect(updated.investigation).toMatchObject({ title: 'Saved from HTTP', revision: 2, messages: expect.arrayContaining([
      { role: 'assistant', content: 'Verified findings' },
    ]) });
    expect(await new InvestigationStore(new CanvasStore(root)).get(id, key)).toEqual(updated.investigation);
    const stale = await jsonRequest(base, route, { expectedRevision: 1, title: 'Stale save' }, 'PATCH', key);
    expect(stale.status).toBe(409);
    expect(await new InvestigationStore(store).get(id, key)).toEqual(updated.investigation);
    const deleted = await jsonRequest(base, route, undefined, 'DELETE', key);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id, deleted: true });
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fetch(base + route, { headers: { 'x-investigation-key': key } })).status).toBe(404);
  });

  it('allows shared CRUD without a key and requires the new private key after a visibility change', async () => {
    const { base } = await chatHttpFixture();
    const created = await jsonRequest(base, '/api/investigations', { ...input, visibility: 'shared' });
    expect(created.status).toBe(201);
    const result = await created.json();
    expect(result).not.toHaveProperty('accessKey');
    const route = `/api/investigations/${result.investigation.id}`;
    expect((await fetch(base + route)).status).toBe(200);
    const privateAgain = await jsonRequest(base, route, { expectedRevision: 1, visibility: 'private' }, 'PATCH');
    expect(privateAgain.status).toBe(200);
    const saved = await privateAgain.json();
    expect(saved.accessKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await fetch(base + route)).status).toBe(404);
    const sharedAgain = await jsonRequest(base, route, { expectedRevision: 2, visibility: 'shared' }, 'PATCH', saved.accessKey);
    expect(sharedAgain.status).toBe(200);
    expect((await jsonRequest(base, route, undefined, 'DELETE')).status).toBe(200);
  });

  it('propagates validation failures and continues serving subsequent investigation requests', async () => {
    const { base } = await chatHttpFixture();
    expect((await jsonRequest(base, '/api/investigations', { ...input, title: '' })).status).toBe(400);
    expect((await jsonRequest(base, '/api/investigations/list', { workspaceId: 10 })).status).toBe(400);
    const created = await jsonRequest(base, '/api/investigations', { ...input, visibility: 'shared' });
    const { investigation } = await created.json();
    expect((await jsonRequest(base, `/api/investigations/${investigation.id}`, { expectedRevision: 1, title: '' }, 'PATCH')).status).toBe(400);
    expect((await fetch(base + `/api/investigations/${investigation.id}`)).status).toBe(200);
  });
});
