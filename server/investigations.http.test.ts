import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { chatHttpFixture, jsonRequest } from './api-chat.test.fixture.js';
import { InvestigationStore } from './investigations.js';
import { CanvasStore } from './storage.js';

it('retains conversations and provenance after a title-only HTTP PATCH, reload and later explicit clearing', async () => {
  const { base, root } = await chatHttpFixture();
  const messages = [{ role: 'user', content: 'What blocks release?' }, { role: 'assistant', content: 'Beta verification is pending.' }];
  const sourceRefs = [{ canvasId: 'product-roadmap', blockId: 'launch-checklist', excerpt: 'Test beta with customers' }];
  const proposalRefs = [{ kind: 'chat', id: 'proposal-1', status: 'pending' }];
  const createdResponse = await jsonRequest(base, '/api/investigations', { workspaceId: 'acme-team',
    canvasId: 'product-roadmap', title: 'Release investigation', visibility: 'private', messages, sourceRefs, proposalRefs });
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json() as Awaited<ReturnType<InvestigationStore['create']>>;
  const route = `/api/investigations/${created.investigation.id}`;
  const response = await jsonRequest(base, route, { expectedRevision: 1, title: 'Release readiness' }, 'PATCH', created.accessKey);
  expect(response.status).toBe(200);
  const updated = await response.json() as Awaited<ReturnType<InvestigationStore['update']>>;
  expect(updated.investigation).toMatchObject({ messages, sourceRefs, proposalRefs, title: 'Release readiness', revision: 2 });
  expect(await fetch(base + route, { headers: { 'x-investigation-key': created.accessKey! } }).then(res => res.json()))
    .toEqual(updated.investigation);
  expect(await new InvestigationStore(new CanvasStore(root)).get(created.investigation.id, created.accessKey)).toEqual(updated.investigation);
  const persisted = JSON.parse(await readFile(path.join(root, 'investigations', `${created.investigation.id}.json`), 'utf8'));
  expect(persisted).toMatchObject({ messages, sourceRefs, proposalRefs, revision: 2 });
  const cleared = await jsonRequest(base, route, { expectedRevision: 2, messages: [], sourceRefs: [], proposalRefs: [] }, 'PATCH', created.accessKey);
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ investigation: { messages: [], sourceRefs: [], proposalRefs: [], revision: 3 } });
});

it('refuses to read, update or delete malformed saved data over HTTP and succeeds after a real file repair', async () => {
  const { base, root } = await chatHttpFixture();
  const createdResponse = await jsonRequest(base, '/api/investigations', { workspaceId: 'acme-team', title: 'Recoverable investigation', visibility: 'private' });
  const created = await createdResponse.json() as Awaited<ReturnType<InvestigationStore['create']>>;
  const route = `/api/investigations/${created.investigation.id}`;
  const file = path.join(root, 'investigations', `${created.investigation.id}.json`);
  const original = await readFile(file, 'utf8');
  await writeFile(file, '{ broken persistence');
  const malformedGet = await fetch(base + route, { headers: { 'x-investigation-key': created.accessKey! } });
  expect(malformedGet.status).toBe(500);
  expect(await malformedGet.json()).toMatchObject({ error: 'Saved investigation is invalid' });
  for (const method of ['PATCH', 'DELETE']) {
    expect((await jsonRequest(base, route, { expectedRevision: 1, title: 'Unsafe update' }, method, created.accessKey)).status).toBe(500);
  }
  expect((await jsonRequest(base, '/api/investigations/list', { workspaceId: 'acme-team', privateKeys: [created.accessKey] })).status).toBe(500);
  expect(await readFile(file, 'utf8')).toBe('{ broken persistence');
  await writeFile(file, original);
  expect(await fetch(base + route, { headers: { 'x-investigation-key': created.accessKey! } }).then(res => res.json()))
    .toEqual(created.investigation);
  const updatedResponse = await jsonRequest(base, route, { expectedRevision: 1, title: 'Recovered update' }, 'PATCH', created.accessKey);
  expect(updatedResponse.status).toBe(200);
  const updated = await updatedResponse.json() as Awaited<ReturnType<InvestigationStore['update']>>;
  expect(await new InvestigationStore(new CanvasStore(root)).get(created.investigation.id, created.accessKey)).toEqual(updated.investigation);
});

it('applies only one of two concurrent HTTP updates to the same revision and preserves the winner across reload', async () => {
  const { base, root } = await chatHttpFixture();
  const createdResponse = await jsonRequest(base, '/api/investigations', { workspaceId: 'acme-team', title: 'Concurrent investigation', visibility: 'shared' });
  const created = await createdResponse.json() as Awaited<ReturnType<InvestigationStore['create']>>;
  const route = `/api/investigations/${created.investigation.id}`;
  const responses = await Promise.all([
    jsonRequest(base, route, { expectedRevision: 1, title: 'First browser update' }, 'PATCH'),
    jsonRequest(base, route, { expectedRevision: 1, title: 'Second browser update' }, 'PATCH'),
  ]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = await responses.find(response => response.status === 200)!.json() as Awaited<ReturnType<InvestigationStore['update']>>;
  expect(winner.investigation.revision).toBe(2);
  expect(await fetch(base + route).then(response => response.json())).toEqual(winner.investigation);
  expect(await new InvestigationStore(new CanvasStore(root)).get(created.investigation.id)).toEqual(winner.investigation);
});
