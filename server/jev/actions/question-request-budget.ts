import { estimateJevTokens, JEV_REQUEST_TOKEN_LIMIT, JEV_STATE_TOKEN_LIMIT, type JevQuestion } from '../../jev.js';

function longestQuestionTokens(questions: Record<string, JevQuestion>): number {
  return Object.values(questions).reduce((longest, question) => Math.max(longest, estimateJevTokens(question)), 0);
}

/** Shared bundles must satisfy both SDK limits; ordinary requests retain their smaller application budget. */
export function questionRequestFits(state: unknown, questions: Record<string, JevQuestion>, shared: boolean, reserve = 0): boolean {
  const stateTokens = estimateJevTokens(state) + reserve;
  if (!shared) return stateTokens + estimateJevTokens(questions) <= 16000;
  return stateTokens + longestQuestionTokens(questions) <= JEV_STATE_TOKEN_LIMIT
    && stateTokens + estimateJevTokens(questions) <= JEV_REQUEST_TOKEN_LIMIT;
}
