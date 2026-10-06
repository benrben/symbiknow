import type { JevEvaluationContext } from './context.js';
import { collectedQuestionSets } from './question-batch.js';
import { questionSetCollector } from './question-set-collector.js';

/** Independent concept checks share bounded requests; each dependent check starts after its own validated answer. */
export function batchedDiscoveryContext(context: JevEvaluationContext,
  schedule: (flush: () => void) => void = queueMicrotask): JevEvaluationContext {
  const decider = questionSetCollector(sets => collectedQuestionSets({ ...context, wrapDecider: undefined,
    decider: context.uncachedDecider ?? context.decider }, sets), schedule);
  return { ...context, decider: context.wrapDecider?.(decider) ?? decider, uncachedDecider: decider };
}
