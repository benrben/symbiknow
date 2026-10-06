import { ApiError } from '../../errors.js';

type Failure = { index: number; error: unknown };
/** Drain admitted calls before exposing a result or the earliest indexed failure. */
export async function runQuestionChunks<T, R>(chunks: T[], run: (chunk: T, index: number) => Promise<R>,
  signal?: AbortSignal): Promise<R[]> {
  const results: R[] = []; const failures: Failure[] = []; let next = 0;
  async function worker(): Promise<void> {
    while (!failures.length && next < chunks.length && !signal?.aborted) {
      const index = next++;
      try { results[index] = await run(chunks[index], index); }
      catch (error) { failures.push({ index, error }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  const failed = failures.sort((left, right) => left.index - right.index)[0];
  if (failed) throw failed.error;
  if (next < chunks.length) throw new ApiError(499, 'Symbi Reflex evaluation was cancelled');
  return results;
}
