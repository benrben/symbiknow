import type { JevActionRequest,JevEvaluation,JevValues } from '../../../shared/jev-types.js';
import { choice,score,type JevAnswer,type JevQuestion,type ScoreAnswer } from '../../jev.js';
import {
candidates,
evaluation,evidenceCandidates,exactEvidence,
passages,proposal,selectedDocuments,semanticThreshold,sourceState,
type JevEvaluationContext,type JevInputDocument
} from './context.js';
import { judgeQuestionSets } from './question-batch.js';

type Answers = Record<string, JevAnswer>;
function passageReferences(source: JevInputDocument) {
  return candidates(passages(source).map((_, index) => ({ id: `p${index}`, description: `Exact source.passages entry with id p${index}` })));
}

const qualityLevels = ['Insufficient evidence', 'Substantial gaps', 'Partly supported', 'Well supported'] as const;
const qualityDimensions = ['specificity', 'traceability', 'declaredPurposeCompleteness', 'internalConsistency'];
function qualityScoreSet(source: JevInputDocument) {
  const questions: Record<string, JevQuestion> = {};
  const references = passageReferences(source);
  for (const dimension of qualityDimensions) {
    questions[dimension] = score(`Assess ${dimension} only against explicit purpose and source passages; missing evidence is unknown.`, qualityLevels);
    qualityLevels.forEach((label, level) => { questions[`${dimension}Evidence_${level}`] = choice(
      `Which exact source passage supports ${dimension} at numeric level ${level} (${label}) on qualityLevels? Choose none when that assessment lacks source evidence.`, references); });
  }
  return { state: { source: sourceState(source), declaredPurpose: source.block.purpose ?? null, qualityLevels }, questions };
}
function qualityRubric(context: JevEvaluationContext, source: JevInputDocument, answers: Answers, assessment: Answers) {
  const rubric: JevValues = {};
  const evidence = qualityDimensions.flatMap(dimension => {
    const score = (answers[dimension] as ScoreAnswer).score;
    const support = exactEvidence(source, Number.isInteger(score) ? answers[`${dimension}Evidence_${score}`] : assessment[`${dimension}Evidence`]);
    rubric[dimension] = support.length ? qualityAssessment(context, answers[dimension] as ScoreAnswer) : { status: 'insufficient_evidence' };
    return support;
  });
  return { rubric, evidence };
}
export async function scoreQuality(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {} });
  const documents: JevValues = {};
  const sources = selectedDocuments(context, request);
  const scores = await judgeQuestionSets(context, sources.map(qualityScoreSet));
  const assessments = await fractionalQualityEvidence(context, sources, scores);
  for (const [index, source] of sources.entries()) {
    const { rubric, evidence } = qualityRubric(context, source, scores[index], assessments[index]);
    documents[source.block.id] = { rubric, advisory: true };
    result.proposals.push(proposal(request, { kind: 'derived', blockId: source.block.id, values: { qualityRubric: rubric, advisory: true } },
      [source], 'Inspect purpose-specific quality', 'Individual dimensions are advisory; no composite score authorizes writes or ranks people', evidence));
  }
  result.result.documents = documents;
  return result;
}
function qualityAssessment(context: JevEvaluationContext, answer: ScoreAnswer): JevValues {
  if (answer.confidence < semanticThreshold(context)) return { score: answer.score,
    confidence: answer.confidence, status: 'uncertain' };
  return { score: answer.score, confidence: answer.confidence };
}
function qualityEvidenceSet(source: JevInputDocument, answers: Answers) {
  const dimensions = qualityDimensions.filter(dimension => !Number.isInteger((answers[dimension] as ScoreAnswer).score));
  const assessments = Object.fromEntries(dimensions.map(dimension => [dimension, {
    score: (answers[dimension] as ScoreAnswer).score, scale: qualityLevels,
  }]));
  const questions = Object.fromEntries(dimensions.map(dimension => [`${dimension}Evidence`,
    choice(`Which exact passage supports the numeric score on the supplied scale in assessments.${dimension}? Choose none when the assessment lacks source evidence.`, evidenceCandidates(source))]));
  return { state: { source: sourceState(source), declaredPurpose: source.block.purpose ?? null, assessments }, questions };
}
async function fractionalQualityEvidence(context: JevEvaluationContext, sources: JevInputDocument[], scores: Answers[]): Promise<Answers[]> {
  const sets = sources.map((source, index) => ({ index, set: qualityEvidenceSet(source, scores[index]) }))
    .filter(({ set }) => Object.keys(set.questions).length);
  const answers = await judgeQuestionSets(context, sets.map(({ set }) => set));
  const result: Answers[] = sources.map(() => ({}));
  sets.forEach(({ index }, position) => { result[index] = answers[position]; });
  return result;
}
