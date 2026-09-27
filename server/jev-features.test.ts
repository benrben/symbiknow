import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { feedbackSummary, recordFeedback } from './feedback.js';

const directories: string[] = [];
async function freshStore() {
  const directory = await mkdtemp(path.join(tmpdir(), 'symbiknow-jev-features-'));
  directories.push(directory);
  const store = new CanvasStore(directory);
  await store.init();
  return store;
}

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('reviewed Jev changes', () => {
  it('archives merged documents, repoints incoming links, and preserves their history', async () => {
    const store = await freshStore();
    const source = await store.createBlock('product-roadmap', { title: 'Readme', content: '# Readme' });
    const old = await store.createBlock('product-roadmap', { title: 'Setup v1', content: '# Setup\n\nInstall package A.' });
    const current = await store.createBlock('product-roadmap', { title: 'Setup v2', content: '# Setup\n\nInstall package B.' });
    await store.updateBlock('product-roadmap', source.id, { links: [old.id], linkTypes: { [old.id]: 'prerequisite' } });
    const neighbor = await store.createCanvas('acme-team', { name: 'Related' });
    const portal = await store.createBlock(neighbor.id, { title: 'Portal' });
    await store.updateBlock(neighbor.id, portal.id, { crossLinks: [{ canvasId: 'product-roadmap', blockId: old.id }] });

    const merge = await store.mergeDocuments('product-roadmap', { keepBlockId: current.id, mergeBlockIds: [old.id],
      content: '# Setup\n\nInstall package B.\n\nCompatibility note from v1.',
      expectedContentHashes: { [current.id]: current.contentHash, [old.id]: old.contentHash } });
    expect(merge).toMatchObject({ keepBlockId: current.id, archivedBlockIds: [old.id], mergeId: expect.any(String) });
    const visible = await store.getCanvas('product-roadmap');
    expect(visible.blocks.some(block => block.id === old.id)).toBe(false);
    expect(visible.blocks.find(block => block.id === source.id)).toMatchObject({
      links: [current.id], linkTypes: { [current.id]: 'prerequisite' },
    });
    expect((await store.getCanvas('product-roadmap', true)).blocks.find(block => block.id === old.id)?.archived).toBe(true);
    expect((await store.getCanvas(neighbor.id)).blocks.find(block => block.id === portal.id)?.crossLinks).toEqual([
      { canvasId: 'product-roadmap', blockId: current.id },
    ]);
    expect((await store.documentHistory('product-roadmap', old.id)).commits.length).toBeGreaterThan(0);
    await expect(store.mergeDocuments('product-roadmap', { keepBlockId: current.id, mergeBlockIds: [old.id],
      content: '# Bad', expectedContentHashes: { [current.id]: current.contentHash, [old.id]: old.contentHash } }))
      .rejects.toMatchObject({ status: 404 });
    expect(await store.undoMerge(merge.mergeId)).toEqual({ mergeId: merge.mergeId, reverted: true });
    const restored = await store.getCanvas('product-roadmap');
    expect(restored.blocks.find(block => block.id === old.id)?.archived).toBeUndefined();
    expect(restored.blocks.find(block => block.id === source.id)).toMatchObject({
      links: [old.id], linkTypes: { [old.id]: 'prerequisite' },
    });
    expect(restored.blocks.find(block => block.id === current.id)?.content).toBe('# Setup\n\nInstall package B.');
    expect((await store.getCanvas(neighbor.id)).blocks.find(block => block.id === portal.id)?.crossLinks).toEqual([
      { canvasId: 'product-roadmap', blockId: old.id },
    ]);
    await expect(store.undoMerge(merge.mergeId)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to undo a merge after its keeper changed', async () => {
    const store = await freshStore();
    const old = await store.createBlock('product-roadmap', { title: 'Old', content: '# Old' });
    const keeper = await store.createBlock('product-roadmap', { title: 'Keeper', content: '# Keeper' });
    const merge = await store.mergeDocuments('product-roadmap', { keepBlockId: keeper.id, mergeBlockIds: [old.id],
      content: '# Combined', expectedContentHashes: { [keeper.id]: keeper.contentHash, [old.id]: old.contentHash } });
    await store.updateBlock('product-roadmap', keeper.id, { content: '# Another edit' });
    await expect(store.undoMerge(merge.mergeId)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects cross links outside the workspace and records feedback buckets', async () => {
    const store = await freshStore();
    const outside = await store.createWorkspace({ name: 'Outside' });
    const outsideCanvas = await store.createCanvas(outside.id, { name: 'Other' });
    const target = await store.createBlock(outsideCanvas.id, { title: 'Target' });
    await expect(store.updateBlock('product-roadmap', 'roadmap-overview', {
      crossLinks: [{ canvasId: outsideCanvas.id, blockId: target.id }],
    })).rejects.toMatchObject({ status: 400 });
    await recordFeedback(store.root, 'product-roadmap', { itemId: 'link-1', category: 'connection', confidence: 0.8, decision: 'applied' });
    await recordFeedback(store.root, 'product-roadmap', { itemId: 'link-2', category: 'connection', confidence: 0.8, decision: 'dismissed' });
    expect(await feedbackSummary(store.root)).toContainEqual({ category: 'connection', bucket: '0.75–0.85',
      applied: 1, dismissed: 1, applyRate: 0.5 });
  });
});
