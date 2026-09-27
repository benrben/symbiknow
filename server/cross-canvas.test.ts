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

  it('asks Jev about related documents when their wording has no lexical overlap', async () => {
    const first = canvas('canvas-a', 'Service reliability', [block('retry-plan', 'Throttle recovery',
      'Delay retries after overload responses.')]);
    const second = canvas('canvas-b', 'Release operations', [block('limit-rule', 'Rate limit policy',
      'Pause requests when throttling occurs.')]);
    const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) =>
      [id, answer(question, id.startsWith('c') || id.endsWith('_strength') ? 4 : id.endsWith('_relation') ? 'same_topic' : 'a_to_b')]));
    const index = new SimilarityIndex();
    const items = await findCrossConnections({ canvases: [first, second], index, apiKey: 'test', decider });
    expect(index.neighbors('retry-plan', 3, { sameCanvas: false, crossCanvas: true })).toEqual([]);
    expect(items[0]?.action).toMatchObject({ type: 'cross_link', fromBlockId: 'retry-plan',
      to: { canvasId: 'canvas-b', blockId: 'limit-rule' } });
  });

  it('uses Jev to shortlist semantic matches on larger canvases', async () => {
    const first = canvas('canvas-a', 'Operations', [
      block('a0', 'Throttle recovery', 'Delay retries after overload responses.'),
      block('a1', 'Incident duty', 'Escalation rota for outages.'),
      block('a2', 'Service budget', 'Quarterly spending plan.'),
      block('a3', 'Launch note', 'Release announcement draft.'),
    ]);
    const second = canvas('canvas-b', 'Policies', [
      block('b0', 'Hiring policy', 'Interview process for candidates.'),
      block('b1', 'Travel policy', 'Approval process for trips.'),
      block('b2', 'Archive policy', 'Keep old records for audits.'),
      block('b3', 'Rate limit policy', 'Pause requests when throttling occurs.'),
    ]);
    const calls: string[] = [];
    const decider: JevDecider = async (_key, state, questions) => {
      const questionIds = Object.keys(questions);
      calls.push(questionIds[0]);
      const summaries = state as { sources?: Array<{ title: string }>; targets?: Array<{ title: string }> };
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        const source = summaries.sources?.[Number(id.slice(1))];
        const targetIndex = summaries.targets?.findIndex(target => target.title === 'Rate limit policy') ?? -1;
        const selected = source?.title === 'Throttle recovery' && targetIndex >= 0 ? `t${targetIndex}` : 'none';
        return [id, answer(question, id.startsWith('c') || id.endsWith('_strength') ? 4
          : id.endsWith('_relation') ? 'same_topic' : id.endsWith('_direction') ? 'a_to_b' : selected)];
      }));
    };
    const index = new SimilarityIndex();
    const items = await findCrossConnections({ canvases: [first, second], index, apiKey: 'test', decider });
    expect(index.neighbors('a0', 3, { sameCanvas: false, crossCanvas: true })).toEqual([]);
    expect(calls).toContain('s0');
    expect(items.some(item => item.action?.type === 'cross_link' && item.action.fromBlockId === 'a0'
      && item.action.to.blockId === 'b3')).toBe(true);
  });

  it('checks the last document on a small related canvas even when one source has many targets', async () => {
    const first = canvas('canvas-a', 'Reliability', [block('a', 'Throttle recovery', 'Delay retries after overload responses.')]);
    const second = canvas('canvas-b', 'Policies', Array.from({ length: 9 }, (_, index) =>
      block(`b${index}`, index === 8 ? 'Rate limit policy' : `Policy ${index}`,
        index === 8 ? 'Pause requests when throttling occurs.' : `Rule number ${index} for staff.`)));
    const decider: JevDecider = async (_key, state, questions) => {
      const targetTitle = (state as { b?: { title: string } }).b?.title;
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question,
        id.startsWith('c') ? 4 : id.endsWith('_strength') ? targetTitle === 'Rate limit policy' ? 4 : 0
          : id.endsWith('_relation') ? 'same_topic' : 'a_to_b')]));
    };
    const items = await findCrossConnections({ canvases: [first, second], index: new SimilarityIndex(), apiKey: 'test', decider });
    expect(items).toHaveLength(1);
    expect(items[0].action).toMatchObject({ type: 'cross_link', fromBlockId: 'a',
      to: { canvasId: 'canvas-b', blockId: 'b8' } });
  });

  it('keeps the strongest Jev shortlist choice across target batches', async () => {
    const first = canvas('canvas-a', 'Reliability', [block('a', 'Throttle recovery', 'Delay retries after overload responses.')]);
    const second = canvas('canvas-b', 'Policies', Array.from({ length: 31 }, (_, index) =>
      block(`b${index}`, `Rule ${index}`, `Staff instruction ${index}.`)));
    const judged: string[] = [];
    const decider: JevDecider = async (_key, state, questions) => {
      const data = state as { sourceCanvas?: string; targets?: Array<{ title: string }>; b?: { title: string } };
      if (data.b) judged.push(data.b.title);
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        if (id.startsWith('s')) {
          const finalBatch = data.targets?.some(target => target.title === 'Rule 30');
          return [id, answer(question, data.sourceCanvas === 'Reliability' ? 't0' : 'none', finalBatch ? 0.95 : 0.6)];
        }
        return [id, answer(question, id.startsWith('c') || id.endsWith('_strength') ? 4
          : id.endsWith('_relation') ? 'same_topic' : 'a_to_b')];
      }));
    };
    const items = await findCrossConnections({ canvases: [first, second], index: new SimilarityIndex(), apiKey: 'test', decider });
    expect(judged).toEqual(['Rule 30']);
    expect(items[0].action).toMatchObject({ type: 'cross_link', to: { blockId: 'b30' } });
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
