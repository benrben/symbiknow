import { isJevContextLimitFailure } from '../../jev-provider-error.js';
import type { JevQuestionSet } from './question-set-collector.js';

/** Split only rejected multi-set automatic transport; retain all original sources and questions. */
export async function recoverQuestionBundle<T>(sets: JevQuestionSet[], run: (sets: JevQuestionSet[]) => Promise<T[]>): Promise<T[]> {
  try { return await run(sets); }
  catch (error) {
    if (!isJevContextLimitFailure(error) || sets.length < 2) throw error;
    const middle = Math.floor(sets.length / 2);
    // Sequential halves keep the outer collector's bounded concurrency unchanged.
    const left = await recoverQuestionBundle(sets.slice(0, middle), run);
    return [...left, ...await recoverQuestionBundle(sets.slice(middle), run)];
  }
}
