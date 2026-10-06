import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasStore } from './storage.js';
import { ChatProposalDraft, applyChatProposal } from './chat-proposals.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-audit-regression-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return store;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('reviewed app regressions', () => {
  it('applies typed links between saved and newly proposed documents', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    const target = draft.create({ title: 'Prerequisite', content: '# Prerequisite' });
    const source = draft.create({ title: 'Implementation', content: '# Implementation' });
    draft.patch(source.id, { links: [target.id], linkTypes: { [target.id]: 'implements' } }, 'link');
    draft.patch('launch-checklist', { links: [target.id], linkTypes: { [target.id]: 'prerequisite' } }, 'link');
    const receipt = await applyChatProposal(store, draft.publish()!.id);
    expect(receipt.status).toBe('applied');
    const saved = await store.getCanvas(canvas.id);
    const targetId = receipt.createdBlockIds[target.id];
    expect(saved.blocks.find(block => block.id === receipt.createdBlockIds[source.id]))
      .toMatchObject({ links: [targetId], linkTypes: { [targetId]: 'implements' } });
    expect(saved.blocks.find(block => block.id === 'launch-checklist'))
      .toMatchObject({ links: [targetId], linkTypes: { [targetId]: 'prerequisite' } });
  });

  it('uses one metadata initialization for concurrent readers', async () => {
    const store = await fixture();
    const block = (await store.getCanvas('product-roadmap')).blocks[0];
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => store.documentMetadata(block)));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    const history = await store.documentHistory('product-roadmap', block.id);
    expect(history.commits).toHaveLength(1);
    expect(history.current).toBe('main');
  });

  it('preserves inbound references and task context when a document moves', async () => {
    const store = await fixture();
    const source = await store.getCanvas('product-roadmap');
    const destination = await store.createCanvas(source.workspaceId, { name: 'Implementation' });
    const third = await store.createCanvas(source.workspaceId, { name: 'Reviews' });
    const reference = await store.createBlock(third.id, { title: 'Review', content: '# Review' });
    await store.updateBlock(third.id, reference.id,
      { crossLinks: [{ canvasId: source.id, blockId: 'roadmap-overview', relation: 'related' }] });
    const task = await store.createTask(source.id,
      { title: 'Review roadmap', blockIds: ['roadmap-overview', 'launch-flow'] }, 'Browser');
    await store.moveBlockToCanvas(source.id, 'roadmap-overview', destination.id, 'Browser');
    expect((await store.getCanvas(third.id)).blocks[0].crossLinks)
      .toEqual([{ canvasId: destination.id, blockId: 'roadmap-overview', relation: 'related' }]);
    const remaining = (await store.listTasks(source.id)).find(item => item.id === task.id)!;
    expect(remaining.blockIds).toEqual(['launch-flow']);
    expect(remaining.comments.at(-1)?.text).toContain(destination.name);
    expect((await store.listTasks(destination.id)).find(item => item.title === task.title))
      .toMatchObject({ blockIds: ['roadmap-overview'] });
  });

});
