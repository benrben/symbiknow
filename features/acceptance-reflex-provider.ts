import type { JevQuestion } from '../server/jev.js';
import { resolveSharedQuestionTexts } from '../server/jev/actions/question-state-pool.test.helpers.js';

/** Fake only the external network boundary; acceptance keeps the native runtime and persistence. */
export const acceptanceReflexProvider: typeof fetch = async (url, options) => {
  if (String(url) !== 'https://api.typesafe.ai/v1/systemone') throw new Error('Unexpected acceptance provider URL');
  const request = JSON.parse(String(options?.body)) as { model: string; state: { questionTexts?: string[] }; questions: Record<string, JevQuestion> };
  if (request.model !== 'jev-1.13.0') throw new Error('Acceptance requires the pinned decision model');
  const decoded = resolveSharedQuestionTexts(request.questions, request.state.questionTexts);
  const answers = Object.fromEntries(Object.entries(decoded).map(([key, question]) => {
    const id = key.replace(/^\d+__/, '');
    if (question.type === 'noul') return [key, { type: 'noul', noul: ['addressesAi', 'unrelatedDeletion', 'unsupportedClaim', 'requirementConflict', 'targetStated'].includes(id) ? 0.01 : 0.99 }];
    if (question.type === 'score') return [key, { type: 'score', score: 1, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 1 ? 1 : 0])) }];
    const choices = Object.keys(question.criteria);
    const staged = choices.find(choice => question.criteria[choice].includes('(custom:release/staged)'));
    const selected = id === 'intent' && choices.includes('organize') ? 'organize'
      : staged ?? choices.find(choice => !['none', 'unknown'].includes(choice)) ?? 'none';
    return [key, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(choices.map(choice => [choice, choice === selected ? 1 : 0])) }];
  }));
  return Response.json({ answers });
};
