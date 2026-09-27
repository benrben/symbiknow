import { describe, expect, it } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { findCrossConnections } from './cross-canvas.js';
import type { JevAnswer, JevDecider, JevQuestion } from './jev.js';
import { SimilarityIndex } from './similarity.js';

function block(id: string, title: string, content: string): CanvasBlock {
  return { id, title, content, contentHash: id, file: `docs/${id}.md`, kind: 'markdown',
    x: 0, y: 0, width: 400, height: 320, links: [] };
}

function canvas(id: string, name: string, blocks: CanvasBlock[], workspaceId = 'workspace'): CanvasDocument {
  return { id, name, workspaceId, blocks };
}

function answer(question: JevQuestion, value: string | number, confidence = 0.9): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: Number(value) };
  if (question.type === 'score') return { type: 'score', score: Number(value), confidence,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === value)])) };
  return { type: 'choice', choice: String(value), confidence,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === value)])) };
}

const common = 'The billing API client reads rate limit headers and schedules retries after the service returns a throttling response.';

describe('cross-canvas connections', () => {
  it('uses canvas scores before judging documents and returns directional cross-link actions', async () => {
    const first = canvas('canvas-a', 'API', [block('rate-limits', 'API rate limits', common)]);
    const second = canvas('canvas-b', 'Billing', [block('billing-client', 'Billing API client', common)]);
    const calls: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
    const decider: JevDecider = async (_key, state, questions) => {
      calls.push({ state, questions });
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question,
        id.startsWith('c') || id.endsWith('_strength') ? 4 : id.endsWith('_relation') ? 'implements' : 'both')]));
    };
    const items = await findCrossConnections({ canvases: [first, second], index: new SimilarityIndex(), apiKey: 'test', decider });
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].questions)).toEqual(['c0_related']);
    expect((calls[0].state as { pairs: { a: { titles: string[] } }[] }).pairs[0].a.titles).toEqual(['API rate limits']);
    expect(Object.keys(calls[1].questions)).toEqual(['x0_strength', 'x0_relation', 'x0_direction']);
    expect('cosine' in (calls[1].state as object)).toBe(false);
    expect(items).toHaveLength(2);
    expect(items[0].action).toMatchObject({ type: 'cross_link', to: { relation: 'implements', confidence: 0.9 } });
    expect(items.map(item => item.action)).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromBlockId: 'rate-limits', to: expect.objectContaining({ canvasId: 'canvas-b', blockId: 'billing-client' }) }),
      expect.objectContaining({ fromBlockId: 'billing-client', to: expect.objectContaining({ canvasId: 'canvas-a', blockId: 'rate-limits' }) }),
    ]));
    expect(items[0].evidence?.map(entry => entry.questionId)).toEqual(['c0_related', 'x0_strength', 'x0_relation', 'x0_direction']);
  });

  it('drops unrelated canvas pairs before document questions', async () => {
    const canvases = [canvas('a', 'API', [block('doc-a', 'Rate limits', common)]),
      canvas('b', 'Finance', [block('doc-b', 'Billing', common)])];
    let calls = 0;
    const decider: JevDecider = async (_key, _state, questions) => {
      calls++;
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question,
        id.startsWith('c') ? 1 : id.endsWith('_strength') ? 4 : id.endsWith('_relation') ? 'same_topic' : 'a_to_b')]));
    };
    expect(await findCrossConnections({ canvases, index: new SimilarityIndex(), apiKey: 'test', decider })).toEqual([]);
    expect(calls).toBe(1);
  });

  it('shows a medium-confidence suggestion without an action and skips existing cross-links', async () => {
    const a = block('a', 'Rate limits', common);
    const b = block('b', 'Billing client', common);
    const canvases = [canvas('first', 'API', [a]), canvas('second', 'Billing', [b])];
    const medium: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
      answer(question, id.startsWith('c') || id.endsWith('_strength') ? 4 : id.endsWith('_relation') ? 'same_topic' : 'a_to_b',
        id.endsWith('_relation') ? 0.8 : 0.9)]));
    const input = { canvases, index: new SimilarityIndex(), apiKey: 'test', decider: medium };
    const items = await findCrossConnections(input);
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe(0.8);
    expect(items[0].action).toBeUndefined();
    a.crossLinks = [{ canvasId: 'second', blockId: 'b', relation: 'same_topic' }];
    expect(await findCrossConnections(input)).toEqual([]);
    await expect(findCrossConnections({ ...input, canvases: [canvases[0], canvas('other', 'Other', [b], 'another-workspace')] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('gates on relation strength as a value, never as the confidence', async () => {
    const a = block('a', 'Rate limits', common);
    const b = block('b', 'Billing client', common);
    const canvases = [canvas('first', 'API', [a]), canvas('second', 'Billing', [b])];
    // A high-confidence but low-value strength score must hide the pair, even though every confidence is high.
    const weak: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
      answer(question, id.startsWith('c') ? 4 : id.endsWith('_strength') ? 0 : id.endsWith('_relation') ? 'same_topic' : 'a_to_b', 0.95)]));
    expect(await findCrossConnections({ canvases, index: new SimilarityIndex(), apiKey: 'test', decider: weak })).toEqual([]);

    // A top strength score must never be reported back as the confidence.
    const strong: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
      answer(question, id.startsWith('c') ? 4 : id.endsWith('_strength') ? 4 : id.endsWith('_relation') ? 'same_topic' : 'a_to_b',
        id.endsWith('_strength') ? 1 : 0.72)]));
    const items = await findCrossConnections({ canvases, index: new SimilarityIndex(), apiKey: 'test', decider: strong });
    expect(items[0].confidence).toBe(0.72);
    expect(items[0].confidence).not.toBe(1);
  });

  it('judges document pairs with bounded concurrency while keeping deterministic output order', async () => {
    const canvases = Array.from({ length: 6 }, (_, index) =>
      canvas(`c${index}`, `Canvas ${index}`, [block(`doc-${index}`, `Doc ${index}`, `${common} Extra ${index}.`)]));
    let inFlight = 0;
    let maxInFlight = 0;
    let callIndex = 0;
    const makeDecider = (reverseDelay: boolean): JevDecider => async (_key, _state, questions) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const order = callIndex++;
      await new Promise(resolve => setTimeout(resolve, reverseDelay ? (20 - order) : order));
      inFlight--;
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question,
        id.startsWith('c') || id.endsWith('_strength') ? 4 : id.endsWith('_relation') ? 'same_topic' : 'a_to_b')]));
    };
    const first = await findCrossConnections({ canvases, index: new SimilarityIndex(), apiKey: 'test', decider: makeDecider(false) });
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    callIndex = 0;
    const second = await findCrossConnections({ canvases, index: new SimilarityIndex(), apiKey: 'test', decider: makeDecider(true) });
    expect(second.map(item => item.id)).toEqual(first.map(item => item.id));
  });
});
