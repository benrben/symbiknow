import { expect, it } from 'vitest';
import { noul, type JevAnswer } from '../../jev.js';
import { isQuestionSetCollector, questionSetCollector, type JevQuestionSet } from './question-set-collector.js';

const questions = { support: noul('Does this exact source support its claim?') };
const answer = (value: number): Record<string, JevAnswer> => ({ support: { type: 'noul', noul: value } });
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}

it('recognizes only its own collector transports without retaining external deciders', () => {
  const collect = questionSetCollector(async sets => sets.map(() => answer(.9)));
  expect(isQuestionSetCollector(collect)).toBe(true);
  expect(isQuestionSetCollector(async () => ({}))).toBe(false);
  expect(isQuestionSetCollector(undefined)).toBe(false);
});

it('collects one microtask wave with original independent inputs and ordered mutable answers', async () => {
  const waves: JevQuestionSet[][] = [];
  const collect = questionSetCollector(async sets => { waves.push(sets); return sets.map(set => answer(Number(set.state.id) / 10)); });
  const first = collect('key', { id: 9, quote: 'Alpha exact quote.' }, questions);
  const second = collect('key', { id: 1, quote: 'Beta exact quote.' }, questions);
  expect(waves).toEqual([]);
  expect(await Promise.all([first, second])).toEqual([answer(.9), answer(.1)]);
  expect(waves).toEqual([[{ state: { id: 9, quote: 'Alpha exact quote.' }, questions },
    { state: { id: 1, quote: 'Beta exact quote.' }, questions }]]);
});

it('schedules one flush per wave and keeps new callers separate while an earlier wave is still running', async () => {
  const scheduled: Array<() => void> = []; const waves: JevQuestionSet[][] = [];
  const firstGate = gate<Array<Record<string, JevAnswer>>>();
  const collect = questionSetCollector(async sets => {
    waves.push(sets); return waves.length === 1 ? firstGate.promise : [answer(.3)];
  }, flush => scheduled.push(flush));
  const first = collect('key', { id: 1 }, questions); const second = collect('key', { id: 2 }, questions);
  expect(scheduled).toHaveLength(1); scheduled.shift()!();
  const third = collect('key', { id: 3 }, questions);
  expect(scheduled).toHaveLength(1); scheduled.shift()!();
  expect(await third).toEqual(answer(.3));
  firstGate.resolve([answer(.1), answer(.2)]);
  expect(await Promise.all([first, second])).toEqual([answer(.1), answer(.2)]);
  expect(waves.map(sets => sets.map(set => set.state.id))).toEqual([[1, 2], [3]]);
});

it.each([undefined, 'original non-Error failure', new Error('Original synchronous failure')])
('rejects every admitted caller with the exact synchronous failure and permits a fresh wave (%s)', async original => {
  let failed = true;
  const collect = questionSetCollector(sets => {
    if (failed) throw original;
    return Promise.resolve(sets.map(() => answer(.9)));
  });
  const settled = await Promise.allSettled([collect('key', { id: 1 }, questions), collect('key', { id: 2 }, questions)]);
  expect(settled).toEqual([{ status: 'rejected', reason: original }, { status: 'rejected', reason: original }]);
  failed = false; expect(await collect('key', { id: 3 }, questions)).toEqual(answer(.9));
});

it('waits for an asynchronous failed run and rejects the whole collected wave without releasing partial answers', async () => {
  const held = gate<Array<Record<string, JevAnswer>>>(); const error = new Error('Async provider failed');
  const collect = questionSetCollector(async () => { await held.promise; throw error; });
  let done = false;
  const pending = Promise.allSettled([collect('key', { id: 1 }, questions), collect('key', { id: 2 }, questions)])
    .then(result => { done = true; return result; });
  await Promise.resolve(); expect(done).toBe(false);
  held.resolve([answer(.8)]);
  expect(await pending).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
});
