import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasStore } from './storage.js';
import { selectAnswerCanvas } from './answer-canvas.js';
import type { ChatViewContext } from '../shared/answer-canvas.js';

const roots: string[] = [];
const context: ChatViewContext = { selectedBlockIds: [] };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-answer-boundaries-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return store;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
it('limits saved-state retrieval to active documents and weights view context across canvases', async () => {
  const store = await fixture();
  const other = await store.createCanvas('acme-team', { name: 'Other notes' });
  const foreign = await store.createBlock(other.id, { title: 'Foreign note', content: '' });
  await store.updateBlock(other.id, foreign.id, { group: 'custom:launch/qa' });
  await store.updateBlock('product-roadmap', 'launch-checklist', { group: 'custom:launch/qa' });
  const before = await store.getCanvas('product-roadmap');
  const result = await selectAnswerCanvas(store, before.id, '???', {
    selectedBlockIds: ['launch-checklist'], readerBlockId: foreign.id, focusBlockId: 'launch-checklist',
    activeGroup: 'custom:launch/qa', visibleGroups: ['custom:launch/qa'], visibleBlockIds: ['launch-checklist'],
    answerSourceIds: ['launch-checklist'], answerFocus: { level: 'sources', visibleQuestions: [],
      visibleSourceIds: ['launch-checklist'], focusedSourceId: 'launch-checklist' },
  });
  expect(result.sources.map(source => source.blockId)).toEqual(['launch-checklist', foreign.id]);
  expect(result.sources[0].relevance).toBe(1);
  expect(result.sources[1]).toMatchObject({ canvasId: other.id, relevance: 0.35, excerpt: '' });
  expect(result.sources[1].evidence).toBeUndefined();
  expect(await store.getCanvas(before.id)).toEqual(before);
});

it('retrieves the active canvas when its workspace catalog is unavailable', async () => {
  const store = await fixture();
  await writeFile(path.join(store.root, 'workspaces.json'), '[]');
  const result = await selectAnswerCanvas(store, 'product-roadmap', '???', { selectedBlockIds: ['launch-checklist'] });
  expect(result.sources.map(source => source.blockId)).toEqual(['launch-checklist']);
});

it('removes temporary similarity queries even when retrieving neighbors fails', async () => {
  const store = await fixture();
  const index = store.similarityIndex('acme-team');
  const remove = vi.spyOn(index, 'remove');
  vi.spyOn(index, 'neighbors').mockImplementationOnce(() => { throw new Error('Index unavailable'); });
  await expect(selectAnswerCanvas(store, 'product-roadmap', 'launch', context)).rejects.toThrow('Index unavailable');
  expect(remove).toHaveBeenCalledWith(expect.stringMatching(/^answer_query_/));
  const id = remove.mock.calls.find(([id]) => id.startsWith('answer_query_'))![0];
  expect(index.neighbors(id, 24, { sameCanvas: true, crossCanvas: true })).toEqual([]);
});

it('centers long excerpts on matching text and preserves truncation markers', async () => {
  const store = await fixture();
  const block = await store.createBlock('product-roadmap', { title: 'Long evidence', content: `${'Beginning. '.repeat(30)}Needle statement. ${'Continuation. '.repeat(40)}` });
  const result = await selectAnswerCanvas(store, 'product-roadmap', 'needle', { selectedBlockIds: [block.id] });
  const source = result.sources.find(source => source.blockId === block.id)!;
  expect(source.excerpt).toContain('Needle statement');
  expect(source.excerpt.startsWith('…')).toBe(true);
  expect(source.excerpt.endsWith('…')).toBe(true);
  expect(source.evidence?.passageKind).toBe('approximation');
});

it('keeps a conversation source below the local acceptance threshold out of the final sources', async () => {
  const store = await fixture();
  const result = await selectAnswerCanvas(store, 'product-roadmap', '???', {
    selectedBlockIds: [], answerSourceIds: ['launch-checklist'],
  });
  expect(result).toMatchObject({ selection: 'local', sources: [] });
});
