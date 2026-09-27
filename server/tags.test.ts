import { describe, expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import { SimilarityIndex } from './similarity.js';
import { findTagSuggestions, tagVocabulary } from './tags.js';
import type { JevDecider } from './jev.js';

function block(id: string, title: string, content: string, tags: string[] = []): CanvasBlock {
  return { id, title, content, tags, contentHash: id, file: `docs/${id}.md`, kind: 'markdown',
    x: 0, y: 0, width: 400, height: 320, links: [] };
}

describe('tag suggestions', () => {
  it('limits the vocabulary to forty unique tags, preferring saved canvas tags', () => {
    const saved = [block('a', 'A', 'Text', ['Billing', 'Operations'])];
    const custom = ['billing', ...Array.from({ length: 50 }, (_, index) => `Custom ${index}`)].join(',');
    const tags = tagVocabulary(saved, custom);
    expect(tags).toHaveLength(40);
    expect(tags.slice(0, 3)).toEqual(['Billing', 'Operations', 'Custom 0']);
    expect(tags).not.toContain('billing');
  });

  it('uses a neighbor tag even when that word does not occur in the target document, quoting it without a title', async () => {
    const blocks = [
      block('source', 'Gateway guide', 'Configure durable queue delivery and inspect retry headers.', ['incident']),
      block('target', 'Queue guide', 'Configure durable queue delivery and inspect retry headers.'),
    ];
    const before = structuredClone(blocks);
    const decider: JevDecider = vi.fn(async (_key, state, questions) => {
      const document = (state as { document: { title: string; candidates?: string[] } }).document;
      expect(document.title).toBe('Queue guide');
      const instructions = questions.d1_tag_0.instructions;
      expect(instructions).toContain('`incident`');
      expect(instructions).not.toContain('Queue guide');
      expect(instructions).toContain('`state.document`');
      expect(Object.keys(questions)).toEqual(['d1_tag_0']);
      return { d1_tag_0: { type: 'noul' as const, noul: 0.91 } };
    });
    const items = await findTagSuggestions({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test', decider });
    expect(items).toMatchObject([{ category: 'tag', blockIds: ['target'], confidence: 0.91,
      action: { type: 'update', blockId: 'target', patch: { tags: ['incident'] } } }]);
    expect(items[0].evidence?.[0].questionId).toBe('d1_tag_0');
    expect(blocks).toEqual(before);
  });

  it('sends one Jev request per document', async () => {
    const blocks = [
      block('a', 'Gateway guide', 'Billing rate limits and retries.'),
      block('b', 'Queue guide', 'Billing rate limits and retries.'),
    ];
    const requests: string[][] = [];
    const decider: JevDecider = async (_key, _state, questions) => {
      requests.push(Object.keys(questions));
      return Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul' as const, noul: 0.1 }]));
    };
    await findTagSuggestions({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test', decider, vocabulary: 'billing' });
    expect(requests).toHaveLength(2);
    expect(requests.every(ids => ids.every(id => id.startsWith(`d${requests.indexOf(ids)}_`)))).toBe(true);
  });

  it('combines high-confidence tags into one preserving update and leaves medium suggestions review-only', async () => {
    const blocks = [block('client', 'Billing API client', 'The billing API client reads rate limits after a failed request.')];
    const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.keys(questions).map(id => [id,
      { type: 'noul', noul: id.endsWith('_0') ? 0.9 : id.endsWith('_1') ? 0.93 : 0.72 }]));
    const items = await findTagSuggestions({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test', decider,
      vocabulary: 'billing, API, rate limits, security' });
    expect(items).toHaveLength(2);
    expect(items[0].action).toEqual({ type: 'update', blockId: 'client', patch: { tags: ['billing', 'API'] } });
    expect(items[0].evidence).toHaveLength(2);
    expect(items[1]).toMatchObject({ category: 'tag', confidence: 0.72 });
    expect(items[1].action).toBeUndefined();
  });

  it('asks at most six tag questions per document and skips unsupported tags', async () => {
    const content = Array.from({ length: 12 }, (_, index) => `topic${index}`).join(' ');
    const blocks = [block('a', 'Topics', content)];
    let questionCount = 0;
    const decider: JevDecider = async (_key, _state, questions) => {
      questionCount += Object.keys(questions).length;
      return Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.1 }]));
    };
    const items = await findTagSuggestions({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test', decider,
      vocabulary: `${Array.from({ length: 12 }, (_, index) => `topic${index}`).join(',')}, unrelated` });
    expect(questionCount).toBe(6);
    expect(items).toEqual([]);
    const unused = vi.fn(decider);
    await findTagSuggestions({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test', decider: unused,
      vocabulary: 'security, legal' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('judges documents with bounded concurrency while keeping deterministic output order', async () => {
    const blocks = Array.from({ length: 8 }, (_, index) => block(`doc-${index}`, `Guide ${index}`, `Billing rate limits topic${index}.`));
    let inFlight = 0;
    let maxInFlight = 0;
    let callIndex = 0;
    const makeDecider = (reverseDelay: boolean): JevDecider => async (_key, _state, questions) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const order = callIndex++;
      await new Promise(resolve => setTimeout(resolve, reverseDelay ? (20 - order) : order));
      inFlight--;
      return Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul' as const, noul: 0.9 }]));
    };
    const first = await findTagSuggestions({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test',
      decider: makeDecider(false), vocabulary: 'billing, rate limits' });
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    callIndex = 0;
    const second = await findTagSuggestions({ canvasId: 'canvas', blocks, index: new SimilarityIndex(), apiKey: 'test',
      decider: makeDecider(true), vocabulary: 'billing, rate limits' });
    expect(second.map(item => item.id)).toEqual(first.map(item => item.id));
  });
});
