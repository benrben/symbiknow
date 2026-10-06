import { expect, it } from 'vitest';
import { choiceAnswer, expectedScore, noulAnswer, scoreAnswer, topScore } from './jev-answers.js';
import type { JevAnswer, ScoreAnswer } from './jev.js';

const score: ScoreAnswer = { type: 'score', score: 2, confidence: 0.7,
  probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } };
const flag: JevAnswer = { type: 'noul', noul: 0.4 };
const kind: JevAnswer = { type: 'choice', choice: 'guide', confidence: 0.8,
  probabilities: { guide: 0.9, plan: 0.1 } };

it('preserves expected normalization and the selected level for typed legacy partial probability maps', () => {
  const partial: ScoreAnswer = { type: 'score', score: 1, confidence: 0.6,
    probabilities: { 1: 0.4, 2: 0.6, 3: 0.8 }, legend: { 1: 'Some support' } };
  expect(expectedScore(partial, 3)).toBeCloseTo(0.8);
  expect(topScore(partial)).toBe(1);
  expect(scoreAnswer({ partial }, 'partial')).toBe(partial);
  expect(partial.probabilities).toEqual({ 1: 0.4, 2: 0.6, 3: 0.8 });
  expect(expectedScore({ ...partial, probabilities: {} }, 5)).toBe(0);
  expect(expectedScore({ ...partial, probabilities: { 0: 0.2, 10: 0.8 } }, 11)).toBe(0.8);
  expect(expectedScore({ ...partial, probabilities: { 0: 1 } }, 2)).toBe(0);
  expect(expectedScore({ ...partial, probabilities: { 1: 1 } }, 2)).toBe(1);
});

it.each([0, 1, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY])
  ('rejects the public invalid levels contract %s with the unchanged 502', levels => {
    expect(() => expectedScore(score, levels)).toThrow(expect.objectContaining({
      status: 502, message: 'Jev returned an invalid score',
    }));
  });

it.each([flag, kind])('rejects a known %s answer type in both public score projections', answer => {
  const failure = expect.objectContaining({ status: 502, message: 'Jev returned an invalid score' });
  expect(() => expectedScore(answer, 3)).toThrow(failure);
  expect(() => topScore(answer)).toThrow(failure);
});

it('returns literal choice, selected-score identity, and zero/one noul values from typed inputs', () => {
  expect(choiceAnswer({ kind }, 'kind', ['guide', 'plan'] as const)).toEqual({ value: 'guide', confidence: 0.8 });
  expect(scoreAnswer({ score }, 'score')).toBe(score);
  expect(topScore(score)).toBe(2);
  expect(expectedScore(score, 3)).toBeCloseTo(0.75);
  expect(noulAnswer({ flag }, 'flag')).toBe(0.4);
  expect(noulAnswer({ zero: { type: 'noul', noul: 0 } }, 'zero')).toBe(0);
  expect(noulAnswer({ one: { type: 'noul', noul: 1 } }, 'one')).toBe(1);
});

it('keeps all choice failure guards for missing, wrong-type, unoffered and non-finite typed values', () => {
  const candidates: Record<string, JevAnswer | undefined> = { missing: undefined, wrong: score,
    unoffered: { ...kind, choice: 'research' }, nonfinite: { ...kind, confidence: Number.NaN } };
  for (const id of Object.keys(candidates)) {
    expect(() => choiceAnswer(candidates, id, ['guide', 'plan'] as const)).toThrow(expect.objectContaining({
      status: 502, message: `Jev returned no valid choice for ${id}`,
    }));
  }
});

it('keeps all selected-score and noul guards for missing, known wrong type and non-finite typed values', () => {
  const scores: Record<string, JevAnswer | undefined> = { missing: undefined, wrong: kind,
    nonfinite: { ...score, score: Number.POSITIVE_INFINITY } };
  const nouls: Record<string, JevAnswer | undefined> = { missing: undefined, wrong: score,
    nonfinite: { type: 'noul', noul: Number.NaN } };
  for (const id of Object.keys(scores)) {
    expect(() => scoreAnswer(scores, id)).toThrow(expect.objectContaining({
      status: 502, message: `Jev returned no valid score for ${id}`,
    }));
    expect(() => noulAnswer(nouls, id)).toThrow(expect.objectContaining({
      status: 502, message: `Jev returned no valid noul for ${id}`,
    }));
  }
});
