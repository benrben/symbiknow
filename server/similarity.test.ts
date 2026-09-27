import { describe, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import { getSimilarityIndex, shingleOverlap, SimilarityIndex, tokenize } from './similarity.js';

function block(id: string, title: string, content: string, contentHash = id): CanvasBlock {
  return { id, title, content, contentHash, file: `docs/${id}.md`, kind: 'markdown',
    x: 0, y: 0, width: 400, height: 320, links: [] };
}

describe('Unicode similarity index', () => {
  it('tokenizes Hebrew and other scripts without falling back to Latin-only matches', () => {
    expect(tokenize('המסמך כולל הוראות התקנה ושימוש במערכת.')).toEqual(['המסמך', 'כולל', 'הוראות', 'התקנה', 'ושימוש', 'במערכת']);
    expect(tokenize('The QUICK setup and מדריך מפורט')).toEqual(['quick', 'setup', 'מדריך', 'מפורט']);
  });

  it('finds Hebrew documents with a shared paragraph as neighbors', () => {
    const index = new SimilarityIndex();
    const shared = 'המערכת שומרת את כל המסמכים בתיקייה משותפת ומאפשרת חיפוש לפי נושא ושם המחבר.';
    index.syncCanvas('one', [
      block('a', 'מדריך התקנה', `${shared} יש להגדיר את השרת לפני ההפעלה.`),
      block('b', 'תיעוד החיפוש', `${shared} אפשר לסנן את התוצאות לפי תאריך.`),
      block('c', 'תכנון אחר', 'הצוות בוחן מדדים כספיים עבור התוכנית החדשה.'),
    ]);
    expect(index.neighbors('a', 2)).toMatchObject([{ blockId: 'b', canvasId: 'one' }]);
    expect(index.neighbors('a', 2)[0].score).toBeGreaterThan(0.3);
  });

  it('ranks shared body text above a shared title alone', () => {
    const index = new SimilarityIndex();
    const section = 'Configure the gateway endpoint, rotate service credentials, validate webhook signatures, and inspect retry headers after deployment.';
    index.syncCanvas('one', [
      block('source', 'Integration Guide', `${section} Monitor delivery failures in the operations dashboard.`),
      block('title-only', 'Integration Guide', 'The budget forecast covers quarterly revenue, staffing allocations, and travel expenses.'),
      block('body-match', 'Webhook Operations', `${section} Record rejected requests for support review.`),
    ]);
    expect(index.neighbors('source', 2).map(neighbor => neighbor.blockId)).toEqual(['body-match', 'title-only']);
  });

  it('reindexes changed content hashes and titles, and removes deleted blocks', () => {
    const index = new SimilarityIndex();
    const source = block('a', 'Source', 'Distributed queues coordinate durable event delivery.', 'hash-1');
    const peer = block('b', 'Other', 'Distributed queues coordinate durable event delivery.', 'hash-2');
    index.syncCanvas('one', [source, peer]);
    expect(index.neighbors('a', 1)[0].blockId).toBe('b');
    expect(index.upsert('one', source)).toBe(false);
    expect(index.upsert('one', { ...peer, content: 'Unrelated culinary recipes describe roasted vegetables.', contentHash: 'hash-3' })).toBe(true);
    expect(index.neighbors('a', 1)).toEqual([]);
    expect(index.upsert('one', { ...peer, title: 'Source', content: 'Unrelated culinary recipes describe roasted vegetables.', contentHash: 'hash-3' })).toBe(true);
    expect(index.neighbors('a', 1)[0].blockId).toBe('b');
    index.syncCanvas('one', [source]);
    expect(index.neighbors('a', 1)).toEqual([]);
  });

  it('scopes neighbors by canvas and keeps indexes separate by workspace', () => {
    const first = getSimilarityIndex('similarity-test-workspace-one');
    const second = getSimilarityIndex('similarity-test-workspace-two');
    first.syncCanvas('canvas-a', [block('a', 'Queue', 'Durable messaging and event delivery.')]);
    first.syncCanvas('canvas-b', [block('b', 'Queue', 'Durable messaging and event delivery.')]);
    second.syncCanvas('canvas-c', [block('c', 'Queue', 'Durable messaging and event delivery.')]);
    expect(first.neighbors('a', 1)).toEqual([]);
    expect(first.neighbors('a', 1, { sameCanvas: false, crossCanvas: true })).toMatchObject([{ blockId: 'b', canvasId: 'canvas-b' }]);
    expect(first.neighbors('a', 2, { sameCanvas: true, crossCanvas: true })).toHaveLength(1);
    expect(second.neighbors('a', 1, { sameCanvas: true, crossCanvas: true })).toEqual([]);
  });

  it('uses Jaccard overlap of five-word body shingles', () => {
    const first = '# One\nalpha bravo charlie delta echo foxtrot golf';
    const second = '# Two\nalpha bravo charlie delta echo hotel india';
    expect(shingleOverlap(first, second)).toBeGreaterThan(0);
    expect(shingleOverlap(first, first)).toBe(1);
    expect(shingleOverlap('alpha bravo charlie', first)).toBe(0);
    const index = new SimilarityIndex();
    index.syncCanvas('one', [block('a', 'One', first), block('b', 'Two', second)]);
    expect(index.shingleOverlap('a', 'b')).toBe(shingleOverlap(first, second));
  });
});
