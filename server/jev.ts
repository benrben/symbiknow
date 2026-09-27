import { ApiError } from './storage.js';

const endpoint = 'https://api.typesafe.ai/v1/systemone';
const maxResponseBytes = 262_144;
const requestTimeoutMs = 20_000;
const maxBackoffMs = 5_000;
const maxHonoredRetryAfterMs = 10_000;
const idPattern = /^[A-Za-z0-9_]{1,128}$/;
const retryableStatuses = new Set([429, 500, 502, 503, 504, 529]);

export const JEV_MODEL = process.env.TYPESAFE_MODEL?.trim() || 'jev-1.13.0';
export const JEV_STATE_TOKEN_LIMIT = 32_000;

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
  return typeof answer.score === 'number' && Number.isFinite(answer.score)
    && answer.score >= 0 && answer.score <= question.criteria.length - 1
    && probabilities(answer.probabilities, keys)
    && (answer.legend === undefined || (object(answer.legend) && Object.values(answer.legend).every(item => typeof item === 'string')));
}

function validAnswer(answer: unknown, question: JevQuestion): answer is JevAnswer {
  if (!object(answer) || answer.type !== question.type) return false;
  if (question.type === 'noul') return probability(answer.noul);
  if (!probability(answer.confidence)) return false;
  if (question.type === 'choice') return validChoice(answer, question);
  return validScore(answer, question);
}

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, 'Jev returned an empty response');
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); }
    catch { throw new ApiError(502, 'Jev response could not be read'); }
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      throw new ApiError(502, 'Jev response is too large');
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

async function boundedJson(response: Response): Promise<unknown> {
  const body = await boundedBody(response);
  try { return JSON.parse(body) as unknown; }
  catch { throw new ApiError(502, 'Jev returned invalid JSON'); }
}

function remoteErrorDetail(value: unknown): string {
  if (!object(value)) return '';
  const detail = value.detail;
  if (typeof detail === 'string') return detail.slice(0, 250);
  if (object(detail) && typeof detail.error_type === 'string' && /^[a-z][a-z0-9_]{1,60}$/.test(detail.error_type)) {
    return detail.error_type.replaceAll('_', ' ');
  }
  if (Array.isArray(detail)) return detail.slice(0, 2).flatMap(entry => {
    if (!object(entry) || typeof entry.msg !== 'string') return [];
    const path = Array.isArray(entry.loc) ? entry.loc.filter(part => typeof part === 'string' || typeof part === 'number').join('.') : '';
    return [`${path ? `${path}: ` : ''}${entry.msg}`.slice(0, 250)];
  }).join('; ');
  return typeof value.message === 'string' ? value.message.slice(0, 250) : '';
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
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)
    || typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return;
  const usage: JevUsage = { model: JEV_MODEL, inputTokens, outputTokens, questions: Object.keys(questions).length, at: new Date().toISOString() };
  for (const listener of usageListeners) {
    try { listener(usage); } catch { /* A listener's mistake must never break the Jev call. */ }
  }
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
    if (!idPattern.test(id)) throw new ApiError(500, `Invalid Jev question id: ${id}`);
    if (!question.instructions.trim()) throw new ApiError(500, `Jev question ${id} has empty instructions`);
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      if (keys.length < 2 || keys.length > 255) throw new ApiError(500, `Jev choice question ${id} must have 2 to 255 options`);
      if (keys.some(key => !key)) throw new ApiError(500, `Jev choice question ${id} has an empty option key`);
    } else if (question.type === 'score') {
      if (question.criteria.length < 2 || question.criteria.length > 10) throw new ApiError(500, `Jev score question ${id} must have 2 to 10 levels`);
    } else if (question.criteria) {
      const keys = Object.keys(question.criteria);
      if (keys.some(key => key !== 'true' && key !== 'false')) throw new ApiError(500, `Jev noul question ${id} criteria keys must be true and/or false`);
    }
    longestQuestionTokens = Math.max(longestQuestionTokens, estimateJevTokens(question));
  }
  if (estimateJevTokens(state) + longestQuestionTokens > JEV_STATE_TOKEN_LIMIT) {
    throw new ApiError(413, 'Jev state is too large for a single decision. Reduce the amount of content sent.');
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function backoffMs(attempt: number, baseDelayMs: number): number {
  const base = Math.min(baseDelayMs * 2 ** attempt, maxBackoffMs);
  return base + (Math.random() * 2 - 1) * base * 0.25;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ApiError(499, 'Jev request was cancelled')); return; }
    if (ms <= 0) { resolve(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new ApiError(499, 'Jev request was cancelled')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function statusMessage(status: number, detail: string): string {
  if (status === 429) return 'TypeSafe Jev rate limit reached (429). Try again shortly.';
  if (status === 529) return 'TypeSafe Jev is overloaded (529). Try again shortly.';
  return `Jev request failed (${status})${detail ? `: ${detail}` : ''}`;
}

export const decideWithJev: JevDecider = async (apiKey, state, questions, fetcher = fetch, options = {}) => {
  if (!apiKey) throw new ApiError(400, 'Set a TypeSafe Jev API key in Settings before using insights');
  if (!Object.keys(questions).length) return {};
  assertValidJevRequest(state, questions);
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const body = JSON.stringify({ model: JEV_MODEL, state, questions });

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new ApiError(499, 'Jev request was cancelled');
    const signal = AbortSignal.any(options.signal ? [options.signal, AbortSignal.timeout(requestTimeoutMs)] : [AbortSignal.timeout(requestTimeoutMs)]);

    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal,
      });
    } catch {
      if (options.signal?.aborted) throw new ApiError(499, 'Jev request was cancelled');
      if (attempt >= maxRetries) throw new ApiError(502, 'Could not reach TypeSafe Jev');
      await sleep(backoffMs(attempt, baseDelayMs), options.signal);
      continue;
    }

    if (response.status === 401) throw new ApiError(502, 'TypeSafe Jev rejected the API key (401). Check the Jev key in Settings.');
    if (response.ok) {
      const result = await boundedJson(response);
      const answers = validatedAnswers(result, questions);
      emitUsage(result, questions);
      return answers;
    }

    if (retryableStatuses.has(response.status)) {
      const retryAfter = retryAfterMs(response.headers.get('retry-after'));
      if (attempt < maxRetries && (retryAfter === undefined || retryAfter <= maxHonoredRetryAfterMs)) {
        await sleep(retryAfter ?? backoffMs(attempt, baseDelayMs), options.signal);
        continue;
      }
    }

    let detail = '';
    try { detail = remoteErrorDetail(await boundedJson(response)); } catch { /* Keep the HTTP status when the error body is unavailable. */ }
    throw new ApiError(502, statusMessage(response.status, detail));
  }
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
