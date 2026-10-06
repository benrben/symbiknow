import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import type { StorageFiles } from './storage-files.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function storeWithDocument() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-history-')); roots.push(root);
  const store = new CanvasStore(root); await store.init();
  const canvas = await store.getCanvas('product-roadmap');
  const block = await store.createBlock(canvas.id, { title: 'History proof', content: '# Saved source' });
  await store.documentHistory(canvas.id, block.id);
  const files = (store as unknown as { files: StorageFiles }).files;
  return { root, store, canvasId: canvas.id, block, files };
}

function holdWriteQueue(files: StorageFiles) {
  let release!: () => void;
  const held = files.serialize(() => new Promise<void>(resolve => { release = resolve; }));
  return { release: () => { release(); return held; } };
}

it('reads saved history while other writes still hold the queue', async () => {
  const { store, canvasId, block, files } = await storeWithDocument();
  const queue = holdWriteQueue(files);
  const history = await store.documentHistory(canvasId, block.id);
  expect(history.current).toBe('main');
  expect(history.commits[0].message).toContain('Create');
  await queue.release();
});

it('still waits for the queue when an outside edit must be imported first', async () => {
  const { root, store, canvasId, block, files } = await storeWithDocument();
  await writeFile(path.join(root, block.file), '# Edited outside the app');
  const queue = holdWriteQueue(files);
  let settled = false;
  const pending = store.documentHistory(canvasId, block.id).then(history => { settled = true; return history; });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(settled).toBe(false);
  await queue.release();
  expect((await pending).commits[0]).toMatchObject({ author: 'filesystem', message: 'Import filesystem edit' });
});
