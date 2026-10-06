import { expect, it } from 'vitest';
import { ApiError } from '../../errors.js';
import { jevRemoteError } from '../../jev-provider-error.js';
import { noul } from '../../jev.js';
import { recoverQuestionBundle } from './question-batch-recovery.js';
import type { JevQuestionSet } from './question-set-collector.js';

const sets: JevQuestionSet[] = [0, 1, 2, 3].map(id => ({ state: { id, exact: `Source ${id}` }, questions: { support: noul(`Question ${id}`) } }));
it('bounds recursive recovery and returns every original answer in order', async () => {
  const seen: JevQuestionSet[][] = []; let active = 0; let maximum = 0;
  const original = structuredClone(sets);
  const answers = await recoverQuestionBundle(sets, async group => {
    seen.push(group); active++; maximum = Math.max(maximum, active);
    await Promise.resolve(); active--;
    if (group.length > 1) throw jevRemoteError(400, 'max tokens exceeded');
    return group.map(set => ({ support: { type: 'noul', noul: Number(set.state.id) / 10 } }));
  });
  expect(seen.map(group => group.map(set => set.state.id))).toEqual([[0, 1, 2, 3], [0, 1], [0], [1], [2, 3], [2], [3]]);
  expect(answers).toEqual([0, 1, 2, 3].map(id => ({ support: { type: 'noul', noul: id / 10 } })));
  expect(maximum).toBe(1); expect(sets).toEqual(original);
});
it('preserves successful empty and multi-set results without splitting', async () => {
  expect(await recoverQuestionBundle([], async () => [])).toEqual([]);
  expect(await recoverQuestionBundle(sets, async group => group.map(set => set.state.id))).toEqual([0, 1, 2, 3]);
});
it.each([
  { name: 'singleton source', group: sets.slice(0, 1), error: jevRemoteError(400, 'max tokens exceeded') },
  { name: 'untrusted lookalike', group: sets, error: new ApiError(502, 'max tokens exceeded') },
  { name: 'upstream validation', group: sets, error: jevRemoteError(400, 'invalid question') },
  { name: 'billing', group: sets, error: jevRemoteError(402, 'billing unavailable') },
  { name: 'cancellation', group: sets, error: new ApiError(499, 'cancelled') },
  { name: 'malformed response', group: sets, error: new ApiError(502, 'invalid JSON') },
])('does not retry or alter $name failure', async ({ group, error }) => {
  let calls = 0;
  await expect(recoverQuestionBundle(group, async () => { calls++; throw error; })).rejects.toBe(error);
  expect(calls).toBe(1);
});
it('propagates a split-half failure before admitting the later half', async () => {
  const error = new ApiError(499, 'cancelled'); const seen: number[] = [];
  await expect(recoverQuestionBundle(sets, async group => {
    seen.push(group.length);
    if (group.length > 2) throw jevRemoteError(400, 'max tokens exceeded');
    throw error;
  })).rejects.toBe(error);
  expect(seen).toEqual([4, 2]);
});
