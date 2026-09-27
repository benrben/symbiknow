import { describe, expect, it } from 'vitest';
import { choiceAnswer, expectedScore, noulAnswer, scoreAnswer, topScore } from './jev-answers.js';
import type { JevAnswer } from './jev.js';

describe('Jev score answers', () => {
  it('ranks by expected probability across five levels', () => {
    const answer = { type: 'score' as const, score: 2, confidence: 0.4,
      probabilities: { '0': 0.1, '1': 0.2, '2': 0.4, '3': 0.2, '4': 0.1 } };
    expect(expectedScore(answer, 5)).toBeCloseTo(0.5);
    expect(topScore(answer)).toBe(2);
  });

  it('normalizes three levels using their actual count', () => {
    expect(expectedScore({ type: 'score', score: 2, confidence: 0.6,
      probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 } }, 3)).toBeCloseTo(0.75);
  });
});

describe('shared typed accessors', () => {
  const answers: Record<string, JevAnswer | undefined> = {
    kind: { type: 'choice', choice: 'guide', probabilities: { guide: 0.9, plan: 0.1 }, confidence: 0.8 },
    value: { type: 'score', score: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.6 },
    flag: { type: 'noul', noul: 0.4 },
  };

  it('choiceAnswer returns the selected option and confidence when it is among the given options', () => {
    expect(choiceAnswer(answers, 'kind', ['guide', 'plan'])).toEqual({ value: 'guide', confidence: 0.8 });
  });

  it('choiceAnswer throws when the choice is missing, wrong type, or not among the current options', () => {
    expect(() => choiceAnswer(answers, 'missing', ['guide', 'plan'])).toThrow(/no valid choice for missing/);
    expect(() => choiceAnswer(answers, 'value', ['guide', 'plan'])).toThrow(/no valid choice for value/);
    expect(() => choiceAnswer(answers, 'kind', ['plan'])).toThrow(/no valid choice for kind/);
  });

  it('scoreAnswer returns the score answer, and throws when missing, wrong type, or non-finite', () => {
    expect(scoreAnswer(answers, 'value')).toEqual(answers.value);
    expect(() => scoreAnswer(answers, 'missing')).toThrow(/no valid score for missing/);
    expect(() => scoreAnswer(answers, 'kind')).toThrow(/no valid score for kind/);
    expect(() => scoreAnswer({ value: { type: 'score', score: Number.NaN, probabilities: {}, confidence: 1 } }, 'value')).toThrow(/no valid score/);
  });

  it('noulAnswer returns the probability, and throws when missing, wrong type, or non-finite', () => {
    expect(noulAnswer(answers, 'flag')).toBe(0.4);
    expect(() => noulAnswer(answers, 'missing')).toThrow(/no valid noul for missing/);
    expect(() => noulAnswer(answers, 'kind')).toThrow(/no valid noul for kind/);
    expect(() => noulAnswer({ flag: { type: 'noul', noul: Number.NaN } }, 'flag')).toThrow(/no valid noul/);
  });
});
