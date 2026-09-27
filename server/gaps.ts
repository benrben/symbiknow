import { documentText } from '../shared/document-text.js';
import { excerpt } from '../shared/excerpt.js';
import type { InsightItem } from '../shared/insights.js';
import type { CanvasBlock } from '../shared/types.js';
import { effectiveJevPolicy, type JevPolicy } from '../shared/policy.js';
import { ApiError } from './errors.js';
import { estimateJevTokens, JEV_STATE_TOKEN_LIMIT, type JevAnswer, type JevDecider, type JevQuestion } from './jev.js';

export interface FindDocumentationGapsInput {
  blocks: CanvasBlock[];
  apiKey: string;
  decider: JevDecider;
  policy?: Partial<JevPolicy>;
}

const concurrency = 6;
const gapInstructions = 'Does `state.document` depend on a concept, system, or procedure that none of the `state.catalog` titles appears to cover?';
const gapCriteria = { true: 'A named dependency has no apparent document in the title catalog', false: 'No missing documented dependency is apparent' };

async function mapLimited<T, U>(values: T[], limit: number, work: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index]);
    }
  }));
  return results;
}

function gapProbability(answers: Record<string, JevAnswer>, id: string): number {
  const answer = answers[id];
  if (answer?.type !== 'noul' || !Number.isFinite(answer.noul)) throw new ApiError(502, `Jev returned no gap probability for ${id}`);
  return answer.noul;
}

/** Shrinks the catalog of other titles so this document's question and state fit the token budget. */
function fitCatalog(otherTitles: string[], document: { title: string; excerpt: unknown }): string[] {
  const question: JevQuestion = { type: 'noul', instructions: gapInstructions, criteria: gapCriteria };
  const questionTokens = estimateJevTokens(question);
  for (let count = otherTitles.length; count >= 0; count--) {
    const catalog = otherTitles.slice(0, count);
    if (estimateJevTokens({ catalog, document }) + questionTokens <= JEV_STATE_TOKEN_LIMIT) return catalog;
  }
  return [];
}

/** Flag documents whose named dependencies have no apparent document in the catalog. One request per document; each document's own title is left out of its own catalog in code. */
export async function findDocumentationGaps(input: FindDocumentationGapsInput): Promise<InsightItem[]> {
  const policy = effectiveJevPolicy(input.policy);
  const blocks = input.blocks.filter(block => !block.archived);
  const titles = blocks.map(block => block.title);

  const results = await mapLimited(blocks, concurrency, async (block): Promise<InsightItem | undefined> => {
    const index = blocks.indexOf(block);
    const document = { title: block.title, excerpt: excerpt(documentText(block.content), { budget: 1500, focus: 'claims' }) };
    const otherTitles = titles.filter((_, otherIndex) => otherIndex !== index);
    const catalog = fitCatalog(otherTitles, document);
    const state = { catalog, document };
    const questionId = `d${index}_gap`;
    const questions: Record<string, JevQuestion> = { [questionId]: { type: 'noul', instructions: gapInstructions, criteria: gapCriteria } };
    const answers = await input.decider(input.apiKey, state, questions);
    const confidence = gapProbability(answers, questionId);
    if (confidence < policy.gap.show) return undefined;
    const source = document.excerpt;
    const evidenceText = [source.extracts, source.head, source.outline].find(value => value.trim()) ?? '';
    return { id: `gap-${block.id}`, category: 'gap', title: `Document a missing dependency for ${block.title}`,
      detail: 'This document may rely on a concept, system, or procedure that has no dedicated document. Draft it in chat.',
      blockIds: [block.id], confidence,
      evidence: [{ questionId, answer: String(confidence), excerpt: evidenceText.slice(0, 240) }] };
  });
  return results.filter((item): item is InsightItem => item !== undefined);
}
