import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { createApiServer } from './index.js';

const fixtures: Array<{ server: Server; root: string; watcher?: FSWatcher }> = [];
afterEach(async () => {
  for (const { server, root, watcher } of fixtures.splice(0)) {
    watcher?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(observe = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-storage-root-'));
  const server = await createApiServer({ dataDir: root });
  const watcher = observe ? watch(path.join(root, 'canvases')) : undefined;
  fixtures.push({ server, root, watcher });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native API address');
  const store = new CanvasStore(root);
  const workspace = await store.createWorkspace({ name: 'Revision and deletion recovery' });
  const source = await store.createCanvas(workspace.id, { name: 'Reader' });
  const target = await store.createCanvas(workspace.id, { name: 'Reference' });
  const reader = await store.createBlock(source.id, { title: 'Reader', content: '# Preserved source' });
  const reference = await store.createBlock(target.id, { title: 'Reference', content: '# Reference source' });
  const links = [{ canvasId: target.id, blockId: reference.id, relation: 'implements' as const, confidence: 0.8 }];
  await store.updateBlock(source.id, reader.id, { crossLinks: links });
  return { base: `http://127.0.0.1:${address.port}`, root, store, workspace, source, target, reader, reference, links, watcher,
    sourceFile: path.join(root, 'canvases', source.id + '.json'), targetFile: path.join(root, 'canvases', target.id + '.json') };
}

it('observes a real target-file rename and changes the conditional revision while retaining saved references until repair and restart', async () => {
  const current = await fixture(true);
  const route = current.base + `/api/canvases/${current.source.id}`;
  const before = await fetch(route);
  const etag = before.headers.get('etag')!;
  expect((await before.json()).blocks[0].crossLinks).toEqual(current.links);
  const saved = await readFile(current.sourceFile, 'utf8');
  const watcher = current.watcher!;
  try {
    const changed = once(watcher, 'change');
    await rename(current.targetFile, current.targetFile + '.backup');
    const [event] = await changed;
    expect(event).toMatch(/^(rename|change)$/);
  } finally { watcher.close(); }
  const missing = await fetch(route, { headers: { 'if-none-match': etag } });
  expect(missing.status).toBe(200);
  const missingTag = missing.headers.get('etag')!;
  expect(missingTag).not.toBe(etag);
  expect((await missing.json()).blocks[0].crossLinks).toBeUndefined();
  expect(await current.store.getCanvasRevision(current.source.id)).toBe(missingTag);
  expect(await new CanvasStore(current.root).getCanvasRevision(current.source.id)).toBe(missingTag);
  expect(await readFile(current.sourceFile, 'utf8')).toBe(saved);
  expect((await fetch(route, { headers: { 'if-none-match': missingTag } })).status).toBe(304);
  await rename(current.targetFile + '.backup', current.targetFile);
  const repaired = await fetch(route, { headers: { 'if-none-match': missingTag } });
  expect(repaired.status).toBe(200);
  expect(repaired.headers.get('etag')).not.toBe(missingTag);
  expect((await repaired.json()).blocks[0].crossLinks).toEqual(current.links);
  expect((await new CanvasStore(current.root).getCanvas(current.source.id)).blocks[0].crossLinks).toEqual(current.links);
});

it('refuses to treat a missing source document as an unchanged canvas and recovers its body, revision and Git after file repair', async () => {
  const current = await fixture();
  const route = current.base + `/api/canvases/${current.source.id}`;
  const etag = await current.store.getCanvasRevision(current.source.id);
  const history = await current.store.documentHistory(current.source.id, current.reader.id);
  const file = path.join(current.root, current.reader.file);
  const saved = await readFile(current.sourceFile, 'utf8');
  await rename(file, file + '.backup');
  await expect(current.store.getCanvasRevision(current.source.id)).rejects.toMatchObject({ code: 'ENOENT' });
  const response = await fetch(route, { headers: { 'if-none-match': etag } });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Internal server error' });
  expect(await readFile(current.sourceFile, 'utf8')).toBe(saved);
  await rename(file + '.backup', file);
  const repaired = await fetch(route);
  expect(repaired.status).toBe(200);
  expect((await repaired.json()).blocks[0].content).toBe(current.reader.content);
  expect(await new CanvasStore(current.root).documentHistory(current.source.id, current.reader.id)).toEqual(history);
  const unchanged = await fetch(route, { headers: { 'if-none-match': repaired.headers.get('etag')! } });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
});

it('surfaces a genuine linked-file symlink loop rather than a missing-target signature and retries after native repair', async () => {
  const current = await fixture();
  const etag = await current.store.getCanvasRevision(current.source.id);
  const saved = await readFile(current.sourceFile, 'utf8');
  await rename(current.targetFile, current.targetFile + '.backup');
  await symlink(path.basename(current.targetFile), current.targetFile);
  await expect(current.store.getCanvasRevision(current.source.id)).rejects.toMatchObject({ code: 'ELOOP' });
  const route = current.base + `/api/canvases/${current.source.id}`;
  const failed = await fetch(route, { headers: { 'if-none-match': etag } });
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: 'Internal server error' });
  expect(await readFile(current.sourceFile, 'utf8')).toBe(saved);
  await rm(current.targetFile);
  await rename(current.targetFile + '.backup', current.targetFile);
  const repaired = await fetch(route);
  expect(repaired.status).toBe(200);
  expect((await repaired.json()).blocks[0].crossLinks).toEqual(current.links);
  expect((await new CanvasStore(current.root).getCanvas(current.source.id)).blocks[0].crossLinks).toEqual(current.links);
});

it('keeps invalid, missing and malformed source revisions distinct and resumes native conditional reads after source repair', async () => {
  const current = await fixture();
  const route = current.base + `/api/canvases/${current.source.id}`;
  const sourceBefore = await readFile(current.sourceFile, 'utf8');
  await expect(current.store.getCanvasRevision('../invalid')).rejects.toMatchObject({ status: 400, message: 'Invalid canvas ID' });
  await rename(current.sourceFile, current.sourceFile + '.backup');
  await expect(current.store.getCanvasRevision(current.source.id)).rejects.toMatchObject({ status: 404, message: 'Canvas not found' });
  const missing = await fetch(route);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'Canvas not found' });
  await writeFile(current.sourceFile, '{broken');
  await expect(current.store.getCanvasRevision(current.source.id)).rejects.toBeInstanceOf(SyntaxError);
  const corrupt = await fetch(route);
  expect(corrupt.status).toBe(500);
  expect(await corrupt.json()).toEqual({ error: 'Internal server error' });
  expect(await readFile(current.sourceFile, 'utf8')).toBe('{broken');
  await rm(current.sourceFile);
  await rename(current.sourceFile + '.backup', current.sourceFile);
  const repaired = await fetch(route);
  expect(repaired.status).toBe(200);
  expect((await repaired.json()).blocks[0].crossLinks).toEqual(current.links);
  const unchanged = await fetch(route, { headers: { 'if-none-match': repaired.headers.get('etag')! } });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
  expect(await readFile(current.sourceFile, 'utf8')).toBe(sourceBefore);
  expect(await new CanvasStore(current.root).getCanvasRevision(current.source.id)).toBe(await current.store.getCanvasRevision(current.source.id));
});

it('keeps the public workspace similarity index synchronized with native loaded, archived and deleted document states', async () => {
  const current = await fixture();
  const sibling = await current.store.createBlock(current.source.id, { title: 'Reader duplicate', content: current.reader.content });
  await current.store.getCanvas(current.source.id);
  const index = current.store.similarityIndex(current.workspace.id);
  expect(index.neighbors(current.reader.id, 5)).toContainEqual(expect.objectContaining({ blockId: sibling.id }));
  await current.store.updateBlock(current.source.id, sibling.id, { archived: true });
  await current.store.getCanvas(current.source.id);
  expect(index.neighbors(current.reader.id, 5).some(item => item.blockId === sibling.id)).toBe(false);
  await current.store.updateBlock(current.source.id, sibling.id, { archived: false });
  const fresh = new CanvasStore(current.root);
  await fresh.getCanvas(current.source.id);
  expect(fresh.similarityIndex(current.workspace.id).neighbors(current.reader.id, 5)).toContainEqual(expect.objectContaining({ blockId: sibling.id }));
  await fresh.deleteCanvas(current.source.id);
  expect(index.neighbors(sibling.id, 5)).toEqual([]);
  await expect(new CanvasStore(current.root).getCanvas(current.source.id)).rejects.toMatchObject({ status: 404 });
});

it('deletes only the selected canvas references while retaining another saved reference to an archived target across restart', async () => {
  const current = await fixture();
  const retained = await current.store.createCanvas(current.workspace.id, { name: 'Retained reference' });
  const document = await current.store.createBlock(retained.id, { title: 'Archived retained target' });
  const link = { canvasId: retained.id, blockId: document.id, relation: 'prerequisite' as const, confidence: 0.9 };
  await current.store.updateBlock(current.source.id, current.reader.id, { crossLinks: [...current.links, link] });
  await current.store.updateBlock(retained.id, document.id, { archived: true });
  const deleted = await fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ ok: true });
  const saved = JSON.parse(await readFile(current.sourceFile, 'utf8'));
  expect(saved.blocks[0].crossLinks).toEqual([link]);
  expect((await new CanvasStore(current.root).getCanvas(current.source.id)).blocks[0].crossLinks).toBeUndefined();
  await current.store.updateBlock(retained.id, document.id, { archived: false });
  const fresh = new CanvasStore(current.root);
  await fresh.init();
  expect((await fresh.getCanvas(current.source.id)).blocks[0].crossLinks).toEqual([link]);
  await expect(fresh.getCanvas(current.target.id)).rejects.toMatchObject({ status: 404 });
  expect(await readFile(path.join(current.root, current.reader.file), 'utf8')).toBe(current.reader.content);
});

it.each(['{broken', '{}'])('does not erase earlier saved references when a later peer is unreadable during canvas deletion: %s', async malformed => {
  const current = await fixture();
  const peer = await current.store.createCanvas(current.workspace.id, { name: 'Later unreadable peer' });
  const peerFile = path.join(current.root, 'canvases', peer.id + '.json');
  const peerBefore = await readFile(peerFile, 'utf8');
  const before = await readFile(current.sourceFile, 'utf8');
  const targetBefore = await readFile(current.targetFile, 'utf8');
  const manifest = await readFile(path.join(current.root, 'workspaces.json'), 'utf8');
  await writeFile(peerFile, malformed);
  const failed = await fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' });
  expect(failed.status).toBe(500);
  expect(await readFile(current.targetFile, 'utf8')).toBe(targetBefore);
  expect(await readFile(path.join(current.root, 'workspaces.json'), 'utf8')).toBe(manifest);
  expect(await readFile(current.sourceFile, 'utf8')).toBe(before);
  expect((await new CanvasStore(current.root).getCanvas(current.source.id)).blocks[0].crossLinks).toEqual(current.links);
  await writeFile(peerFile, peerBefore);
  const retry = await fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' });
  expect(retry.status).toBe(200);
  expect((await new CanvasStore(current.root).getCanvas(current.source.id)).blocks[0].crossLinks).toBeUndefined();
});

it('restores saved reader references and reports original plus compensation errors when a later native canvas write fails, then succeeds after repair', async () => {
  const current = await fixture();
  const peer = await current.store.createCanvas(current.workspace.id, { name: 'Later write target' });
  const reader = await current.store.createBlock(peer.id, { title: 'Another reader' });
  await current.store.updateBlock(peer.id, reader.id, { crossLinks: current.links });
  const peerFile = path.join(current.root, 'canvases', peer.id + '.json');
  const peerBefore = await readFile(peerFile, 'utf8');
  const sourceBefore = await readFile(current.sourceFile, 'utf8');
  const targetBefore = await readFile(current.targetFile, 'utf8');
  const manifest = await readFile(path.join(current.root, 'workspaces.json'), 'utf8');
  await rename(peerFile, peerFile + '.backup');
  await promisify(execFile)('mkfifo', [peerFile]);
  const pending = current.store.deleteCanvas(current.target.id).catch(error => error as unknown);
  const writer = await open(peerFile, 'w');
  try {
    await writer.writeFile(peerBefore);
    await rename(peerFile, peerFile + '.fifo');
    await mkdir(peerFile);
    await writeFile(path.join(peerFile, 'external.txt'), 'Keep the peer obstruction');
  } finally { await writer.close(); }
  const failed = await pending;
  expect(failed).toBeInstanceOf(AggregateError);
  expect((failed as AggregateError).errors).toEqual([
    expect.objectContaining({ code: 'EISDIR', dest: peerFile }),
    expect.objectContaining({ code: 'EISDIR', dest: peerFile }),
  ]);
  expect((failed as AggregateError).errors[0].path).not.toBe((failed as AggregateError).errors[1].path);
  expect(await readFile(path.join(peerFile, 'external.txt'), 'utf8')).toBe('Keep the peer obstruction');
  expect(await readFile(current.targetFile, 'utf8')).toBe(targetBefore);
  expect(await readFile(path.join(current.root, 'workspaces.json'), 'utf8')).toBe(manifest);
  expect(await readFile(current.sourceFile, 'utf8')).toBe(sourceBefore);
  expect((await new CanvasStore(current.root).getCanvas(current.source.id)).blocks[0].crossLinks).toEqual(current.links);
  await rm(peerFile, { recursive: true });
  await rm(peerFile + '.fifo');
  await rename(peerFile + '.backup', peerFile);
  const retry = await fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' });
  expect(retry.status).toBe(200);
  const fresh = new CanvasStore(current.root);
  expect((await fresh.getCanvas(current.source.id)).blocks[0].crossLinks).toBeUndefined();
  expect((await fresh.getCanvas(peer.id)).blocks[0].crossLinks).toBeUndefined();
});

it.each(['manifest', 'target'] as const)('preserves peer references and the original manifest when post-peer %s persistence fails and allows native repair', async stage => {
  const current = await fixture();
  const peer = await current.store.createCanvas(current.workspace.id, { name: 'Deletion stage gate' });
  const peerFile = path.join(current.root, 'canvases', peer.id + '.json');
  const peerBefore = await readFile(peerFile, 'utf8');
  const sourceBefore = await readFile(current.sourceFile, 'utf8');
  const manifestFile = path.join(current.root, 'workspaces.json');
  const manifestBefore = await readFile(manifestFile, 'utf8');
  const targetBefore = await readFile(current.targetFile, 'utf8');
  const obstructed = stage === 'manifest' ? manifestFile : current.targetFile;
  await rename(peerFile, peerFile + '.backup');
  await promisify(execFile)('mkfifo', [peerFile]);
  const pending = fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' });
  const writer = await open(peerFile, 'w');
  try {
    await writer.writeFile(peerBefore);
    await rename(obstructed, obstructed + '.backup');
    await mkdir(obstructed);
    await writeFile(path.join(obstructed, 'external.txt'), 'Retain the external obstruction');
  } finally { await writer.close(); }
  const failed = await pending;
  expect(failed.status).toBe(500);
  expect(await readFile(current.sourceFile, 'utf8')).toBe(sourceBefore);
  expect(await readFile(path.join(obstructed, 'external.txt'), 'utf8')).toBe('Retain the external obstruction');
  if (stage === 'manifest') expect(await readFile(current.targetFile, 'utf8')).toBe(targetBefore);
  else expect(await readFile(manifestFile, 'utf8')).toBe(manifestBefore);
  expect(await readFile(path.join(current.root, current.reference.file), 'utf8')).toBe(current.reference.content);
  await rm(obstructed, { recursive: true });
  await rename(obstructed + '.backup', obstructed);
  await rm(peerFile);
  await rename(peerFile + '.backup', peerFile);
  const fresh = new CanvasStore(current.root);
  expect((await fresh.getCanvas(current.source.id)).blocks[0].crossLinks).toEqual(current.links);
  expect((await fresh.listWorkspaces()).find(item => item.id === current.workspace.id)?.canvases).toContainEqual({ id: current.target.id, name: current.target.name });
  const retry = await fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' });
  expect(retry.status).toBe(200);
  expect((await new CanvasStore(current.root).getCanvas(current.source.id)).blocks[0].crossLinks).toBeUndefined();
});

it('reports both native manifest write and compensation errors while restoring independent reader files', async () => {
  const current = await fixture();
  const peer = await current.store.createCanvas(current.workspace.id, { name: 'Compensation gate' });
  const peerFile = path.join(current.root, 'canvases', peer.id + '.json');
  const peerBefore = await readFile(peerFile, 'utf8');
  const sourceBefore = await readFile(current.sourceFile, 'utf8');
  const manifestFile = path.join(current.root, 'workspaces.json');
  const manifestBefore = await readFile(manifestFile, 'utf8');
  await rename(peerFile, peerFile + '.backup');
  await promisify(execFile)('mkfifo', [peerFile]);
  const pending = current.store.deleteCanvas(current.target.id).catch(error => error as unknown);
  const writer = await open(peerFile, 'w');
  try {
    await writer.writeFile(peerBefore);
    await rename(manifestFile, manifestFile + '.backup');
    await mkdir(manifestFile);
    await writeFile(path.join(manifestFile, 'external.txt'), 'Do not overwrite this path');
  } finally { await writer.close(); }
  const failure = await pending;
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).message).toBe('Canvas deletion failed and could not be fully restored');
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ code: 'EISDIR' }), expect.objectContaining({ code: 'EISDIR' }),
  ]);
  expect(await readFile(current.sourceFile, 'utf8')).toBe(sourceBefore);
  expect(await readFile(manifestFile + '.backup', 'utf8')).toBe(manifestBefore);
  expect(await readFile(path.join(manifestFile, 'external.txt'), 'utf8')).toBe('Do not overwrite this path');
  await rm(manifestFile, { recursive: true });
  await rename(manifestFile + '.backup', manifestFile);
  await rm(peerFile);
  await rename(peerFile + '.backup', peerFile);
  const fresh = new CanvasStore(current.root);
  expect((await fresh.getCanvas(current.source.id)).blocks[0].crossLinks).toEqual(current.links);
  const retry = await fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' });
  expect(retry.status).toBe(200);
});

it('keeps the committed canvas removal and reports a later native document cleanup failure without restoring dangling references', async () => {
  const current = await fixture();
  const peer = await current.store.createCanvas(current.workspace.id, { name: 'Cleanup gate' });
  const peerFile = path.join(current.root, 'canvases', peer.id + '.json');
  const peerBefore = await readFile(peerFile, 'utf8');
  const documentFile = path.join(current.root, current.reference.file);
  await rename(peerFile, peerFile + '.backup');
  await promisify(execFile)('mkfifo', [peerFile]);
  const pending = fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' });
  const writer = await open(peerFile, 'w');
  try {
    await writer.writeFile(peerBefore);
    await rename(documentFile, documentFile + '.backup');
    await mkdir(documentFile);
    await writeFile(path.join(documentFile, 'external.txt'), 'Keep unrelated filesystem content');
  } finally { await writer.close(); }
  const failed = await pending;
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: 'Internal server error' });
  const fresh = new CanvasStore(current.root);
  await expect(fresh.getCanvas(current.target.id)).rejects.toMatchObject({ status: 404 });
  expect((await fresh.getCanvas(current.source.id)).blocks[0].crossLinks).toBeUndefined();
  expect((await fresh.listWorkspaces()).find(item => item.id === current.workspace.id)?.canvases.some(item => item.id === current.target.id)).toBe(false);
  expect(await readFile(documentFile + '.backup', 'utf8')).toBe(current.reference.content);
  expect(await readFile(path.join(documentFile, 'external.txt'), 'utf8')).toBe('Keep unrelated filesystem content');
  expect((await fetch(current.base + `/api/canvases/${current.target.id}`, { method: 'DELETE' })).status).toBe(404);
  await rm(peerFile);
  await rename(peerFile + '.backup', peerFile);
  await rm(documentFile, { recursive: true });
  await rename(documentFile + '.backup', documentFile);
  expect((await new CanvasStore(current.root).getCanvas(current.source.id)).blocks[0].content).toBe(current.reader.content);
});
