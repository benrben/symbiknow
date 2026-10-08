import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { atomicJson } from './storage-files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('deletes only a merged inactive document branch and retains visible sources and other documents after reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-store-branches-')); roots.push(root);
  await atomicJson(path.join(root, 'workspaces.json'), []);
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Branch safety' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
  const source = await store.createBlock(canvas.id, { title: 'Reviewed source', content: '# Original\n' });
  const peer = await store.createBlock(canvas.id, { title: 'Unrelated source', content: '# Unrelated\n' });
  const peerBefore = await store.getCanvasBlock(canvas.id, peer.id);
  await store.createDocumentBranch(canvas.id, source.id, 'agent/draft');
  await expect(store.deleteDocumentBranch(canvas.id, source.id, 'main', 'Reviewer')).rejects.toMatchObject({ status: 409 });
  const original = await store.readDocumentBranch(canvas.id, source.id, 'agent/draft');
  await store.editDocumentBranch(canvas.id, source.id, 'agent/draft', { content: '# Reviewed\n', expectedContentHash: original.contentHash }, 'Author');
  await expect(store.deleteDocumentBranch(canvas.id, source.id, 'agent/draft', 'Reviewer')).rejects.toMatchObject({ status: 409 });
  expect((await store.getCanvasBlock(canvas.id, source.id)).content).toBe(source.content);
  await store.mergeDocumentBranch(canvas.id, source.id, 'agent/draft', 'Reviewer');
  expect((await store.deleteDocumentBranch(canvas.id, source.id, 'agent/draft', 'Reviewer')).branches).toEqual(['main']);
  const restarted = new CanvasStore(root); await restarted.init();
  expect((await restarted.documentHistory(canvas.id, source.id)).branches).toEqual(['main']);
  expect((await restarted.getCanvasBlock(canvas.id, source.id)).content).toBe('# Reviewed\n');
  expect(await restarted.getCanvasBlock(canvas.id, peer.id)).toEqual(peerBefore);
  await expect(restarted.readDocumentBranch(canvas.id, source.id, 'agent/draft')).rejects.toMatchObject({ status: 404 });
});
