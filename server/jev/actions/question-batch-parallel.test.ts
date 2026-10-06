import { expect, it } from 'vitest';
import { runQuestionChunks } from './question-batch-parallel.js';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

it('returns empty and single chunk results without unrelated calls', async () => {
  const admitted: number[] = [];
  const run = async (value: number, index: number) => { admitted.push(index); return value * 2; };
  expect(await runQuestionChunks([], run)).toEqual([]); expect(admitted).toEqual([]);
  expect(await runQuestionChunks([7], run)).toEqual([14]); expect(admitted).toEqual([0]);
});

it('bounds active chunks at four and preserves indexed output after replenishment and reverse completion', async () => {
  const chunks = Array.from({ length: 6 }, () => deferred<number>()); const admitted: number[] = [];
  const pending = runQuestionChunks(chunks, (chunk, index) => { admitted.push(index); return chunk.promise; });
  expect(admitted).toEqual([0, 1, 2, 3]); chunks[3].resolve(30); await Promise.resolve();
  expect(admitted).toEqual([0, 1, 2, 3, 4]); chunks[4].resolve(40); await Promise.resolve();
  expect(admitted).toEqual([0, 1, 2, 3, 4, 5]);
  for (const index of [5, 2, 1, 0]) chunks[index].resolve(index * 10);
  expect(await pending).toEqual([0, 10, 20, 30, 40, 50]);
});

it.each([undefined, 'non-Error provider failure'])('preserves an original %s throw, stops admission and drains every admitted chunk', async error => {
  const chunks = Array.from({ length: 6 }, () => deferred<number>()); const admitted: number[] = [];
  let settled = false;
  const pending = runQuestionChunks(chunks, (chunk, index) => { admitted.push(index); return chunk.promise; })
    .finally(() => { settled = true; });
  const observed = pending.then(value => ({ value }), failure => ({ failure }));
  chunks[2].reject(error); await Promise.resolve(); expect(settled).toBe(false);
  for (const index of [0, 1, 3]) chunks[index].resolve(index);
  expect(await observed).toEqual({ failure: error }); expect(admitted).toEqual([0, 1, 2, 3]);
});

it('throws the lower-index original error even when a later indexed failure is observed first', async () => {
  const chunks = Array.from({ length: 6 }, () => deferred<number>());
  const first = { detail: 'First indexed failure' }; const later = new Error('Earlier observed failure');
  const pending = runQuestionChunks(chunks, chunk => chunk.promise);
  const observed = pending.then(value => ({ value }), error => ({ error }));
  chunks[3].reject(later); await Promise.resolve(); chunks[1].reject(first);
  chunks[0].resolve(0); chunks[2].resolve(2);
  expect((await observed as { error: unknown }).error).toBe(first);
});

it('keeps an aborted empty wave local and rejects an aborted nonempty wave without admitting work', async () => {
  const controller = new AbortController(); controller.abort(); const admitted: number[] = [];
  const run = async (value: number) => { admitted.push(value); return value; };
  expect(await runQuestionChunks([], run, controller.signal)).toEqual([]);
  await expect(runQuestionChunks([1, 2], run, controller.signal)).rejects.toMatchObject({ status: 499 });
  expect(admitted).toEqual([]);
});

it('stops new admission on an abort between completions and drains successful calls before rejecting', async () => {
  const controller = new AbortController(); const chunks = Array.from({ length: 6 }, () => deferred<number>());
  const admitted: number[] = []; let settled = false;
  const pending = runQuestionChunks(chunks, (chunk, index) => { admitted.push(index); return chunk.promise; }, controller.signal)
    .finally(() => { settled = true; });
  const observed = pending.then(value => ({ value }), error => ({ error }));
  controller.abort(); chunks[2].resolve(2); await Promise.resolve(); expect(settled).toBe(false);
  for (const index of [0, 1, 3]) chunks[index].resolve(index);
  expect(await observed).toMatchObject({ error: { status: 499, message: 'Symbi Reflex evaluation was cancelled' } });
  expect(admitted).toEqual([0, 1, 2, 3]);
});
