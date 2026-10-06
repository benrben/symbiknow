import { expect, it } from 'vitest';
import { choice, noul, score, type JevQuestion } from '../../jev.js';
import { compileSharedQuestionTexts } from './question-text-pool.js';

const repeated = 'Exact question instructions and descriptions retain every character. '.repeat(4);
function restore(value: string, texts: string[]) {
  return value.replace(/\$jevQuestionText:(\d+)/g, (_, index) => texts[Number(index)]);
}
function restored(question: JevQuestion, texts: string[]): JevQuestion {
  const instructions = restore(question.instructions, texts);
  if (question.type === 'score') return { ...question, instructions, criteria: question.criteria.map(value => restore(value, texts)) };
  if (!question.criteria) return { ...question, instructions };
  return { ...question, instructions, criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, restore(value, texts)])) };
}
it('shares only repeated exact long question text while preserving typed choices, levels and yes/no descriptions', () => {
  const original = { a: choice(repeated, { a: repeated, b: 'Different choice', none: 'None' }),
    b: score(repeated, ['First', repeated, 'Last']), c: noul(repeated, { true: repeated, false: 'No' }),
    d: noul('Unshared instruction'), e: noul('Unique', {}) };
  const before = structuredClone(original); const compiled = compileSharedQuestionTexts(original);
  expect(compiled.questionTexts).toEqual([repeated]);
  expect(compiled.questions.a).toEqual(choice('$jevQuestionText:0', { a: '$jevQuestionText:0', b: 'Different choice', none: 'None' }));
  expect(Object.fromEntries(Object.entries(compiled.questions).map(([id, question]) => [id, restored(question, compiled.questionTexts)]))).toEqual(original);
  expect(original).toEqual(before); expect(compiled.questions.a).not.toBe(original.a);
});
it('does not normalize whitespace, case, short text or unique descriptions', () => {
  const original = { a: choice(repeated, { a: repeated, b: repeated.toUpperCase(), c: 'Short' }),
    b: noul('Short'), c: noul(`${repeated} `) };
  const compiled = compileSharedQuestionTexts(original);
  expect(compiled.questionTexts).toEqual([repeated]);
  expect(compiled.questions.b.instructions).toBe('Short');
  expect(compiled.questions.c.instructions).toBe(`${repeated} `);
  expect((compiled.questions.a as { criteria: Record<string, string> }).criteria.b).toBe(repeated.toUpperCase());
});
it('owns arrays and candidate records and never reinterprets original marker text', () => {
  const marker = 'The original text literally says $jevQuestionText:97.';
  const original = { a: noul(marker), b: score('Unique levels', [marker, 'Other']), c: choice('Unique candidates', { a: marker }) };
  const compiled = compileSharedQuestionTexts(original);
  expect(compiled.questionTexts).toEqual([marker]);
  for (const [id, question] of Object.entries(compiled.questions)) expect(restored(question, compiled.questionTexts)).toEqual(original[id as keyof typeof original]);
  (compiled.questions.b as unknown as { criteria: string[] }).criteria.push('Caller edit');
  expect(original.b.criteria).toEqual([marker, 'Other']);
  expect(compileSharedQuestionTexts({})).toEqual({ questionTexts: [], questions: {} });
});
