import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CanvasBlock, CrossLink } from '../shared/types.js';
import { CanvasStore, contentHash } from './storage.js';
import type { StoredBlock, StoredCanvas } from './storage-shapes.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function document(index: number, changes: Partial<StoredBlock> = {}): StoredBlock {
  return { id: `document-${index}`, title: `Document ${index}`, file: `docs/document-${index}.md`, kind: 'markdown',
    x: index * 450, y: 60, width: 420, height: 340, links: [], group: 'custom:research', tags: ['research'], ...changes };
}

async function fixture(blocks: StoredBlock[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-lazy-loading-'));
  roots.push(root);
  await mkdir(path.join(root, 'canvases'));
  await mkdir(path.join(root, 'docs'));
  const canvas: StoredCanvas = { id: 'large-canvas', name: 'Large canvas', workspaceId: 'research', blocks };
  const canvasFile = path.join(root, 'canvases', canvas.id + '.json');
  await writeFile(canvasFile, JSON.stringify(canvas));
  return { root, store: new CanvasStore(root), canvas, canvasFile };
}

it('returns a large canvas summary without opening any document bodies or updating similarity', async () => {
  const blocks = Array.from({ length: 2500 }, (_, index) => document(index));
  const current = await fixture([...blocks, document(2500, { archived: true, crossLinks: [{ canvasId: 'corrupt', blockId: 'missing' }] })]);
  await writeFile(path.join(current.root, 'canvases', 'corrupt.json'), '{broken');
  const index = current.store.similarityIndex(current.canvas.workspaceId);
  const previous: CanvasBlock[] = [0, 1].map(id => ({ ...document(id), content: 'Repeated original research content.' }));
  index.syncCanvas(current.canvas.id, previous);
  const neighborsBefore = index.neighbors(previous[0].id, 5);
  expect(neighborsBefore).toHaveLength(1);

  const summary = await current.store.getCanvasSummary(current.canvas.id);

  expect(summary).toMatchObject({ id: current.canvas.id, name: current.canvas.name, workspaceId: 'research' });
  expect(summary.blocks).toHaveLength(2500);
  expect(summary.blocks[2499]).toMatchObject({ ...blocks[2499], content: '', contentLoaded: false });
  expect(summary.blocks.every(block => block.content === '' && block.contentHash === undefined && block.contentLoaded === false)).toBe(true);
  expect(index.neighbors(previous[0].id, 5)).toEqual(neighborsBefore);
  expect(await readFile(current.canvasFile, 'utf8')).toBe(JSON.stringify(current.canvas));
});

it('loads only the selected document when unrelated and archived files are absent', async () => {
  const current = await fixture([document(0), ...Array.from({ length: 1200 }, (_, index) => document(index + 1)),
    document(1201, { archived: true })]);
  const content = '# Selected document\n\nRead the requested body only.';
  await writeFile(path.join(current.root, current.canvas.blocks[0].file), content);

  const loaded = await current.store.getCanvasBlock(current.canvas.id, 'document-0');

  expect(loaded).toMatchObject({ ...current.canvas.blocks[0], content, contentHash: contentHash(content), contentLoaded: true });
  expect(loaded.lock).toBeUndefined();
  expect(loaded.crossLinks).toBeUndefined();
});

it('reads current metadata and document contents after external edits without retaining old responses', async () => {
  const current = await fixture([document(0)]);
  const documentFile = path.join(current.root, current.canvas.blocks[0].file);
  await writeFile(documentFile, '# Original');
  const first = await current.store.getCanvasBlock(current.canvas.id, 'document-0');
  expect(first.content).toBe('# Original');
  current.canvas.blocks[0].title = 'Updated title';
  current.canvas.blocks[0].group = 'custom:updated';
  await writeFile(current.canvasFile, JSON.stringify(current.canvas));
  await writeFile(documentFile, '# Modified');

  const summary = await current.store.getCanvasSummary(current.canvas.id);
  const second = await current.store.getCanvasBlock(current.canvas.id, 'document-0');

  expect(summary.blocks[0]).toMatchObject({ title: 'Updated title', group: 'custom:updated', content: '', contentLoaded: false });
  expect(second).toMatchObject({ title: 'Updated title', content: '# Modified', contentHash: contentHash('# Modified') });
  expect(second.contentHash).not.toBe(first.contentHash);
});

it('returns live locks and filters cross-links using metadata without loading target bodies or rewriting references', async () => {
  const accepted: CrossLink = { canvasId: 'target', blockId: 'document-10', relation: 'related', confidence: 0.8 };
  const references: CrossLink[] = [accepted, { canvasId: 'target', blockId: 'document-11' },
    { canvasId: 'target', blockId: 'missing' }, { canvasId: 'missing-canvas', blockId: 'document-10' },
    { canvasId: 'foreign', blockId: 'document-12' }, { canvasId: 'large-canvas', blockId: 'document-0' }];
  const current = await fixture([document(0, { crossLinks: references }), document(1, { crossLinks: [] })]);
  await writeFile(path.join(current.root, 'docs', 'document-0.md'), '# Current body');
  await writeFile(path.join(current.root, 'canvases', 'target.json'), JSON.stringify({ id: 'target', name: 'Targets',
    workspaceId: 'research', blocks: [document(10), document(11, { archived: true })] }));
  await writeFile(path.join(current.root, 'canvases', 'foreign.json'), JSON.stringify({ id: 'foreign', name: 'Foreign',
    workspaceId: 'other-workspace', blocks: [document(12)] }));
  const lock = current.store.locks.acquire(current.canvas.id, 'document-0', 'editor', { note: 'Reviewing' });
  const saved = await readFile(current.canvasFile, 'utf8');

  const summary = await current.store.getCanvasSummary(current.canvas.id);
  const selected = await current.store.getCanvasBlock(current.canvas.id, 'document-0');

  expect(summary.blocks[0]).toMatchObject({ lock, crossLinks: [accepted] });
  expect(summary.blocks[1].crossLinks).toBeUndefined();
  expect(summary.blocks[1].lock).toBeUndefined();
  expect(selected).toMatchObject({ lock, crossLinks: [accepted], content: '# Current body' });
  expect(await readFile(current.canvasFile, 'utf8')).toBe(saved);
  current.store.locks.release(current.canvas.id, 'document-0', 'editor', false);
  await rm(path.join(current.root, 'canvases', 'target.json'));
  expect((await current.store.getCanvasSummary(current.canvas.id)).blocks[0].crossLinks).toBeUndefined();
  expect((await current.store.getCanvasBlock(current.canvas.id, 'document-0')).lock).toBeUndefined();
});

it('rejects invalid, missing and archived document IDs before reading any bodies', async () => {
  const current = await fixture([document(0, { archived: true })]);
  await expect(current.store.getCanvasSummary('../invalid')).rejects.toMatchObject({ status: 400, message: 'Invalid canvas ID' });
  await expect(current.store.getCanvasSummary('missing')).rejects.toMatchObject({ status: 404, message: 'Canvas not found' });
  await expect(current.store.getCanvasBlock('../invalid', 'document-0')).rejects.toMatchObject({ status: 400, message: 'Invalid canvas ID' });
  await expect(current.store.getCanvasBlock(current.canvas.id, '../invalid')).rejects.toMatchObject({ status: 400, message: 'Invalid block ID' });
  await expect(current.store.getCanvasBlock('missing', 'document-0')).rejects.toMatchObject({ status: 404, message: 'Canvas not found' });
  await expect(current.store.getCanvasBlock(current.canvas.id, 'missing')).rejects.toMatchObject({ status: 404, message: 'Document not found' });
  await expect(current.store.getCanvasBlock(current.canvas.id, 'document-0')).rejects.toMatchObject({ status: 404, message: 'Document not found' });
  expect((await current.store.getCanvasSummary(current.canvas.id)).blocks).toEqual([]);
});

it('surfaces missing selected-file errors and reads the repaired file on the next request', async () => {
  const current = await fixture([document(0)]);
  await expect(current.store.getCanvasBlock(current.canvas.id, 'document-0')).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path.join(current.root, 'docs', 'document-0.md'), '# Repaired');
  expect((await current.store.getCanvasBlock(current.canvas.id, 'document-0')).content).toBe('# Repaired');
});

it('propagates corrupt source metadata and resumes summary and document reads after repair', async () => {
  const current = await fixture([document(0)]);
  await writeFile(path.join(current.root, 'docs', 'document-0.md'), '# Selected body');
  await writeFile(current.canvasFile, '{broken');
  await expect(current.store.getCanvasSummary(current.canvas.id)).rejects.toBeInstanceOf(SyntaxError);
  await expect(current.store.getCanvasBlock(current.canvas.id, 'document-0')).rejects.toBeInstanceOf(SyntaxError);
  await writeFile(current.canvasFile, JSON.stringify(current.canvas));
  expect((await current.store.getCanvasSummary(current.canvas.id)).blocks[0].title).toBe('Document 0');
  expect((await current.store.getCanvasBlock(current.canvas.id, 'document-0')).content).toBe('# Selected body');
});

it('surfaces genuine linked metadata failures and preserves references for repair', async () => {
  const current = await fixture([document(0, { crossLinks: [{ canvasId: 'target', blockId: 'document-10' }] })]);
  await writeFile(path.join(current.root, 'docs', 'document-0.md'), '# Selected body');
  const targetFile = path.join(current.root, 'canvases', 'target.json');
  await writeFile(targetFile, '{broken');
  const saved = await readFile(current.canvasFile, 'utf8');
  await expect(current.store.getCanvasSummary(current.canvas.id)).rejects.toBeInstanceOf(SyntaxError);
  await expect(current.store.getCanvasBlock(current.canvas.id, 'document-0')).rejects.toBeInstanceOf(SyntaxError);
  expect(await readFile(current.canvasFile, 'utf8')).toBe(saved);
  await writeFile(targetFile, JSON.stringify({ id: 'target', name: 'Target', workspaceId: 'research', blocks: [document(10)] }));
  expect((await current.store.getCanvasSummary(current.canvas.id)).blocks[0].crossLinks).toEqual(current.canvas.blocks[0].crossLinks);
  expect((await current.store.getCanvasBlock(current.canvas.id, 'document-0')).crossLinks).toEqual(current.canvas.blocks[0].crossLinks);
});
