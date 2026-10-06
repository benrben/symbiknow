import type { JevValues } from '../../../shared/jev-types.js';
import { choice, noul, type JevAnswer, type JevQuestion } from '../../jev.js';
import { evidenceCandidates, exactEvidence, json, supported, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { sharedSourceCategories } from './source-categories.js';
import { readablePassage, semanticHeadingNames } from './source-passages.js';

export function logicalTopicCandidateOrigins(context: JevEvaluationContext, document: JevInputDocument): Array<{ name: string; origin: string }> {
  if (document.snapshot.workspaceId !== context.workspaceId || document.block.processingExcluded) return [];
  const shared = sharedSourceCategories(context.documents, document)
    .sort((left, right) => right.sources.length - left.sources.length || left.name.localeCompare(right.name));
  const names = [...shared.map(category => ({ name: category.name, origin: 'shared_source_phrase' })),
    ...semanticHeadingNames(document.block.content).map(name => ({ name, origin: 'source_heading' })),
    ...(document.block.tags ?? []).map(name => ({ name, origin: 'existing_label' })),
    { name: document.block.title, origin: 'document_title' }];
  const unique = new Map<string, { name: string; origin: string }>();
  for (const candidate of names) {
    const name = readablePassage(candidate.name).normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 80) continue;
    const key = name.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, { name, origin: candidate.origin });
    if (unique.size === 16) break;
  }
  return [...unique.values()];
}
function topicNames(context: JevEvaluationContext, document: JevInputDocument): string[] {
  return logicalTopicCandidateOrigins(context, document).map(candidate => candidate.name);
}

/** Candidate names nominate topics only; profile's existing provider round must validate their meaning and exact evidence. */
export function logicalIndexQuestions(context: JevEvaluationContext, document: JevInputDocument): {
  state: JevValues; questions: Record<string, JevQuestion>;
} {
  const names = topicNames(context, document);
  const questions: Record<string, JevQuestion> = {};
  names.forEach((_, index) => {
    questions[`logicalTopic_${index}`] = noul(`Is logicalTopicCandidates[${index}].name a main substantive topic of document passages, rather than a passing mention, incidental heading, or administrative tag?`);
    questions[`logicalTopicEvidence_${index}`] = choice(`Which exact document passage supports logicalTopicCandidates[${index}].name as a main substantive topic? Choose none if the supplied passages do not establish that topic.`, evidenceCandidates(document));
  });
  return { state: { logicalTopicCandidates: names.map(name => ({ name })) }, questions };
}

export function logicalIndexResult(context: JevEvaluationContext, document: JevInputDocument,
  answers: Record<string, JevAnswer>): JevValues {
  const topics = topicNames(context, document).flatMap((name, index) => {
    const support = answers[`logicalTopic_${index}`];
    if (support?.type !== 'noul' || !Number.isFinite(support.noul) || support.noul > 1 || !supported(support, context)) return [];
    const evidence = exactEvidence(document, answers[`logicalTopicEvidence_${index}`]);
    return evidence.length ? [{ name, confidence: support.noul, evidence: json(evidence) }] : [];
  });
  return { version: 1, topics };
}
