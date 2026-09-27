import { describe, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import type { InsightItem } from '../shared/insights.js';
import type { JevAnswer } from './jev.js';
import { canvasHealth, qualityInsight, qualityQuestions, scoreDocumentQuality } from './quality.js';

const score = (level: number): JevAnswer => ({ type: 'score', score: level, confidence: 1, probabilities: { [level]: 1 } });
const block = (id: string, patch: Partial<CanvasBlock> = {}): CanvasBlock => ({
  id, title: id, file: `${id}.md`, kind: 'markdown', content: `# ${id}`, x: 0, y: 0, width: 400, height: 300, links: [], ...patch,
});
const item = (category: InsightItem['category'], blockIds: string[]): InsightItem => ({
  id: `${category}-${blockIds.join('-')}`, category, title: category, detail: '', blockIds, confidence: 1,
});

describe('document quality', () => {
  it('asks the shared dimensions and purpose-specific ones', () => {
    expect(Object.keys(qualityQuestions(2, 'overview'))).toEqual(['d2_q_clarity', 'd2_q_complete', 'd2_q_scope']);
    expect(Object.keys(qualityQuestions(2, 'runbook'))).toContain('d2_q_actionable');
    expect(Object.keys(qualityQuestions(2, 'research'))).toContain('d2_q_evidence');
    expect(Object.keys(qualityQuestions(2, 'research'))).not.toContain('d2_q_actionable');
    expect(Object.values(qualityQuestions(2, 'plan')).every(question => question.type === 'score' && question.criteria.length === 5)).toBe(true);
  });

  it('refers to state with a backticked path, marks content as data, and accepts a custom ref', () => {
    const defaultRef = qualityQuestions(2, 'overview').d2_q_clarity;
    if (defaultRef.type !== 'score') throw new Error('Expected a score question');
    expect(defaultRef.instructions).toContain('`state.documents[2]`');
    expect(defaultRef.instructions.toLowerCase()).toContain('not instructions');

    const customRef = qualityQuestions(2, 'overview', 'state.pairs[1].first').d2_q_clarity;
    if (customRef.type !== 'score') throw new Error('Expected a score question');
    expect(customRef.instructions).toContain('`state.pairs[1].first`');
  });

  it('normalizes weights and uses expected probabilities', () => {
    const answers: Record<string, JevAnswer> = {
      d0_q_clarity: { type: 'score', score: 4, confidence: 1, probabilities: { '0': 0.5, '4': 0.5 } },
      d0_q_complete: score(0),
      d0_q_scope: score(0),
    };
    const quality = scoreDocumentQuality(0, 'overview', answers);
    expect(quality?.dimensions).toEqual({ clarity: 0.5, complete: 0, scope: 0 });
    expect(quality?.score).toBeCloseTo((0.25 * 0.5) / 0.65);
    expect(quality?.weakest).toBe('complete');
    expect(qualityInsight(block('a'), quality!)).toMatchObject({ category: 'quality', blockIds: ['a'] });
    expect(qualityInsight(block('a'), quality!)?.detail).toContain('completeness');
  });

  it('skips a quality card at or above 0.4 and requires all requested answers', () => {
    const answers = { d1_q_clarity: score(4), d1_q_complete: score(4), d1_q_scope: score(4) };
    const quality = scoreDocumentQuality(1, 'overview', answers)!;
    expect(quality.score).toBe(1);
    expect(qualityInsight(block('a'), quality)).toBeUndefined();
    expect(scoreDocumentQuality(1, 'overview', {})).toBeUndefined();
    expect(() => scoreDocumentQuality(1, 'overview', { d1_q_clarity: score(4) })).toThrow();
  });

  it('weights actionable and evidence only for their matching purposes', () => {
    const shared = { d3_q_clarity: score(4), d3_q_complete: score(4), d3_q_scope: score(4) };
    expect(scoreDocumentQuality(3, 'runbook', { ...shared, d3_q_actionable: score(0) })?.score)
      .toBeCloseTo(0.65 / 0.85);
    expect(scoreDocumentQuality(3, 'research', { ...shared, d3_q_evidence: score(0) })?.score)
      .toBeCloseTo(0.65 / 0.8);
  });
});

describe('canvas health', () => {
  it('counts incoming and outgoing links, unique flagged docs, and current quality', () => {
    const blocks = [
      block('a', { links: ['b'], purpose: 'guide', quality: { score: 0.3, at: '2026-09-25' } }),
      block('b', { workArea: 'engineering', quality: { score: 0.9, at: '2026-09-25' } }),
      block('c', { tags: ['notes'] }),
      block('d', { archived: true }),
    ];
    expect(canvasHealth(blocks, [item('duplicate', ['a', 'b']), item('duplicate', ['a', 'c']), item('stale', ['b'])])).toEqual({
      orphanRatio: 1 / 3, duplicateRatio: 1, staleRatio: 1 / 3, meanQuality: 0.6, labelCoverage: 1,
    });
    expect(canvasHealth(blocks, [], { a: 0.8 }).meanQuality).toBeCloseTo(0.85);
  });

  it('returns empty ratios and unknown quality for an empty canvas', () => {
    expect(canvasHealth([], [])).toEqual({ orphanRatio: 0, duplicateRatio: 0, staleRatio: 0, meanQuality: null, labelCoverage: 0 });
  });
});
