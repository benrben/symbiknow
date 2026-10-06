import { ApiError } from './errors.js';
import { requestJev } from './jev-transport.js';

const idPattern = /^[A-Za-z0-9_]{1,128}$/;

export const JEV_MODEL = process.env.TYPESAFE_MODEL?.trim() || 'jev-1.13.0';
export const JEV_STATE_TOKEN_LIMIT = 32_000;
export const JEV_REQUEST_TOKEN_LIMIT = 64_000;

export type ChoiceQuestion<C extends Record<string, string> = Record<string, string>> =
  { type: 'choice'; instructions: string; criteria: C };
export type ScoreQuestion<L extends readonly string[] = readonly string[]> =
  { type: 'score'; instructions: string; criteria: L };
export type NoulQuestion = { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } };
export type JevQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type ChoiceAnswer<C extends Record<string, string> = Record<string, string>> =
  { type: 'choice'; choice: keyof C & string; probabilities: Record<keyof C & string, number>; confidence: number };
export type ScoreAnswer = { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> };
export type NoulAnswer = { type: 'noul'; noul: number };
export type JevAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerFor<Q extends JevQuestion> =
  Q extends ChoiceQuestion<infer C> ? ChoiceAnswer<C> : Q extends ScoreQuestion ? ScoreAnswer : NoulAnswer;
export type AnswersFor<Q extends Record<string, JevQuestion>> = { [K in keyof Q]: AnswerFor<Q[K]> };

/** Question builders that keep option keys and level lists literal, like the official SDK. */
export function choice<const C extends Record<string, string>>(instructions: string, criteria: C): ChoiceQuestion<C> {
  return { type: 'choice', instructions, criteria };
}
export function score<const L extends readonly string[]>(instructions: string, criteria: L): ScoreQuestion<L> {
  return { type: 'score', instructions, criteria };
}
export function noul(instructions: string, criteria?: { true?: string; false?: string }): NoulQuestion {
  return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

export type JevCallOptions = { signal?: AbortSignal; maxRetries?: number; baseDelayMs?: number };
export type JevDecider = (apiKey: string, state: unknown, questions: Record<string, JevQuestion>,
  fetcher?: typeof fetch, options?: JevCallOptions) => Promise<Record<string, JevAnswer>>;

export type JevUsage = { model: string; inputTokens: number; outputTokens: number; questions: number; at: string };
const usageListeners = new Set<(usage: JevUsage) => void>();

/** Subscribe to usage reported after each successful Jev call. Returns an unsubscribe function. */
export function onJevUsage(listener: (usage: JevUsage) => void): () => void {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function probabilities(value: unknown, keys: string[]): value is Record<string, number> {
  return object(value) && keys.every(key => probability(value[key]));
}

function validChoice(answer: Record<string, unknown>, question: ChoiceQuestion): boolean {
  const keys = Object.keys(question.criteria);
  return typeof answer.choice === 'string' && keys.includes(answer.choice)
    && probabilities(answer.probabilities, keys);
}

function validScore(answer: Record<string, unknown>, question: ScoreQuestion): boolean {
  const keys = question.criteria.map((_, index) => String(index));
  return validScoreValue(answer.score, question.criteria.length) && probabilities(answer.probabilities, keys) && validLegend(answer.legend);
}

function validScoreValue(value: unknown, levels: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= levels - 1;
}

function validLegend(legend: unknown): boolean {
  return legend === undefined || (object(legend) && Object.values(legend).every(item => typeof item === 'string'));
}

function validAnswer(answer: unknown, question: JevQuestion): answer is JevAnswer {
  if (!object(answer) || answer.type !== question.type) return false;
  if (question.type === 'noul') return probability(answer.noul);
  if (!probability(answer.confidence)) return false;
  if (question.type === 'choice') return validChoice(answer, question);
  return validScore(answer, question);
}

function validatedAnswers(result: unknown, questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  if (!object(result) || !object(result.answers)) throw new ApiError(502, 'Jev returned no answers');
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = result.answers[id];
    if (!validAnswer(answer, question)) throw new ApiError(502, `Jev returned an invalid answer for ${id}`);
    answers[id] = answer;
  }
  return answers;
}

function emitUsage(result: unknown, questions: Record<string, JevQuestion>): void {
  if (!object(result) || !object(result.usage)) return;
  const { input_tokens: inputTokens, output_tokens: outputTokens } = result.usage;
  if (!finiteNumber(inputTokens) || !finiteNumber(outputTokens)) return;
  const usage: JevUsage = { model: JEV_MODEL, inputTokens, outputTokens, questions: Object.keys(questions).length, at: new Date().toISOString() };
  notifyUsage(usage);
}

function notifyUsage(usage: JevUsage): void {
  for (const listener of usageListeners) {
    try { listener(usage); } catch { console.warn('A Jev usage listener failed; the decision result remains available.'); }
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Conservative token estimate for non-English text: UTF-8 bytes of the JSON form, divided by 3. */
export function estimateJevTokens(value: unknown): number {
  const json = JSON.stringify(value) ?? 'null';
  return Math.ceil(new TextEncoder().encode(json).length / 3);
}

/** Local checks for a bug in our own request construction, not the caller's input. */
export function assertValidJevRequest(state: unknown, questions: Record<string, JevQuestion>): void {
  let longestQuestionTokens = 0;
  for (const [id, question] of Object.entries(questions)) {
    validateQuestion(id, question);
    longestQuestionTokens = Math.max(longestQuestionTokens, estimateJevTokens(question));
  }
  const stateTokens = estimateJevTokens(state);
  if (stateTokens + longestQuestionTokens > JEV_STATE_TOKEN_LIMIT
    || stateTokens + estimateJevTokens(questions) > JEV_REQUEST_TOKEN_LIMIT) {
    throw new ApiError(413, 'Jev state is too large for a single decision. Reduce the amount of content sent.');
  }
}

function validateQuestion(id: string, question: JevQuestion): void {
  if (!idPattern.test(id)) throw new ApiError(500, `Invalid Jev question id: ${id}`);
  if (!question.instructions.trim()) throw new ApiError(500, `Jev question ${id} has empty instructions`);
  if (question.type === 'choice') validateChoiceQuestion(id, question);
  else if (question.type === 'score') validateScoreQuestion(id, question);
  else if (question.criteria) validateNoulQuestion(id, question.criteria);
}

function validateChoiceQuestion(id: string, question: ChoiceQuestion): void {
  const keys = Object.keys(question.criteria);
  if (keys.length < 2 || keys.length > 255) throw new ApiError(500, `Jev choice question ${id} must have 2 to 255 options`);
  if (keys.some(key => !key)) throw new ApiError(500, `Jev choice question ${id} has an empty option key`);
}

function validateScoreQuestion(id: string, question: ScoreQuestion): void {
  if (question.criteria.length < 2 || question.criteria.length > 10) throw new ApiError(500, `Jev score question ${id} must have 2 to 10 levels`);
}

function validateNoulQuestion(id: string, criteria: NonNullable<NoulQuestion['criteria']>): void {
  const keys = Object.keys(criteria);
  if (keys.some(key => key !== 'true' && key !== 'false')) throw new ApiError(500, `Jev noul question ${id} criteria keys must be true and/or false`);
}

export const decideWithJev: JevDecider = async (apiKey, state, questions, fetcher = fetch, options = {}) => {
  if (!apiKey) throw new ApiError(400, 'A TypeSafe Jev API key is required');
  if (!Object.keys(questions).length) return {};
  assertValidJevRequest(state, questions);
  const body = JSON.stringify({ model: JEV_MODEL, state, questions });
  const result = await requestJev(apiKey, body, fetcher, options);
  const answers = validatedAnswers(result, questions);
  emitUsage(result, questions);
  return answers;
};

/** Calls the decider and returns answers typed to the literal shape of the questions asked. */
export async function askJev<const Q extends Record<string, JevQuestion>>(decider: JevDecider, apiKey: string, state: unknown,
  questions: Q, options?: JevCallOptions): Promise<AnswersFor<Q>> {
  const answers = await decider(apiKey, state, questions, undefined, options);
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer || answer.type !== question.type) throw new ApiError(502, `Jev returned no valid answer for ${id}`);
  }
  return answers as AnswersFor<Q>;
}
