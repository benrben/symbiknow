import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import type { JevSourceSnapshot } from '../shared/jev-types.js';
import { sourceSnapshot } from './jev/stamps.js';
import { CanvasStore } from './storage.js';
import { storedBlock } from './storage-shapes.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function document(canvas: string, index: number): CanvasBlock {
  const id = `${canvas}-doc-${index}`;
  return { id, file: `docs/${id}.md`, title: `Native source ${index}`, kind: 'markdown',
    content: `# Native source ${index}\nA checked delivery requirement for ${canvas}.`, x: 17 + index, y: 29, width: 280, height: 180,
    links: [], tags: ['Manual tag'], incarnation: `${id}-original`, sourceGeneration: 1, metadataRevision: 1,
    jevOwnership: { pins: ['tags'], managed: ['group', 'links'], removedLabels: [], removedLinks: [] } };
}
async function fixture(count = 3) {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-source-guard-')); roots.push(root);
  await Promise.all(['docs', 'canvases'].map(directory => mkdir(path.join(root, directory))));
  const primary = Array.from({ length: count }, (_, index) => document('primary', index));
  const other = [document('other', 0), document('other', 1)];
  const canvases = [{ id: 'primary', name: 'Primary', workspaceId: 'workspace', blocks: primary.map(storedBlock) },
    { id: 'other', name: 'Other', workspaceId: 'workspace', blocks: other.map(storedBlock) }];
  await Promise.all([...primary, ...other].map(block => writeFile(path.join(root, block.file), block.content)));
  await Promise.all(canvases.map(canvas => writeFile(path.join(root, 'canvases', `${canvas.id}.json`), JSON.stringify(canvas))));
  await writeFile(path.join(root, 'workspaces.json'), JSON.stringify([{ id: 'workspace', name: 'Native source guards',
    canvases: canvases.map(({ id, name }) => ({ id, name })) }]));
  const store = new CanvasStore(root); await store.init();
  const primarySources = primary.map(block => sourceSnapshot('workspace', 'primary', block));
  const otherSources = other.map(block => sourceSnapshot('workspace', 'other', block));
  const reads: string[] = []; const original = store.getCanvas.bind(store);
  // Observe the actual public storage read; every call still executes native metadata, body and index handling.
  store.getCanvas = (...args) => { reads.push(args[0]); return original(...args); };
  return { root, store, primary, other, primarySources, otherSources, canvases, reads };
}

it('checks 158 real source snapshots through one fresh native canvas load while preserving manual fields and source bytes', async () => {
  const current = await fixture(158); const start = performance.now();
  await current.store.jevExecutor.checkSources(current.primarySources);
  const elapsed = performance.now() - start;
  expect(current.reads).toEqual(['primary']);
  const manifest = JSON.parse(await readFile(path.join(current.root, 'canvases', 'primary.json'), 'utf8'));
  expect(manifest).toEqual(current.canvases[0]);
  expect(await readFile(path.join(current.root, current.primary[157].file), 'utf8')).toBe(current.primary[157].content);
  console.info(JSON.stringify({ sourceGuard: 'native-158', sourceCount: 158, canvasReads: current.reads.length, elapsedMs: elapsed }));
});

it('loads interleaved canvases once each in first-use order, keeps duplicate sources valid and starts a fresh map on the next call', async () => {
  const current = await fixture();
  const sources = [current.primarySources[0], current.otherSources[0], current.primarySources[1], current.otherSources[1], current.primarySources[0]];
  await current.store.jevExecutor.checkSources(sources); expect(current.reads).toEqual(['primary', 'other']);
  await current.store.jevExecutor.checkSources(sources); expect(current.reads).toEqual(['primary', 'other', 'primary', 'other']);
  current.reads.length = 0; await current.store.jevExecutor.checkSources([]); expect(current.reads).toEqual([]);
});

it.each([
  ['scope', { workspaceId: 'other-workspace' }, 404, 'Source scope not found'],
  ['missing document', { blockId: 'missing-document' }, 404, 'Document not found'],
  ['hash', { contentHash: 'wrong-hash' }, 409, 'The source changed since Symbi Reflex reviewed it'],
  ['metadata revision', { metadataRevision: 9 }, 409, 'The source changed since Symbi Reflex reviewed it'],
  ['source generation', { sourceGeneration: 9 }, 409, 'The source changed since Symbi Reflex reviewed it'],
  ['incarnation', { incarnation: 'replacement' }, 409, 'The source changed since Symbi Reflex reviewed it'],
] as const)('preserves first-failure order for %s before loading a later missing canvas', async (_name, patch, status, message) => {
  const current = await fixture(); const broken: JevSourceSnapshot = { ...current.primarySources[1], ...patch };
  await expect(current.store.jevExecutor.checkSources([current.primarySources[0], broken,
    { ...current.otherSources[0], canvasId: 'missing-canvas' }])).rejects.toMatchObject({ status, message });
  expect(current.reads).toEqual(['primary']);
});

it('detects native body edits, metadata changes, deletion and recreated incarnations on subsequent fresh guard calls', async () => {
  const current = await fixture(); const source = current.primarySources[0]; const block = current.primary[0];
  await current.store.jevExecutor.checkSources([source]);
  await writeFile(path.join(current.root, block.file), block.content + '\nA later external edit.');
  await expect(current.store.jevExecutor.checkSources([source])).rejects.toMatchObject({ status: 409 });
  await writeFile(path.join(current.root, block.file), block.content);
  await current.store.jevExecutor.checkSources([source]);
  const file = path.join(current.root, 'canvases', 'primary.json'); const canvas = structuredClone(current.canvases[0]);
  canvas.blocks[0].metadataRevision = 2; await writeFile(file, JSON.stringify(canvas));
  await expect(current.store.jevExecutor.checkSources([source])).rejects.toMatchObject({ status: 409 });
  const removed = canvas.blocks.shift()!; await writeFile(file, JSON.stringify(canvas));
  await expect(current.store.jevExecutor.checkSources([source])).rejects.toMatchObject({ status: 404, message: 'Document not found' });
  canvas.blocks.unshift({ ...removed, incarnation: 'recreated', metadataRevision: 1 }); await writeFile(file, JSON.stringify(canvas));
  await expect(current.store.jevExecutor.checkSources([source])).rejects.toMatchObject({ status: 409 });
  await current.store.jevExecutor.checkSources([{ ...source, incarnation: 'recreated' }]);
  expect(current.reads).toHaveLength(7);
  expect(await readFile(path.join(current.root, block.file), 'utf8')).toBe(block.content);
});

it('keeps the first native block when legacy metadata contains duplicate IDs and reports missing canvas files normally', async () => {
  const current = await fixture(); const canvas = structuredClone(current.canvases[0]);
  canvas.blocks.push({ ...canvas.blocks[0], incarnation: 'later-duplicate', metadataRevision: 99 });
  await writeFile(path.join(current.root, 'canvases', 'primary.json'), JSON.stringify(canvas));
  await current.store.jevExecutor.checkSources([current.primarySources[0]]);
  await expect(current.store.jevExecutor.checkSources([{ ...current.primarySources[0], incarnation: 'later-duplicate', metadataRevision: 99 }]))
    .rejects.toMatchObject({ status: 409 });
  await expect(current.store.jevExecutor.checkSources([{ ...current.otherSources[0], canvasId: 'missing-canvas' }]))
    .rejects.toMatchObject({ status: 404, message: 'Canvas not found' });
});
