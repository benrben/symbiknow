import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanvasStore } from './storage';
import { selectAnswerCanvas } from './answer-canvas';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-answer-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return store;
}

describe('temporary answer canvas selection', () => {

  it('selects local matches without a decision provider', async () => {
    const store = await fixture();
    const answer = await selectAnswerCanvas(store, 'product-roadmap', 'launch checklist',
      { selectedBlockIds: [] });
    expect(answer.selection).toBe('local');
    expect(answer.sources.some(source => source.blockId === 'launch-checklist')).toBe(true);
  });

  it('uses the drilled group as retrieval context even when the question has no lexical match', async () => {
    const store = await fixture();
    await store.updateBlock('product-roadmap', 'launch-checklist', { group: 'custom:launch/qa' });
    const answer = await selectAnswerCanvas(store, 'product-roadmap', 'What matters here?', {
      selectedBlockIds: [], activeGroup: 'custom:launch/qa', visibleGroups: ['custom:launch/qa'], viewMode: 'titles',
    });
    expect(answer.sources.some(source => source.blockId === 'launch-checklist')).toBe(true);
  });

  it('keeps a direct fact in chat and honors an explicit request to draw', async () => {
    const store = await fixture();
    const direct = await selectAnswerCanvas(store, 'product-roadmap', 'Which tests failed?', { selectedBlockIds: [] });
    expect(direct.surface).toBe('chat');
    const canvasFact = await selectAnswerCanvas(store, 'product-roadmap', 'Which canvas is open?', { selectedBlockIds: [] });
    expect(canvasFact.surface).toBe('chat');
    const visual = await selectAnswerCanvas(store, 'product-roadmap', 'Draw an architecture diagram for the launch.',
      { selectedBlockIds: [] });
    expect(visual.surface).toBe('canvas');
    expect(visual.layout).toBe('architecture');
  });

  it('leaves a vague current-view request in ordinary chat', async () => {
    const store = await fixture();
    const result = await selectAnswerCanvas(store, 'product-roadmap', 'Help me with this?',
      { selectedBlockIds: ['launch-checklist'] });
    expect(result.surface).toBe('chat');
  });
  it.each([
    ['Draw a launch milestone timeline', 'canvas', 'roadmap'],
    ['Build a kanban task canvas', 'canvas', 'kanban'],
    ['Map a concept graph', 'canvas', 'mindmap'],
    ['Compare launch phases, but answer briefly in chat with no canvas', 'chat', undefined],
  ] as const)('uses local layout rules for %s', async (query, surface, layout) => {
    const store = await fixture();
    const before = await store.getCanvas('product-roadmap');
    expect(await selectAnswerCanvas(store, before.id, query, { selectedBlockIds: ['launch-checklist'] }))
      .toMatchObject({ selection: 'local', surface, layout });
    expect(await new CanvasStore(store.root).getCanvas(before.id)).toEqual(before);
  });

  it('caps local sources at seven and resolves capped-score ties from actual view context', async () => {
    const store = await fixture();
    const canvas = await store.createCanvas('acme-team', { name: 'Local research sources' });
    const ids: string[] = [];
    for (let index = 0; index < 8; index++) ids.push((await store.createBlock(canvas.id, {
      title: `Finding ${index}`, content: '# Native local evidence', group: 'custom:research',
    })).id);
    const before = await store.getCanvas(canvas.id);
    const result = await selectAnswerCanvas(store, canvas.id, '???', { selectedBlockIds: ids,
      visibleBlockIds: ids, activeGroup: 'custom:research', visibleGroups: ['custom:research'], answerSourceIds: ids,
      answerFocus: { level: 'sources', visibleQuestions: [], visibleSourceIds: ids, focusedSourceId: ids[0] } });
    expect(result.sources).toHaveLength(7);
    expect(result.sources.every(source => source.relevance === 1)).toBe(true);
    expect(result.sources[0].blockId).toBe(ids[0]);
    expect(result.sources.map(source => source.blockId)).toEqual(ids.slice(0, 7));
    expect(await new CanvasStore(store.root).getCanvas(canvas.id)).toEqual(before);
  });

});
