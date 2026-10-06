import { describe, expect, it } from 'vitest';
import type { ChoiceAnswer } from '../../jev.js';
import { selected, selectedEvidence } from './context.js';

describe('Exact evidence selection with multiple relevant passages', () => {
  it('retains a leading quote when probability is split between two valid source passages', () => {
    const answer: ChoiceAnswer = { type: 'choice', choice: 'p0', confidence: 0.44,
      probabilities: { p0: 0.50, p2: 0.44, p1: 0.06, none: 0, unknown: 0 } };
    expect(selected(answer)).toBeUndefined();
    expect(selectedEvidence(answer)).toBe('p0');
  });
  it('retains explicit abstention and requires a typed passage choice', () => {
    expect(selectedEvidence(undefined)).toBeUndefined();
    expect(selectedEvidence({ type: 'noul', noul: 1 })).toBeUndefined();
    for (const choice of ['none', 'unknown']) {
      expect(selectedEvidence({ type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } })).toBeUndefined();
    }
  });
});
