import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { createApiServer } from './index.js';
import { DocumentVersions } from './version-control.js';
import { blockStateHash } from './block-state.js';
import { documentReviewState } from '../shared/document-state.js';
import type { CanvasBlock } from '../shared/types.js';

let directory: string;
let store: CanvasStore;
let workspaceId: string;
let canvasId: string;
const servers: Server[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-storage-documents-'));
  store = new CanvasStore(directory);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Document writes' });
  workspaceId = workspace.id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Source' })).id;
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await rm(directory, { recursive: true, force: true });
});

async function api() {
  const server = await createApiServer({ dataDir: directory });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}

async function references() {
  const reader = await store.createBlock(canvasId, { title: 'Reader', content: '# Reader' });
  const other = await store.createBlock(canvasId, { title: 'Other document', content: '# Other' });
  const remote = await store.createCanvas(workspaceId, { name: 'Remote' });
  const target = await store.createBlock(remote.id, { title: 'Reference target' });
  const crossLinks = [{ canvasId: remote.id, blockId: target.id, relation: 'implements' as const, confidence: 0.87 }];
  await store.updateBlock(canvasId, reader.id, { crossLinks, links: [other.id], linkTypes: { [other.id]: 'related' } });
  return { reader, other, remote, target, crossLinks, file: path.join(directory, 'canvases', canvasId + '.json') };
}

it.each(['create', 'update-other', 'update-reader', 'layout-reader', 'link-reader', 'supersedes-reader', 'unlink-reader', 'delete-other'] as const)
  ('preserves saved cross-links hidden by archived targets during %s and restores them after unarchive and restart', async action => {
    const { reader, other, remote, target, crossLinks, file } = await references();
    await store.updateBlock(remote.id, target.id, { archived: true });
    expect((await store.getCanvas(canvasId)).blocks[0].crossLinks).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
    switch (action) {
      case 'create': await store.createBlock(canvasId, { title: 'Unrelated new document' }); break;
      case 'update-other': await store.updateBlock(canvasId, other.id, { tags: ['reviewed'] }); break;
      case 'update-reader': await store.updateBlock(canvasId, reader.id, { content: '# Reader edited' }); break;
      case 'layout-reader': await store.updateLayout(canvasId, [{ blockId: reader.id, x: 200, y: 300 }]); break;
      case 'link-reader': await store.updateInsightLink(canvasId, { type: 'link', fromBlockId: reader.id, toBlockId: other.id }, 'Reviewer'); break;
      case 'supersedes-reader': await store.updateInsightLink(canvasId, { type: 'link', fromBlockId: other.id, toBlockId: reader.id, relation: 'supersedes' }, 'Reviewer'); break;
      case 'unlink-reader': await store.updateInsightLink(canvasId, { type: 'unlink', fromBlockId: reader.id, toBlockId: other.id }, 'Reviewer'); break;
      case 'delete-other': await store.deleteBlock(canvasId, other.id); break;
    }
    expect(JSON.parse(await readFile(file, 'utf8')).blocks.find((block: { id: string }) => block.id === reader.id).crossLinks).toEqual(crossLinks);
    expect((await store.getCanvas(canvasId)).blocks[0].crossLinks).toBeUndefined();
    await store.updateBlock(remote.id, target.id, { archived: false });
    expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0].crossLinks).toEqual(crossLinks);
  });

it('preserves missing-destination references during an edit and reveals them after a native file repair', async () => {
  const { reader, remote, crossLinks, file } = await references();
  const targetFile = path.join(directory, 'canvases', remote.id + '.json');
  await rename(targetFile, targetFile + '.backup');
  expect((await store.getCanvas(canvasId)).blocks[0].crossLinks).toBeUndefined();
  await store.updateBlock(canvasId, reader.id, { title: 'Edited reader' });
  expect(JSON.parse(await readFile(file, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
  await rename(targetFile + '.backup', targetFile);
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0]).toMatchObject({ title: 'Edited reader', crossLinks });
});

it('keeps HTTP reads and review tokens filtered while explicit cross-link replacements and clearing affect only the selected document', async () => {
  const { reader, remote, target, crossLinks, file } = await references();
  const second = await store.createBlock(canvasId, { title: 'Other stored reader' });
  await store.updateBlock(canvasId, second.id, { crossLinks });
  await store.updateBlock(remote.id, target.id, { archived: true });
  const base = await api();
  const route = `/api/canvases/${canvasId}/blocks/${reader.id}`;
  const before = await fetch(base + `/api/canvases/${canvasId}`).then(response => response.json());
  const reviewed = before.blocks.find((block: CanvasBlock) => block.id === reader.id) as CanvasBlock;
  expect(reviewed.crossLinks).toBeUndefined();
  const edited = await fetch(base + route, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '# Reviewed edit', expectedDocumentState: documentReviewState(reviewed), expectedStateHash: blockStateHash(reviewed) }) });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ content: '# Reviewed edit' });
  expect(JSON.parse(await readFile(file, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
  const newTarget = await store.createBlock(remote.id, { title: 'Active replacement target' });
  const replacement = [{ canvasId: remote.id, blockId: newTarget.id, relation: 'prerequisite' }];
  const replaced = await fetch(base + route, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ crossLinks: replacement }) });
  expect(replaced.status).toBe(200);
  expect((await replaced.json()).crossLinks).toEqual(replacement);
  const replacedSaved = JSON.parse(await readFile(file, 'utf8'));
  expect(replacedSaved.blocks[0].crossLinks).toEqual(replacement);
  expect(replacedSaved.blocks.find((block: { id: string }) => block.id === second.id).crossLinks).toEqual(crossLinks);
  const cleared = await fetch(base + route, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ crossLinks: [] }) });
  expect(cleared.status).toBe(200);
  expect((await cleared.json()).crossLinks).toBeUndefined();
  await store.updateBlock(remote.id, target.id, { archived: false });
  const restarted = await new CanvasStore(directory).getCanvas(canvasId);
  expect(restarted.blocks[0].crossLinks).toBeUndefined();
  expect(restarted.blocks.find(block => block.id === second.id)?.crossLinks).toEqual(crossLinks);
});

it.each([3, 'stale review hash'])('rejects an invalid or stale state hash %j before touching persisted references and accepts the current filtered state', async hash => {
  const { reader, remote, target, crossLinks, file } = await references();
  await store.updateBlock(remote.id, target.id, { archived: true });
  const before = await store.getCanvas(canvasId);
  const saved = await readFile(file, 'utf8');
  const history = await store.documentHistory(canvasId, reader.id);
  await expect(store.updateBlock(canvasId, reader.id, { content: '# Obsolete edit', expectedStateHash: hash })).rejects.toMatchObject({ status: 409 });
  expect(await readFile(file, 'utf8')).toBe(saved);
  expect(await store.documentHistory(canvasId, reader.id)).toEqual(history);
  const updated = await store.updateBlock(canvasId, reader.id, { content: '# Current edit', expectedStateHash: blockStateHash(before.blocks[0]) });
  expect(updated.crossLinks).toBeUndefined();
  expect(JSON.parse(await readFile(file, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
});

it('returns the active owner lock during a permitted edit and clears layout grouping without losing saved references', async () => {
  const { reader, remote, target, crossLinks, file } = await references();
  await store.updateBlock(remote.id, target.id, { archived: true });
  const lock = await store.lockBlock(canvasId, reader.id, 'Owner', {});
  const edited = await store.updateBlock(canvasId, reader.id, { title: 'Owned reader', group: 'custom:release' }, 'Owner');
  expect(edited.lock).toEqual(lock);
  const layout = await store.updateLayout(canvasId, [{ blockId: reader.id, x: -400, y: 600, group: null }]);
  expect(layout.blocks[0]).toMatchObject({ x: -400, y: 600 });
  expect(layout.blocks[0].group).toBeUndefined();
  expect(layout.blocks[0].crossLinks).toBeUndefined();
  expect(JSON.parse(await readFile(file, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
  await store.unlockBlock(canvasId, reader.id, 'Owner', false);
});

it.each(['missing', 'archived'])('refuses %s link endpoints and preserves the whole native canvas before a later retry', async mode => {
  const { reader, other, file } = await references();
  if (mode === 'archived') await store.updateBlock(canvasId, other.id, { archived: true });
  const saved = await readFile(file, 'utf8');
  await expect(store.updateInsightLink(canvasId, { type: 'link', fromBlockId: reader.id,
    toBlockId: mode === 'missing' ? 'missing-document' : other.id }, 'Reviewer'))
    .rejects.toMatchObject({ status: 404, message: 'A linked document no longer exists' });
  expect(await readFile(file, 'utf8')).toBe(saved);
  if (mode === 'archived') await store.updateBlock(canvasId, other.id, { archived: false });
  await store.updateInsightLink(canvasId, { type: 'link', fromBlockId: reader.id, toBlockId: other.id }, 'Reviewer');
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0].links).toEqual([other.id]);
});

it.each(['bad-block', 'bad-target', 'same-canvas', 'missing', 'archived', 'foreign-workspace'])('rejects a %s move before changing source metadata, content or task context', async mode => {
  const { reader, remote, file } = await references();
  if (mode === 'archived') await store.updateBlock(canvasId, reader.id, { archived: true });
  let targetId = remote.id;
  if (mode === 'foreign-workspace') {
    const foreign = await store.createWorkspace({ name: 'Foreign' });
    targetId = (await store.createCanvas(foreign.id, { name: 'Foreign destination' })).id;
  }
  const saved = await readFile(file, 'utf8');
  const source = await readFile(path.join(directory, reader.file), 'utf8');
  const status = ['missing', 'archived'].includes(mode) ? 404 : 400;
  const pending = store.moveBlockToCanvas(canvasId, mode === 'bad-block' ? 'BAD' : mode === 'missing' ? 'missing-document' : reader.id,
    mode === 'bad-target' ? 'BAD' : mode === 'same-canvas' ? canvasId : targetId);
  await expect(pending).rejects.toMatchObject({ status });
  expect(await readFile(file, 'utf8')).toBe(saved);
  expect(await readFile(path.join(directory, reader.file), 'utf8')).toBe(source);
  expect(await new CanvasStore(directory).listTasks(canvasId)).toEqual([]);
});

it.each(['BAD', 'missing-document'])('refuses history, lock and unlock requests for %s before creating Git state', async id => {
  const status = id === 'BAD' ? 400 : 404;
  await expect(store.documentHistory(canvasId, id)).rejects.toMatchObject({ status });
  await expect(store.lockBlock(canvasId, id, 'Owner', {})).rejects.toMatchObject({ status });
  await expect(store.unlockBlock(canvasId, id, 'Owner', false)).rejects.toMatchObject({ status });
  await expect(stat(path.join(directory, '.versions', id))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects an explicit cross-link to the same canvas without changing the saved references', async () => {
  const { reader, other, file } = await references();
  const saved = await readFile(file, 'utf8');
  await expect(store.updateBlock(canvasId, reader.id, { crossLinks: [{ canvasId, blockId: other.id }] })).rejects.toMatchObject({ status: 400,
    message: 'Cross links must target existing documents in this workspace' });
  expect(await readFile(file, 'utf8')).toBe(saved);
});

it('rejects a missing reviewed cross-canvas source before editing the destination document', async () => {
  const { reader, remote, file } = await references();
  const saved = await readFile(file, 'utf8');
  await expect(store.updateBlock(canvasId, reader.id, { title: 'Obsolete title',
    expectedCrossTargetState: { canvasId: remote.id, blockId: 'missing-document', hash: 'old' } })).rejects.toMatchObject({ status: 409 });
  expect(await readFile(file, 'utf8')).toBe(saved);
});

it('removes typed local references with a deleted document while retaining unrelated labels and permits subsequent whole-field edits', async () => {
  const deleting = await store.createBlock(canvasId, { title: 'Delete target' });
  const retained = await store.createBlock(canvasId, { title: 'Retained target' });
  const reader = await store.createBlock(canvasId, { title: 'Reader', links: [deleting.id, retained.id] });
  const soleReader = await store.createBlock(canvasId, { title: 'Single-reference reader', links: [deleting.id] });
  await store.updateBlock(canvasId, reader.id, { linkTypes: { [deleting.id]: 'implements', [retained.id]: 'decision_for' } });
  await store.updateBlock(canvasId, soleReader.id, { linkTypes: { [deleting.id]: 'related' } });
  await store.deleteBlock(canvasId, deleting.id);
  const restarted = new CanvasStore(directory);
  const canvas = await restarted.getCanvas(canvasId);
  const savedReader = canvas.blocks.find(block => block.id === reader.id)!;
  expect(savedReader.links).toEqual([retained.id]);
  expect(savedReader.linkTypes).toEqual({ [retained.id]: 'decision_for' });
  expect(canvas.blocks.find(block => block.id === soleReader.id)?.linkTypes).toBeUndefined();
  const updated = await restarted.updateBlock(canvasId, reader.id, { title: 'Edited reader', links: savedReader.links, linkTypes: savedReader.linkTypes });
  expect(updated).toMatchObject({ title: 'Edited reader', links: [retained.id], linkTypes: { [retained.id]: 'decision_for' } });
  const persisted = JSON.parse(await readFile(path.join(directory, 'canvases', canvasId + '.json'), 'utf8'));
  expect(persisted.blocks.find((block: { id: string }) => block.id === reader.id).linkTypes).toEqual({ [retained.id]: 'decision_for' });
});

it('fails a native saved-snapshot reread before committing content and retries after repairing the real files', async () => {
  const { reader, file, crossLinks } = await references();
  const contentFile = path.join(directory, reader.file);
  const saved = await readFile(file, 'utf8');
  const history = await store.documentHistory(canvasId, reader.id);
  await rename(file, file + '.backup');
  await rename(contentFile, contentFile + '.backup');
  await promisify(execFile)('mkfifo', [file]);
  await promisify(execFile)('mkfifo', [contentFile]);
  const pending = store.updateBlock(canvasId, reader.id, { content: '# Attempted edit' });
  const rejected = expect(pending).rejects.toBeInstanceOf(SyntaxError);
  const metadataWriter = await open(file, 'w');
  try { await metadataWriter.writeFile(saved); } finally { await metadataWriter.close(); }
  // Reaching the document FIFO proves the first canvas JSON read and parse finished.
  const contentWriter = await open(contentFile, 'w');
  try {
    await contentWriter.writeFile(reader.content);
    await rename(file, file + '.fifo');
    await writeFile(file, '{broken saved snapshot');
  } finally { await contentWriter.close(); }
  await rejected;
  expect(await new DocumentVersions(path.join(directory, '.versions', reader.id)).status()).toEqual(history);
  expect(await readFile(file, 'utf8')).toBe('{broken saved snapshot');
  await rm(file);
  await rm(contentFile);
  await rm(file + '.fifo');
  await rename(file + '.backup', file);
  await rename(contentFile + '.backup', contentFile);
  await store.updateBlock(canvasId, reader.id, { content: '# Retried edit' });
  expect((await new CanvasStore(directory).getCanvas(canvasId)).blocks[0]).toMatchObject({ content: '# Retried edit', crossLinks });
  expect((await store.documentHistory(canvasId, reader.id)).commits[0].message).toBe('Edit Reader');
});

it('completes rollback and reports the original move failure after the native filesystem is repaired during compensation', async () => {
  const { reader, file, crossLinks } = await references();
  const destination = await store.createCanvas(workspaceId, { name: 'Move destination' });
  const targetTasks = path.join(directory, 'tasks', destination.id + '.json');
  await mkdir(path.dirname(targetTasks), { recursive: true });
  await promisify(execFile)('mkfifo', [targetTasks]);
  const before = await store.getCanvas(canvasId, true);
  let forwardObserved = false;
  let repaired = false;
  let monitor: NodeJS.Immediate;
  // Observe durable canvas contents directly; native directory-watch events may be coalesced.
  const observeRollback = () => {
    const current = JSON.parse(readFileSync(file, 'utf8'));
    const hasReader = current.blocks.some((block: { id: string }) => block.id === reader.id);
    if (!hasReader) forwardObserved = true;
    if (hasReader && forwardObserved) {
      rmSync(targetTasks, { recursive: true });
      writeFileSync(targetTasks, '[]');
      repaired = true;
    } else monitor = setImmediate(observeRollback);
  };
  monitor = setImmediate(observeRollback);
  try {
    const pending = store.moveBlockToCanvas(canvasId, reader.id, destination.id);
    const rejected = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY)$/) });
    const writer = await open(targetTasks, 'w');
    try {
      await writer.writeFile('[]');
      await rename(targetTasks, targetTasks + '.fifo');
      await mkdir(targetTasks);
    } finally { await writer.close(); }
    await rejected;
    expect(repaired).toBe(true);
    expect(await new CanvasStore(directory).getCanvas(canvasId, true)).toEqual(before);
    expect(JSON.parse(await readFile(file, 'utf8')).blocks[0].crossLinks).toEqual(crossLinks);
    expect((await new CanvasStore(directory).getCanvas(destination.id)).blocks).toEqual([]);
  } finally { clearImmediate(monitor); }
  await rm(targetTasks + '.fifo');
  await store.moveBlockToCanvas(canvasId, reader.id, destination.id);
  expect((await new CanvasStore(directory).getCanvas(destination.id)).blocks[0].id).toBe(reader.id);
});
