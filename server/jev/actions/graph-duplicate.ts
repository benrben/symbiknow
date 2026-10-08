import { choice, type JevAnswer } from '../../jev.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { outlineState, sourcePassages } from './source-passages.js';
import { semanticThreshold, type JevEvaluationContext, type JevInputDocument } from './context.js';
import type { Pair } from './graph.js';

export function duplicateQuestionSet({ source, target }: Pair) {
  return { state: { source: outlineState(source, 20), target: outlineState(target, 20) }, questions: {
    overlap: choice('How do source and target relate as documents? Compare their titles, section lists, and passages.', {
      copy: 'Same document: the same facts and steps, possibly with a different title or small wording changes',
      version: 'One is an older, partial, or extended version of the other: most sections and passages match, but one has sections the other lacks',
      distinct: 'Different documents: they may share a topic or words, but most sections and facts differ',
    }),
  } };
}

function bodyPassages(document: JevInputDocument) {
  return sourcePassages(document.block.content).filter(passage => passage.headingLevel === 0)
    .slice(0, 8).map(({ start, end, quote }) => ({ source: document.snapshot, start, end, quote }));
}
export function duplicateEvidence({ source, target }: Pair) {
  const available = bodyPassages(source);
  const targetBody = bodyPassages(target);
  const shared = available.find(passage => targetBody.some(candidate => candidate.quote.includes(passage.quote)));
  if (!shared) return [...available.slice(0, 1), ...targetBody.slice(0, 1)];
  const match = targetBody.find(passage => passage.quote.includes(shared.quote))!;
  const start = match.start + match.quote.indexOf(shared.quote);
  return [shared, { source: target.snapshot, start, end: start + shared.quote.length, quote: shared.quote }];
}

export function duplicatePairAssessment(context: JevEvaluationContext, pair: Pair, answers: Record<string, JevAnswer>) {
  const answer = answers.overlap;
  const rawOverlap = answer?.type === 'choice' ? 1 - answer.probabilities.distinct : NaN;
  const certainty = calibrated(rawOverlap, decisionBoundaries.duplicateOverlap);
  const evidence = duplicateEvidence(pair);
  const overlap = answer?.type === 'choice' && answer.probabilities.copy >= answer.probabilities.version ? 'copy' as const : 'older_version' as const;
  return { eligible: rawOverlap >= decisionBoundaries.duplicateOverlap && certainty >= semanticThreshold(context) && evidence.length === 2,
    confidence: certainty, evidence, usefulness: 2, unsupported: false, relation: undefined, overlap, calibration: 1 };
}
