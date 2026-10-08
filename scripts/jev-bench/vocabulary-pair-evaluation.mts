import type { JevEvaluationContext } from '../../server/jev/actions/context.js';
import type { JevDecider } from '../../server/jev.js';
import { automaticVocabulary } from '../../server/jev/actions/automatic.js';
import { vocabularyLifecycle } from '../../server/jev/actions/vocabulary.js';

export type VocabularyPairFixture = { caseId: string; pair: string; truth: boolean; input: JevEvaluationContext };
/** Both reports use the shipped paths, preserving their separate membership contexts and decisions. */
export async function evaluateVocabularyPair(item: VocabularyPairFixture, decider: JevDecider) {
  let raw = 0; let assessments = 0;
  const input = { ...item.input, decider: (async (...args) => {
    const answers = await decider(...args);
    const synonymous = Object.entries(answers).find(([id]) => /synonymous$/.test(id))?.[1];
    if (synonymous?.type === 'noul') { raw = synonymous.noul; assessments++; }
    return answers;
  }) as JevDecider };
  const [source, target] = input.vocabulary;
  const evaluated = await vocabularyLifecycle(input, { action: 'vocab_lifecycle', canvasId: input.canvases[0].id,
    options: { operation: 'merge', termId: source.id, targetId: target.id } });
  const lifecycle = { accepted: evaluated.result.synonymySupported === true,
    calibratedConfidence: evaluated.result.semanticConfidence, raw };
  const automatic = await automaticVocabulary(input, { action: 'vocab_lifecycle', canvasId: 'merge-only' });
  return { caseId: item.caseId, pair: item.pair, truth: item.truth, ...lifecycle,
    automaticAccepted: automatic.result.synonymySupported === true,
    automaticAssessed: assessments > 1, automaticRaw: assessments > 1 ? raw : null,
    automaticMergeCount: automatic.proposals.filter(proposal => proposal.mutation.kind === 'vocabulary' && proposal.mutation.operation === 'merge').length };
}
