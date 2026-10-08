import type { LinkRelation } from '../../../shared/types.js';
import { choice, noul, type JevAnswer } from '../../jev.js';
import { evidenceCandidates, exactEvidence, semanticThreshold, supported, type JevEvaluationContext } from './context.js';
import { outlineState } from './source-passages.js';
import type { Pair } from './graph.js';

export const LINK_RELATIONS = {
  prerequisite: 'source needs target to be understood or carried out',
  implements: 'source carries out requirements or a plan stated in target',
  example_of: 'source is a concrete example of the concept in target',
  related: 'target gives useful context on a subject source discusses',
  none: 'Target does not help a reader of source',
};
export function automaticLinkSet({ source, target, hypothesis }: Pair) {
  return { state: { source: outlineState(source), target: outlineState(target), hypothesis }, questions: {
    supported: noul('Would a reader of source gain useful context by following a link to target?', {
      true: 'Target explains, specifies, or extends a subject that source relies on or discusses',
      false: 'Target is about a different subject; shared words or a general product connection do not count',
    }),
    sourceEvidence: choice('Which exact source passage supports hypothesis?', evidenceCandidates(source)),
    targetEvidence: choice('Which exact target passage supports hypothesis?', evidenceCandidates(target)),
    relation: choice('Which relationship from source to target do the passages show? Pick the most specific one that fits.', LINK_RELATIONS),
  } };
}
function automaticRelation(answer: JevAnswer | undefined): LinkRelation | undefined {
  if (answer?.type !== 'choice') return undefined;
  if (answer.choice === 'none' || !Object.hasOwn(LINK_RELATIONS, answer.choice)) return undefined;
  return answer.choice as LinkRelation;
}
export function automaticLinkAssessment(context: JevEvaluationContext, { source, target }: Pair, answers: Record<string, JevAnswer>) {
  const sourceEvidence = exactEvidence(source, answers.sourceEvidence);
  const targetEvidence = exactEvidence(target, answers.targetEvidence);
  const relation = automaticRelation(answers.relation);
  const certainty = answers.supported?.type === 'noul' ? answers.supported.noul : 0;
  return { eligible: supported(answers.supported, context) && sourceEvidence.length > 0 && targetEvidence.length > 0 && relation !== undefined,
    unsupported: certainty < .5 && 1 - certainty >= semanticThreshold(context), confidence: certainty,
    evidence: [...sourceEvidence, ...targetEvidence], usefulness: 2, relation };
}
