import type { CanvasBlock, CanvasTask } from '../../../shared/types.js';
import type { JevActionRequest, JevEvaluation, JevJson, JevMutation, JevPassage,
  JevSettings, JevSourceSnapshot, JevValues, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { ApiError } from '../../errors.js';
import { decideWithJev, type ChoiceAnswer, type ChoiceQuestion, type JevAnswer, type JevDecider, type JevQuestion,
  type NoulAnswer, type ScoreAnswer, type ScoreQuestion } from '../../jev.js';
import { boundedPassages, passageCoverage, readablePassage, sourcePassages } from './source-passages.js';
import { questionRequestFits } from './question-request-budget.js';

export interface JevInputDocument { canvasId: string; block: CanvasBlock; snapshot: JevSourceSnapshot }
export interface JevEvaluationContext {
  workspaceId: string;
  documents: JevInputDocument[];
  canvases: Array<{ id: string; name: string; groups?: Array<{ id: string; name: string; definition?: string }> }>;
  tasks: Array<{ canvasId: string; task: CanvasTask }>;
  vocabulary: JevVocabularyTerm[];
  settings: JevSettings;
  /** Jev-validated logical topics from current, visible source incarnations. */
  indexes?: Record<string, JevValues>;
  /** Ranked semantic candidate IDs supplied by the authorized local index boundary. */
  retrievedNeighbors?: Record<string, string[]>;
  /** Active action's application confidence cutoff, set at the evaluator boundary. */
  confidenceThreshold?: number;
  apiKey?: string;
  decider?: JevDecider;
  /** Retains exact-answer reuse when independent judgments introduce another batching layer. */
  wrapDecider?: (transport: JevDecider) => JevDecider;
  uncachedDecider?: JevDecider;
  /** Automatic bundles share exact source objects on the wire, while cache keys retain original states. */
  shareQuestionSources?: boolean;
  selectiveGroupAssessment?: boolean;
  /** Internal read-only prefetch boundary; checked label definitions can be assessed before unrelated hierarchy work finishes. */
  prefetchLabelDefinitions?: (evaluated: JevEvaluation) => void;
  prefetchLabelCandidateLimit?: number;
  signal?: AbortSignal;
  now?: Date;
  draft?: { id: string; baseContent: string; proposedContent: string; instruction: string };
  activity?: Array<{ id: string; action: string; createdAt: string; summary: string; sources: JevSourceSnapshot[] }>;
}
export type JevEvaluator = (context: JevEvaluationContext, request: JevActionRequest) => Promise<JevEvaluation>;
export type Candidate = { id: string; description: string };
export const JEV_QUESTION_VERSION = 'symbi-reflex-10';

export function textOption(request: JevActionRequest, key: string): string {
  const value = request.options?.[key];
  return typeof value === 'string' ? value : '';
}
export function arrayOption(request: JevActionRequest, key: string): string[] {
  const value = request.options?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
export function selectedDocuments(context: JevEvaluationContext, request: JevActionRequest): JevInputDocument[] {
  const allowed = context.documents.filter(document => document.snapshot.workspaceId === context.workspaceId);
  const selected = allowed.filter(document => document.canvasId === request.canvasId);
  if (!request.blockIds?.length) return selected.filter(document => !document.block.archived);
  const requested = selected.filter(document => request.blockIds?.includes(document.block.id));
  if (requested.length !== new Set(request.blockIds).size) throw new ApiError(404, 'A requested document is unavailable');
  return requested;
}
export function passages(document: JevInputDocument, limit = 8): JevPassage[] {
  return boundedPassages(sourcePassages(document.block.content), limit)
    .map(({ start, end, quote }) => ({ source: document.snapshot, start, end, quote }));
}
export function sourceState(document: JevInputDocument): JevValues {
  const available = sourcePassages(document.block.content);
  const windows = boundedPassages(available);
  return { id: document.block.id, title: document.block.title, passages: windows.map((passage, index) => ({
    id: `p${index}`, text: passage.text,
  })), coverage: passageCoverage(available, windows) };
}
export function candidates(options: Candidate[]): Record<string, string> {
  return Object.fromEntries([...options.slice(0, 24).map(option => [option.id, option.description]),
    ['none', 'No supplied option is sufficiently supported by the source evidence'],
    ['unknown', 'The supplied excerpts do not contain enough evidence to decide']]);
}
export function json(value: unknown): JevJson {
  return JSON.parse(JSON.stringify(value)) as JevJson;
}
export function evaluation(result: JevValues = {}): JevEvaluation { return { result, proposals: [] }; }
export function proposal(request: JevActionRequest, mutation: JevMutation, documents: JevInputDocument[],
  title: string, explanation: string, evidence: JevPassage[], confidence?: number): JevEvaluation['proposals'][number] {
  return { action: request.action, title, explanation, evidence,
    sources: documents.map(document => document.snapshot), mutation, ...(confidence === undefined ? {} : { confidence }) };
}
export function derived(request: JevActionRequest, document: JevInputDocument, values: JevValues,
  evidence: JevPassage[] = []): JevEvaluation['proposals'][number] {
  return proposal(request, { kind: 'derived', blockId: document.block.id, values }, [document],
    `${request.action}: ${document.block.title}`, 'Derived from the current scoped document revision', evidence);
}
export function semanticThreshold(context?: JevEvaluationContext): number {
  return context?.confidenceThreshold ?? 0.7;
}
export function supported(answer: JevAnswer | undefined, context?: JevEvaluationContext): boolean {
  return answer?.type === 'noul' && answer.noul >= semanticThreshold(context);
}
export function selected(answer: JevAnswer | undefined, context?: JevEvaluationContext): string | undefined {
  if (answer?.type !== 'choice' || ['none', 'unknown'].includes(answer.choice)) return undefined;
  const threshold = context ? semanticThreshold(context) : 0.55;
  return choiceCertainty(answer, context) >= threshold ? answer.choice : undefined;
}
function choiceCertainty(answer: ChoiceAnswer, context?: JevEvaluationContext): number {
  const probability = answer.probabilities[answer.choice];
  return context ? Math.min(probability, answer.confidence) : probability;
}
/** Quote selection can split across equally useful passages; substantive support is checked separately. */
export function selectedEvidence(answer: JevAnswer | undefined): string | undefined {
  if (answer?.type !== 'choice' || ['none', 'unknown'].includes(answer.choice)) return undefined;
  return answer.choice;
}
export function confidence(answer: JevAnswer): number {
  return answer.type === 'noul' ? answer.noul : answer.confidence;
}
export function exactEvidence(document: JevInputDocument, answer: JevAnswer | undefined): JevPassage[] {
  const id = selectedEvidence(answer);
  return passages(document).filter((_, index) => `p${index}` === id);
}
export function evidenceCandidates(document: JevInputDocument): Record<string, string> {
  return candidates(passages(document).map((passage, index) => ({ id: `p${index}`, description: readablePassage(passage.quote) })));
}
function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function distribution(answer: ChoiceAnswer | ScoreAnswer, expected: string[]): void {
  const keys = Object.keys(answer.probabilities);
  if (keys.length !== expected.length || !expected.every(key => probability(answer.probabilities[key]))) {
    throw new ApiError(502, 'Jev returned an invalid probability distribution');
  }
  const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.015) throw new ApiError(502, 'Jev probabilities do not sum to one');
}
function validateChoice(answer: ChoiceAnswer, question: ChoiceQuestion): void {
  if (!probability(answer.confidence)) throw new ApiError(502, 'Jev returned invalid confidence');
  distribution(answer, Object.keys(question.criteria));
  if (!(answer.choice in question.criteria)) throw new ApiError(502, 'Jev selected an unknown candidate');
  if (answer.probabilities[answer.choice] + 0.000001 < Math.max(...Object.values(answer.probabilities))) {
    throw new ApiError(502, 'Jev selected a non-leading choice');
  }
}
function validateScore(answer: ScoreAnswer, question: ScoreQuestion): void {
  if (!probability(answer.confidence)) throw new ApiError(502, 'Jev returned invalid confidence');
  distribution(answer, question.criteria.map((_, index) => `${index}`));
  if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1) throw new ApiError(502, 'Jev returned an invalid score');
}
function validateAnswer(answer: JevAnswer | undefined, question: JevQuestion): void {
  if (!answer || answer.type !== question.type) throw new ApiError(502, 'Jev returned a missing or mismatched answer');
  // Exact type equality above makes these narrowing casts safe at this boundary.
  if (question.type === 'choice') return validateChoice(answer as ChoiceAnswer, question);
  if (question.type === 'score') return validateScore(answer as ScoreAnswer, question);
  if (!probability((answer as NoulAnswer).noul)) throw new ApiError(502, 'Jev returned an invalid yes/no probability');
}
export function validateJevAnswers(answers: Record<string, JevAnswer>, questions: Record<string, JevQuestion>): void {
  for (const [id, question] of Object.entries(questions)) validateAnswer(answers[id], question);
}
function providerKey(context: JevEvaluationContext): string {
  if (!context.settings.externalProcessing) throw new ApiError(403, 'External Symbi Reflex processing is disabled');
  const key = context.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
  if (!key) throw new ApiError(503, 'Symbi Reflex is unavailable: configure a TypeSafe API key');
  return key;
}
function checkRequestBudget(context: JevEvaluationContext, state: unknown, questions: Record<string, JevQuestion>): void {
  if (!questionRequestFits(state, questions, context.shareQuestionSources === true)) throw new ApiError(413, 'Symbi Reflex decision exceeds the application token budget');
  if (context.signal?.aborted) throw new ApiError(499, 'Symbi Reflex evaluation was cancelled');
}
/** Private batching transport. Originating judges validate each complete source-scoped answer set. */
export async function requestQuestionAnswers(context: JevEvaluationContext, state: unknown,
  questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>> {
  if (!Object.keys(questions).length) return {};
  const key = providerKey(context);
  const metadata = { questionVersion: JEV_QUESTION_VERSION, sourceTrust: 'untrusted_evidence' };
  const annotated = { ...(state as Record<string, unknown>), decisionProgram: metadata };
  checkRequestBudget(context, annotated, questions);
  return (context.decider ?? decideWithJev)(key, annotated, questions, undefined,
    { signal: context.signal, maxRetries: 0 });
}
export async function judge(context: JevEvaluationContext, state: unknown,
  questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>> {
  const answers = await requestQuestionAnswers(context, state, questions);
  validateJevAnswers(answers, questions);
  return answers;
}
export function currentTime(context: JevEvaluationContext): Date { return context.now ?? new Date(); }
