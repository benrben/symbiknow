import { expect, it } from 'vitest';
import type { SymbiIndexDocument } from '../shared/symbi-contract.js';
import { chunkDocument, normalizeVector, queryTokens, rankPassages, validateIndexDocument,
  type IndexedPassage } from './symbi-retrieval.js';

function passage(rowid: number, options: Partial<IndexedPassage> = {}): IndexedPassage {
  return { rowid, canvasId: 'allowed', blockId: `doc-${rowid}`, contentHash: `hash-${rowid}`,
    startOffset: 0, endOffset: 12, excerpt: 'Release recovery instructions', score: 0,
    title: `Runbook ${rowid}`, tags: [], group: '', purpose: '', links: [], vector: [1, 0], ...options };
}

it('covers every UTF-16 source offset across short, long, and tail-rebalanced documents', () => {
  expect(chunkDocument('')).toEqual([]);
  expect(chunkDocument('short')).toEqual([{ startOffset: 0, endOffset: 5, excerpt: 'short' }]);
  const content = `${'Release recovery notes. '.repeat(30)}Final 🧭 checkpoint`;
  const chunks = chunkDocument(content);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.map((chunk) => chunk.excerpt).join('')).toBe(content);
  expect(chunks.at(-1)?.endOffset).toBe(content.length);
  expect(chunks.some((chunk) => chunk.excerpt.includes('checkpoint'))).toBe(true);
  expect(chunks.every((chunk, index) => index === 0 || chunk.startOffset === chunks[index - 1].endOffset)).toBe(true);
  const noBoundary = chunkDocument('x'.repeat(221));
  expect(noBoundary.map((chunk) => chunk.excerpt.length)).toEqual([110, 111]);
  expect(chunkDocument('alpha beta gamma', 10).map((chunk) => chunk.excerpt).join('')).toBe('alpha beta gamma');
});

it('keeps normalization finite, bounds query terms, and rejects malformed source records', () => {
  expect(normalizeVector([3, 4])).toEqual([0.6, 0.8]);
  expect(normalizeVector([0, 0])).toEqual([0, 0]);
  expect(queryTokens('the and HOW')).toEqual([]);
  expect(queryTokens('')).toEqual([]);
  expect(queryTokens('Rollback rollback RELEASE')).toEqual(['rollback', 'release']);
  expect(queryTokens(Array.from({ length: 30 }, (_, index) => `term${index}`).join(' '))).toHaveLength(24);
  const valid: SymbiIndexDocument = { canvasId: 'allowed', blockId: 'doc', contentHash: 'hash',
    title: 'Valid', content: 'Source body' };
  expect(() => validateIndexDocument(valid)).not.toThrow();
  for (const invalid of [
    { ...valid, canvasId: '' }, { ...valid, blockId: '' }, { ...valid, contentHash: '' },
    { ...valid, content: null },
  ]) expect(() => validateIndexDocument(invalid as SymbiIndexDocument)).toThrow('Index document requires');
});

it('keeps explicit keyword matches while semantic evidence is absent or too weak', () => {
  const source = passage(1, { title: 'Rollback procedure', excerpt: 'Rollback procedure steps', vector: [0, 1] });
  const keywordRanks = new Map([[1, 0]]);
  const noModel = rankPassages({ passages: [source], query: 'rollback procedure', keywordRanks,
    limit: 5, mode: 'keyword' });
  expect(noModel[0]?.blockId).toBe('doc-1');
  const keywordWithVector = rankPassages({ passages: [source], query: 'rollback procedure', queryVector: [1, 0],
    keywordRanks, limit: 5, mode: 'keyword' });
  expect(keywordWithVector).toEqual(noModel);
  const weakSemantic = rankPassages({ passages: [source], query: 'rollback procedure', queryVector: [1, 0],
    keywordRanks, limit: 5, mode: 'hybrid' });
  expect(weakSemantic[0]?.blockId).toBe('doc-1');
  const noWords = passage(2, { title: '', excerpt: '?!', vector: [0, 1] });
  expect(rankPassages({ passages: [noWords], query: 'rollback procedure', queryVector: [1, 0],
    keywordRanks: new Map([[2, 0]]), limit: 5, mode: 'hybrid' })).toEqual([]);
  const emptyQuery = rankPassages({ passages: [passage(3)], query: '', queryVector: [1, 0],
    keywordRanks: new Map(), limit: 5, mode: 'semantic' });
  expect(emptyQuery).toEqual([]);
  expect(rankPassages({ passages: [passage(3)], query: 'the and', queryVector: [1, 0],
    keywordRanks: new Map(), limit: 5, mode: 'semantic' })).toEqual([]);
});

it('requires substantive evidence and never synthesizes a linked or forbidden document', () => {
  const relevant = passage(1, { title: 'Rollback procedure', links: ['forbidden-id'] });
  const incidental = passage(2, { title: 'Meeting notes', excerpt: 'Status was discussed', vector: [0.1, 0.995] });
  const ranked = rankPassages({ passages: [relevant, incidental], query: 'rollback procedure',
    queryVector: [1, 0], keywordRanks: new Map([[1, 0], [2, 1]]), limit: 8 });
  expect(ranked.map((item) => item.blockId)).toEqual(['doc-1']);
  expect(ranked[0]).toMatchObject({ canvasId: 'allowed', contentHash: 'hash-1', excerpt: relevant.excerpt });
  expect(ranked.every((item) => item.blockId !== 'forbidden-id')).toBe(true);
  const unrelated = rankPassages({ passages: [incidental], query: 'restaurant tax invoice retention rules',
    queryVector: [1, 0], keywordRanks: new Map([[2, 0]]), limit: 8 });
  expect(unrelated).toEqual([]);
  const wrongDimension = rankPassages({ passages: [passage(3, { vector: [1, 0, 0] })], query: 'paraphrase',
    queryVector: [1, 0], keywordRanks: new Map(), limit: 8, mode: 'semantic' });
  expect(wrongDimension).toEqual([]);
});

it('uses metadata and graph support while bounding passages per document and total excerpt bytes', () => {
  const linked = passage(1, { title: 'Release checklist', tags: ['release'], links: ['doc-2'] });
  const target = passage(2, { title: 'Recovery procedure', group: 'Operations', purpose: 'Release recovery' });
  const graph = rankPassages({ passages: [linked, target], query: 'release recovery', queryVector: [1, 0],
    keywordRanks: new Map([[1, 0], [2, 1]]), limit: 8, mode: 'hybrid' });
  expect(graph).toHaveLength(2);
  expect(graph.every((item) => (item.score ?? 0) > 0)).toBe(true);
  const sameDocument = Array.from({ length: 5 }, (_, index) => passage(index + 10,
    { blockId: 'one-long-document', startOffset: index * 200, vector: [1, 0] }));
  expect(rankPassages({ passages: sameDocument, query: 'recovery', queryVector: [1, 0],
    keywordRanks: new Map(), limit: 10, mode: 'semantic' })).toHaveLength(3);
  const many = Array.from({ length: 40 }, (_, index) => passage(index + 100,
    { excerpt: 'x'.repeat(600), endOffset: 600 }));
  const bounded = rankPassages({ passages: many, query: 'any paraphrase', queryVector: [1, 0],
    keywordRanks: new Map(), limit: 40, mode: 'semantic' });
  expect(bounded).toHaveLength(33);
  expect(bounded.reduce((sum, item) => sum + item.excerpt.length, 0)).toBeLessThanOrEqual(20_000);
  expect(rankPassages({ passages: many, query: 'anything', queryVector: [1, 0],
    keywordRanks: new Map(), limit: 2, mode: 'semantic' })).toHaveLength(2);
});

it('orders tied evidence deterministically by canvas, document, then source offset', () => {
  const tied = [
    passage(4, { canvasId: 'z', blockId: 'b', startOffset: 0, title: '', excerpt: '' }),
    passage(3, { canvasId: 'a', blockId: 'b', startOffset: 10, title: '', excerpt: '' }),
    passage(2, { canvasId: 'a', blockId: 'b', startOffset: 0, title: '', excerpt: '' }),
    passage(1, { canvasId: 'a', blockId: 'a', startOffset: 0, title: '', excerpt: '' }),
  ];
  const ranked = rankPassages({ passages: tied, query: 'paraphrase', queryVector: [1, 0],
    keywordRanks: new Map(), limit: 8, mode: 'semantic' });
  expect(ranked.map((item) => `${item.canvasId}:${item.blockId}:${item.startOffset}`)).toEqual([
    'a:a:0', 'a:b:0', 'a:b:10', 'z:b:0',
  ]);
  const lexicalTies = tied.map((item) => ({ ...item, excerpt: 'paraphrase' }));
  const keywordRanks = new Map(lexicalTies.map((item) => [item.rowid, 0]));
  const lexical = rankPassages({ passages: lexicalTies, query: 'paraphrase', keywordRanks,
    limit: 8, mode: 'keyword' });
  expect(lexical.map((item) => `${item.canvasId}:${item.blockId}:${item.startOffset}`)).toEqual([
    'a:a:0', 'a:b:0', 'a:b:10', 'z:b:0',
  ]);
});
