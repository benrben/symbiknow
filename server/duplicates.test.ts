import { describe, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import { findDuplicates } from './duplicates.js';
import type { JevAnswer, JevDecider, JevQuestion } from './jev.js';
import { SimilarityIndex } from './similarity.js';

function block(id: string, title: string, content: string): CanvasBlock {
  return { id, title, content, contentHash: id, file: `docs/${id}.md`, kind: 'markdown',
    x: 0, y: 0, width: 400, height: 320, links: [] };
}

function answer(question: JevQuestion, value: string | number, confidence = 0.94): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: Number(value) };
  if (question.type === 'score') return { type: 'score', score: Number(value), confidence: 0.9,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === value)])) };
  return { type: 'choice', choice: String(value), confidence,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === value)])) };
}

const shared = 'Install the command line package, configure the service endpoint, provide credentials, run the setup command, and verify the response in the dashboard.';

describe('duplicate detection and merge planning', () => {
  it('asks pair and section questions, then returns a reviewable merge plan with evidence', async () => {
    const first = block('a', 'Setup draft', `# Setup\n${shared}\n## Extra option\nEnable the experimental cache to speed up imports.\n## Limits\nThe maximum batch size is twenty.\n## Old service\nThe old gateway must be restarted daily.`);
    const second = block('b', 'Setup current', `# Setup\n${shared}\n## Operations\nMonitor the queue after deployment.`);
    const before = structuredClone([first, second]);
    const calls: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
    const decider: JevDecider = async (_key, state, questions) => {
      calls.push({ state, questions });
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        const value = id.endsWith('_dup_kind') ? 'partial' : id.endsWith('_dup_degree') ? 3
          : id.endsWith('_merge_safe') ? 0.88
            : id.endsWith('_s0') ? 'covered' : id.endsWith('_s1') ? 'adds'
              : id.endsWith('_s2') ? 'conflicts' : 'obsolete';
        return [id, answer(question, value)];
      }));
    };
    const suggestions = await findDuplicates({ canvasId: 'canvas', blocks: [first, second], index: new SimilarityIndex(), apiKey: 'test', decider,
      lastModified: { a: '2024-01-01T00:00:00Z', b: '2024-06-01T00:00:00Z' } });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ category: 'merge', confidence: 0.94, canvasIds: ['canvas', 'canvas'],
      action: { type: 'merge', keepBlockId: 'b', mergeBlockIds: ['a'], plan: {
        keep: 'b', fold: ['a:s1'], conflicts: ['a:s2'], drop: ['a:s3'],
      } } });
    expect(suggestions[0].evidence).toHaveLength(7);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].questions)).toEqual(['p0_dup_kind', 'p0_dup_degree', 'p0_merge_safe']);
    const pairState = calls[0].state as { a: { outline: string[]; sections: { text: string }[] }; b: unknown };
    expect(pairState.a.outline).toEqual(['Setup', 'Extra option', 'Limits', 'Old service']);
    expect(pairState.a.sections.every(section => section.text.length <= 600)).toBe(true);
    expect('overlap' in pairState).toBe(false);
    expect([first, second]).toEqual(before);
  });

  it('picks the more recently modified document when kind gives no keeper, without asking a "newer" question', async () => {
    const blocks = [block('a', 'First', shared), block('b', 'Second', shared)];
    let calls = 0;
    const decider: JevDecider = async (_key, _state, questions) => {
      calls++;
      expect(Object.keys(questions).some(id => id.endsWith('_newer'))).toBe(false);
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question,
        id.endsWith('_dup_kind') ? 'identical' : id.endsWith('_dup_degree') ? 4 : 0.8)]));
    };
    const input = { canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test', decider };
    expect((await findDuplicates(input))[0].action.plan).toEqual({ keep: 'a', fold: [], conflicts: [], drop: [] });
    const withDates = await findDuplicates({ ...input, lastModified: { a: '2024-01-01', b: '2024-06-01' } });
    expect(withDates[0].action.plan.keep).toBe('b');
    expect(calls).toBe(2);
  });

  it('keeps the later created document when Git revision timestamps tie', async () => {
    const first = block('a', 'Setup draft', shared);
    const second = block('b', 'Setup current', shared);
    const reader = block('reader', 'Readme', 'Follow the setup document for installation.');
    reader.links = ['a'];
    const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions)
      .map(([id, question]) => [id, answer(question, id.endsWith('_dup_kind') ? 'identical'
        : id.endsWith('_dup_degree') ? 4 : 0.9)]));
    const suggestions = await findDuplicates({ canvasId: 'canvas', blocks: [first, second, reader],
      index: new SimilarityIndex(), apiKey: 'test', decider,
      lastModified: { a: '2026-09-27T10:00:00Z', b: '2026-09-27T10:00:00Z' } });
    expect(suggestions.find(item => item.blockIds.includes('a') && item.blockIds.includes('b'))?.action.plan.keep).toBe('b');
  });

  it('gates merge.show and merge_safe.show separately, and uses kind confidence as item confidence', async () => {
    const blocks = [block('a', 'First', shared), block('b', 'Second', shared)];
    const deciderWith = (safe: number): JevDecider => async (_key, _state, questions) =>
      Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
        id.endsWith('_dup_kind') ? answer(question, 'identical', 0.9) : id.endsWith('_merge_safe') ? answer(question, safe) : answer(question, 4)]));
    const base = { canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test' };
    expect(await findDuplicates({ ...base, decider: deciderWith(0.5) })).toEqual([]);
    const shown = await findDuplicates({ ...base, decider: deciderWith(0.7) });
    expect(shown).toHaveLength(1);
    expect(shown[0].confidence).toBe(0.9);
  });

  it('limits each document to three candidates and can inspect one document across canvases', async () => {
    const blocks = Array.from({ length: 6 }, (_, index) => block(`doc-${index}`, `Guide ${index}`, shared));
    const judged: [string, string][] = [];
    const decider: JevDecider = async (_key, state, questions) => {
      const pair = state as { a: { title: string }; b: { title: string } };
      judged.push([pair.a.title, pair.b.title]);
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question,
        id.endsWith('_dup_kind') ? 'distinct' : id.endsWith('_dup_degree') ? 0 : 0)]));
    };
    await findDuplicates({ canvasId: 'first', blocks, index: new SimilarityIndex(), apiKey: 'test', decider });
    const counts = new Map<string, number>();
    for (const [a, b] of judged) {
      counts.set(a, (counts.get(a) ?? 0) + 1);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);

    const index = new SimilarityIndex();
    const external = block('outside', 'Outside', shared);
    const only = [block('inside', 'Inside', shared)];
    const crossDecider: JevDecider = async (_key, _state, questions) => Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [id, answer(question,
        id.endsWith('_dup_kind') ? 'identical' : id.endsWith('_dup_degree') ? 4 : 0.85)]));
    const crossInput = { canvasId: 'first', blocks: only, workspaceBlocks: [{ canvasId: 'second', block: external }],
      blockId: 'inside', index, apiKey: 'test', decider: crossDecider };
    expect(await findDuplicates(crossInput)).toEqual([]);
    expect((await findDuplicates({ ...crossInput, crossCanvas: true }))[0].canvasIds).toEqual(['first', 'second']);
  });

  it('judges pairs with bounded concurrency while keeping deterministic output order', async () => {
    const blocks = Array.from({ length: 8 }, (_, index) => block(`doc-${index}`, `Guide ${index}`, `${shared} Section ${index}.`));
    let inFlight = 0;
    let maxInFlight = 0;
    let callIndex = 0;
    const makeDecider = (reverseDelay: boolean): JevDecider => async (_key, _state, questions) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const order = callIndex++;
      await new Promise(resolve => setTimeout(resolve, reverseDelay ? (10 - order) : order));
      inFlight--;
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question,
        id.endsWith('_dup_kind') ? 'identical' : id.endsWith('_dup_degree') ? 4 : 0.9)]));
    };
    const first = await findDuplicates({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test', decider: makeDecider(false) });
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    callIndex = 0;
    const second = await findDuplicates({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test', decider: makeDecider(true) });
    expect(second.map(item => item.id)).toEqual(first.map(item => item.id));
  });
});
