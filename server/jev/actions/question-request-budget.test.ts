import { expect, it } from 'vitest';
import { choice, estimateJevTokens, JEV_STATE_TOKEN_LIMIT, noul, score, type JevQuestion } from '../../jev.js';
import { questionRequestFits } from './question-request-budget.js';

function stateWithTokens(tokens: number): string { return 'x'.repeat(tokens * 3 - 2); }
const questions = { supported: noul('Check only the exact supplied source evidence.') };
const longest = (submitted: Record<string, JevQuestion>) => Math.max(0, ...Object.values(submitted).map(estimateJevTokens));

it('preserves the exact ordinary16000-token state-plus-all-questions limit', () => {
  const available = 16000 - estimateJevTokens(questions);
  expect(estimateJevTokens(stateWithTokens(available))).toBe(available);
  expect(questionRequestFits(stateWithTokens(available), questions, false)).toBe(true);
  expect(questionRequestFits(stateWithTokens(available + 1), questions, false)).toBe(false);
});
it('matches the exact shared SDK state-plus-longest32000-token limit', () => {
  const available = JEV_STATE_TOKEN_LIMIT - longest(questions);
  expect(questionRequestFits(stateWithTokens(available), questions, true)).toBe(true);
  expect(questionRequestFits(stateWithTokens(available + 1), questions, true)).toBe(false);
});
it.each([0, 200])('also caps shared state-plus-ALL questions at64000 tokens with the exact reserve%s', reserve => {
  const submitted = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [`q${index}`, noul(`Exact claim ${index}: ${'e'.repeat(1500)}`)]));
  const before = structuredClone(submitted);
  const available = 64000 - estimateJevTokens(submitted) - reserve;
  expect(available).toBeGreaterThan(0);
  expect(available + longest(submitted) + reserve).toBeLessThan(JEV_STATE_TOKEN_LIMIT);
  expect(questionRequestFits(stateWithTokens(available), submitted, true, reserve)).toBe(true);
  expect(questionRequestFits(stateWithTokens(available + 1), submitted, true, reserve)).toBe(false);
  expect(questionRequestFits(stateWithTokens(available + 1), submitted, true)).toBe(reserve > 0);
  expect(submitted).toEqual(before);
});
it.each([false, true])('reserves exactly200 tokens for the decision annotation (shared=%s)', shared => {
  const limit = shared ? JEV_STATE_TOKEN_LIMIT : 16000;
  const questionTokens = shared ? longest(questions) : estimateJevTokens(questions);
  const available = limit - questionTokens - 200;
  expect(questionRequestFits(stateWithTokens(available), questions, shared, 200)).toBe(true);
  expect(questionRequestFits(stateWithTokens(available + 1), questions, shared, 200)).toBe(false);
  expect(questionRequestFits(stateWithTokens(available + 1), questions, shared)).toBe(true);
  expect(questionRequestFits(stateWithTokens(available + 200), questions, shared, 0)).toBe(true);
  expect(questionRequestFits(stateWithTokens(available + 201), questions, shared, 0)).toBe(false);
});
const typedLongest: Record<string, JevQuestion> = {
  noul: noul('Check the exact source. '.repeat(100)),
  choice: choice('Choose the checked category.', { first: 'Meaning with exact boundaries. '.repeat(100), second: 'Other meaning.' }),
  score: score('Use the explicit supplied levels.', ['Exact evidence for this level. '.repeat(100), 'Other level.']),
};
it.each(Object.entries(typedLongest))('finds the longest %s typed question regardless of its order or criteria representation', (_kind, long) => {
  const other = { first: noul('Check source.'), second: choice('Choose source.', { yes: 'Yes', no: 'No' }),
    third: score('Assess source.', ['Unsupported', 'Supported']) };
  const before = structuredClone({ other, long }); const available = JEV_STATE_TOKEN_LIMIT - estimateJevTokens(long);
  for (const submitted of [{ long, ...other }, { ...other, long }]) {
    expect(questionRequestFits(stateWithTokens(available), submitted, true)).toBe(true);
    expect(questionRequestFits(stateWithTokens(available + 1), submitted, true)).toBe(false);
  }
  expect({ other, long }).toEqual(before);
});
it('shares many independent questions under the SDK contract while preserving the ordinary aggregate budget', () => {
  const submitted = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`question${index}`, noul(
    `Check claim ${index}. ${'Use only exact checked source evidence. '.repeat(30)}`)]));
  expect(estimateJevTokens({}) + estimateJevTokens(submitted)).toBeGreaterThan(16000);
  expect(questionRequestFits({}, submitted, true)).toBe(true);
  expect(questionRequestFits({}, submitted, false)).toBe(false);
});
it('uses zero longest-question tokens for an empty shared bundle but preserves ordinary JSON question overhead', () => {
  expect(questionRequestFits(stateWithTokens(JEV_STATE_TOKEN_LIMIT), {}, true)).toBe(true);
  expect(questionRequestFits(stateWithTokens(JEV_STATE_TOKEN_LIMIT + 1), {}, true)).toBe(false);
  expect(questionRequestFits(stateWithTokens(16000 - estimateJevTokens({})), {}, false)).toBe(true);
  expect(questionRequestFits(stateWithTokens(16000), {}, false)).toBe(false);
});
it('keeps the SDK’s conservative UTF8 estimation for non-English shared source state', () => {
  const state = { source: 'ראיות מקור מדויקות '.repeat(2000) }; const total = estimateJevTokens(state) + longest(questions);
  expect(questionRequestFits(state, questions, true)).toBe(total <= JEV_STATE_TOKEN_LIMIT);
  expect(questionRequestFits(state, questions, true, JEV_STATE_TOKEN_LIMIT - total)).toBe(true);
  expect(questionRequestFits(state, questions, true, JEV_STATE_TOKEN_LIMIT - total + 1)).toBe(false);
});
