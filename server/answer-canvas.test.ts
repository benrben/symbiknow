import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanvasStore } from './storage';
import { selectAnswerCanvas } from './answer-canvas';
import type { JevDecider, JevAnswer } from './jev';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-answer-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  await store.updateSettings({ jevApiKey: 'test-key' });
  return store;
}

describe('temporary answer canvas selection', () => {
  it('uses Jev to select relevant documents while leaving saved canvases unchanged', async () => {
    const store = await fixture();
    const before = await store.getCanvas('product-roadmap');
    const decider: JevDecider = async (_key, state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (id === 'answer_surface') return [id, { type: 'choice', choice: 'chat', confidence: 1, probabilities: { chat: 1 } }];
      if (question.type !== 'score') throw new Error('Expected a relevance score');
      const source = (state as { sources: Array<{ title: string }> }).sources[Number(id.split('_')[1])];
      const score = source.title === 'Launch checklist' ? 4 : 0;
      return [id, { type: 'score', score, confidence: 1,
        probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === score)])) }];
    }));
    const answer = await selectAnswerCanvas(store, 'product-roadmap', 'What does the launch checklist say?',
      { selectedBlockIds: ['launch-checklist'] }, decider);
    expect(answer.selection).toBe('jev');
    expect(answer.surface).toBe('chat');
    expect(answer.sources.map(source => source.blockId)).toEqual(['launch-checklist']);
    expect(answer.sources[0].excerpt).toContain('Launch checklist');
    expect(answer.sources[0].evidence).toMatchObject({ claim: 'Candidate context for: What does the launch checklist say?',
      canvasId: 'product-roadmap', documentId: 'launch-checklist', navigation: { kind: 'document',
        canvasId: 'product-roadmap', blockId: 'launch-checklist' } });
    expect(Number.isFinite(Date.parse(answer.sources[0].evidence!.checkedAt))).toBe(true);
    expect(await store.getCanvas('product-roadmap')).toEqual(before);
  });

  it('shows local matches when Jev is unavailable', async () => {
    const store = await fixture();
    const answer = await selectAnswerCanvas(store, 'product-roadmap', 'launch checklist',
      { selectedBlockIds: [] }, async () => { throw new Error('offline'); });
    expect(answer.selection).toBe('local');
    expect(answer.sources.some(source => source.blockId === 'launch-checklist')).toBe(true);
  });

  it('uses the drilled group as retrieval context even when the question has no lexical match', async () => {
    const store = await fixture();
    await store.updateBlock('product-roadmap', 'launch-checklist', { group: 'custom:launch/qa' });
    const answer = await selectAnswerCanvas(store, 'product-roadmap', 'What matters here?', {
      selectedBlockIds: [], activeGroup: 'custom:launch/qa', visibleGroups: ['custom:launch/qa'], viewMode: 'titles',
    }, async () => { throw new Error('offline'); });
    expect(answer.sources.some(source => source.blockId === 'launch-checklist')).toBe(true);
  });

  it('keeps a direct fact in chat and honors an explicit request to draw', async () => {
    const store = await fixture();
    const decider: JevDecider = async (_key, _state, questions) => {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, question] of Object.entries(questions)) answers[id] = question.type === 'score'
        ? { type: 'score', score: 4, confidence: 1, probabilities: { '4': 1 } }
        : { type: 'choice', choice: 'chat', confidence: 1, probabilities: { chat: 1 } };
      return answers;
    };
    const direct = await selectAnswerCanvas(store, 'product-roadmap', 'Which tests failed?', { selectedBlockIds: [] }, decider);
    expect(direct.surface).toBe('chat');
    const canvasFact = await selectAnswerCanvas(store, 'product-roadmap', 'Which canvas is open?', { selectedBlockIds: [] }, decider);
    expect(canvasFact.surface).toBe('chat');
    const visual = await selectAnswerCanvas(store, 'product-roadmap', 'Draw an architecture diagram for the launch.',
      { selectedBlockIds: [] }, decider);
    expect(visual.surface).toBe('canvas');
    expect(visual.layout).toBe('architecture');
  });

  it('asks for a direction when the user refers vaguely to the current view', async () => {
    const store = await fixture();
    const result = await selectAnswerCanvas(store, 'product-roadmap', 'Help me with this?',
      { selectedBlockIds: ['launch-checklist'] }, async () => { throw new Error('offline'); });
    expect(result.surface).toBe('clarify');
  });
});
