import type { JevQuestion } from '../server/jev.js';
import { resolveSharedQuestionTexts } from '../server/jev/actions/question-state-pool.test.helpers.js';
import { launchDryRunProvider, launchQuestionState } from './launch-dry-run-provider.js';

type SearchState = { question: string; documents: Array<{ option: string; title: string; sections: string[]; evidence: string[] }> };

/** Search judgments pick the document sharing the most question words; one shared word alone does not count, as with Jev's none. */
function searchJudgment(state: SearchState, questions: Record<string, JevQuestion>) {
  const words = state.question.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const overlap = (document: SearchState['documents'][number]) => {
    const text = [document.title, ...document.sections, ...document.evidence].join(' ').toLowerCase();
    return words.filter(word => text.includes(word)).length;
  };
  const best = [...state.documents].sort((left, right) => overlap(right) - overlap(left))[0];
  const selected = best && overlap(best) >= 2 ? best.option : 'none';
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const choices = question.type === 'choice' ? Object.keys(question.criteria) : [];
    return [id, { type: 'choice', choice: selected, confidence: 1,
      probabilities: Object.fromEntries(choices.map(choice => [choice, choice === selected ? 1 : 0])) }];
  }));
}

/** Fake only the external network boundary; acceptance keeps the native runtime and persistence. */
export const acceptanceReflexProvider: typeof fetch = async (url, options) => {
  if (new Headers(options?.headers).get('authorization') === 'Bearer acceptance-launch-key') return launchDryRunProvider(url, options);
  if (String(url) !== 'https://api.typesafe.ai/v1/systemone') throw new Error('Unexpected acceptance provider URL');
  const request = JSON.parse(String(options?.body)) as { model: string; state: { questionTexts?: string[] } & Partial<SearchState>; questions: Record<string, JevQuestion> };
  if (request.model !== 'jev-1.13.0') throw new Error('Acceptance requires the pinned decision model');
  if (request.state.documents && request.state.question) return Response.json({ answers: searchJudgment(request.state as SearchState, request.questions) });
  const decoded = resolveSharedQuestionTexts(request.questions, request.state.questionTexts);
  const answers = Object.fromEntries(Object.entries(decoded).map(([key, question]) => {
    const { id, state } = launchQuestionState(key, request.state);
    if (question.type === 'noul') return [key, { type: 'noul', noul: ['addressesAi', 'unrelatedDeletion', 'unsupportedClaim', 'requirementConflict', 'targetStated'].includes(id) ? 0.01 : 0.99 }];
    if (question.type === 'score') return [key, { type: 'score', score: 1, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 1 ? 1 : 0])) }];
    const choices = Object.keys(question.criteria);
    if (id === 'place' || id === 'gate') {
      const stagedGroup = state.groups?.find(group => group.key === 'custom:release/staged');
      const selected = stagedGroup?.option ?? state.groups?.[0]?.option ?? state.canvases?.[0]?.option ?? 'none';
      return [key, { type: 'choice', choice: selected, confidence: 1,
        probabilities: Object.fromEntries(choices.map(choice => [choice, choice === selected ? 1 : 0])) }];
    }
    if (id === 'overlap') return [key, { type: 'choice', choice: 'distinct', confidence: 1,
      probabilities: Object.fromEntries(choices.map(choice => [choice, choice === 'distinct' ? 1 : 0])) }];
    if (id === 'relation') return [key, { type: 'choice', choice: 'related', confidence: 1,
      probabilities: Object.fromEntries(choices.map(choice => [choice, choice === 'related' ? 1 : 0])) }];
    const staged = choices.find(choice => question.criteria[choice].includes('(custom:release/staged)'));
    const selected = id === 'intent' && choices.includes('organize') ? 'organize'
      : staged ?? choices.find(choice => !['none', 'unknown'].includes(choice)) ?? 'none';
    return [key, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(choices.map(choice => [choice, choice === selected ? 1 : 0])) }];
  }));
  return Response.json({ answers });
};
