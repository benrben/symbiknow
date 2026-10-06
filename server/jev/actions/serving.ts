import type { JevActionRequest,JevEvaluation,JevValues } from '../../../shared/jev-types.js';
import { ApiError } from '../../errors.js';
import { noul } from '../../jev.js';
import { lexicalScore } from './candidates.js';
import {
confidence,
evaluation,
json,
passages,
semanticThreshold,
supported,
type JevEvaluationContext
} from './context.js';
import { judgeQuestionSets } from './question-batch.js';

function localPassages(context: JevEvaluationContext, query: string, includeArchived: boolean) {
  return context.documents.filter(document => document.snapshot.workspaceId === context.workspaceId)
    .filter(document => includeArchived || !document.block.archived)
    .flatMap(document => passages(document, 24).map(passage => ({ document, passage,
      lexicalScore: lexicalScore(query, `${document.block.title} ${passage.quote}`) })))
    .filter(item => item.lexicalScore > 0).sort((left, right) => right.lexicalScore - left.lexicalScore).slice(0, 12);
}
type PassageMatch = ReturnType<typeof localPassages>[number];
function localResult(match: PassageMatch): JevValues {
  return { title: match.document.block.title, passage: json(match.passage), canvasId: match.document.canvasId,
    blockId: match.document.block.id, lexicalScore: match.lexicalScore, freshness: json(match.document.block.freshness ?? null),
    rerankStatus: match.document.block.processingExcluded ? 'excluded_from_external_processing' : 'unrated' };
}
function providerUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 499) throw error;
  return true;
}
async function ratePassages(context: JevEvaluationContext, query: string, matches: PassageMatch[], results: JevValues[], conflicts: JevValues[]) {
  const selected = matches.map((match, index) => ({ match, index })).filter(({ match }) => !match.document.block.processingExcluded);
  try {
    const answers = await judgeQuestionSets(context, selected.map(({ match }) => ({ state: { query, passage: match.passage.quote }, questions: {
      relevance: noul('Does passage directly supply evidence addressing the specific question in query? Shared words are insufficient.'),
      conflict: noul('Does passage contradict a factual premise explicitly stated in query in matching time and scope?'),
    } })));
    selected.forEach(({ index }, position) => recordRating(context, results[index], answers[position], conflicts));
    return false;
  } catch (error) { return providerUnavailable(error); }
}
function recordRating(context: JevEvaluationContext, value: JevValues, answers: Awaited<ReturnType<typeof judgeQuestionSets>>[number], conflicts: JevValues[]): void {
  value.relevance = confidence(answers.relevance); value.rerankStatus = 'rated';
  if (supported(answers.conflict, context)) conflicts.push({ ...value, kind: 'premise_conflict', confidence: confidence(answers.conflict) });
}
function recallResult(context: JevEvaluationContext, results: JevValues[], conflicts: JevValues[], unavailable: boolean): JevEvaluation {
  results.sort((left, right) => Number(right.relevance ?? right.lexicalScore) - Number(left.relevance ?? left.lexicalScore));
  const evidenceFound = results.some(value => value.rerankStatus === 'rated' && Number(value.relevance) >= semanticThreshold(context));
  const evidenceStatus = evidenceFound ? 'verified_support' : results.some(value => value.rerankStatus !== 'rated') ? 'local_unverified' : 'no_verified_support';
  return evaluation({ status: evidenceFound ? 'evidence_found' : 'no_verified_support_in_searched_candidates',
    evidenceFound, evidenceStatus, passages: results, conflicts,
    searchedCanvasIds: [...new Set(context.documents.map(item => item.canvasId))], candidateCount: results.length,
    coverage: 'bounded_local_candidates', reranking: unavailable ? 'unavailable_local_fallback' : 'available' });
}
export async function recall(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const query = recallQuery(request);
  if (!query) return evaluation({ status: 'missing_query', passages: [], conflicts: [] });
  const matches = localPassages(context, query, request.options?.includeArchived === true);
  const results = matches.map(localResult); const conflicts: JevValues[] = [];
  const unavailable = !context.settings.externalProcessing || await ratePassages(context, query, matches, results, conflicts);
  return recallResult(context, results, conflicts, unavailable);
}
function recallQuery(request: JevActionRequest): string { return request.query?.trim() ?? ''; }
