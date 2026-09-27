import { ApiError } from './errors.js';
import type { JevAnswer, ScoreAnswer } from './jev.js';

export function expectedScore(answer: JevAnswer, levels: number): number {
  if (answer.type !== 'score' || !Number.isInteger(levels) || levels < 2) {
    throw new ApiError(502, 'Jev returned an invalid score');
  }
  return Array.from({ length: levels }, (_, level) => level * (answer.probabilities[String(level)] ?? 0))
    .reduce((sum, value) => sum + value, 0) / (levels - 1);
}

export function topScore(answer: JevAnswer): number {
  if (answer.type !== 'score') throw new ApiError(502, 'Jev returned an invalid score');
  return answer.score;
}

/** Shared typed accessors for modules reading Jev answers, so option keys stay literal end to end. */
export function choiceAnswer<const O extends string>(answers: Record<string, JevAnswer | undefined>, id: string,
  options: readonly O[]): { value: O; confidence: number } {
  const answer = answers[id];
  if (answer?.type !== 'choice' || !(options as readonly string[]).includes(answer.choice) || !Number.isFinite(answer.confidence)) {
    throw new ApiError(502, `Jev returned no valid choice for ${id}`);
  }
  return { value: answer.choice as O, confidence: answer.confidence };
}

export function scoreAnswer(answers: Record<string, JevAnswer | undefined>, id: string): ScoreAnswer {
  const answer = answers[id];
  if (answer?.type !== 'score' || !Number.isFinite(answer.score)) throw new ApiError(502, `Jev returned no valid score for ${id}`);
  return answer;
}

export function noulAnswer(answers: Record<string, JevAnswer | undefined>, id: string): number {
  const answer = answers[id];
  if (answer?.type !== 'noul' || !Number.isFinite(answer.noul)) throw new ApiError(502, `Jev returned no valid noul for ${id}`);
  return answer.noul;
}
