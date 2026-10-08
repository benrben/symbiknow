import type { JevJson, JevPassage, JevSourceSnapshot, JevValues } from '../../../shared/jev-types.js';
import { choice, noul, type JevAnswer, type JevQuestion } from '../../jev.js';
import { evidenceCandidates, exactEvidence, json, semanticThreshold, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { sharedSourceCategories } from './source-categories.js';
import { readablePassage, semanticHeadingNames } from './source-passages.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { topicCategoryCandidates } from './topic-category-candidates.js';

export type TopicCandidate = { name: string; origin: string; definition?: string };

export function logicalTopicCandidateOrigins(context: JevEvaluationContext, document: JevInputDocument): TopicCandidate[] {
  if (document.snapshot.workspaceId !== context.workspaceId || document.block.processingExcluded) return [];
  const shared = sharedSourceCategories(context.documents, document)
    .sort((left, right) => right.sources.length - left.sources.length || left.name.localeCompare(right.name));
  const names: TopicCandidate[] = [...shared.map(category => ({ name: category.name, origin: 'shared_source_phrase' })),
    ...topicCategoryCandidates(context, document),
    ...semanticHeadingNames(document.block.content).map(name => ({ name, origin: 'source_heading' })),
    ...(document.block.tags ?? []).map(name => ({ name, origin: 'existing_label' })),
    { name: document.block.title, origin: 'document_title' }];
  return uniqueTopics(names);
}
function uniqueTopics(names: TopicCandidate[]): TopicCandidate[] {
  const unique = new Map<string, TopicCandidate>();
  for (const raw of names) {
    const candidate = normalizedTopic(raw);
    if (!candidate) continue;
    const key = candidate.name.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, candidate);
    if (unique.size === 16) break;
  }
  return [...unique.values()];
}
function normalizedTopic(candidate: TopicCandidate): TopicCandidate | undefined {
  const name = readablePassage(candidate.name).normalize('NFKC').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 80 ? { ...candidate, name } : undefined;
}

/** Candidate names nominate topics only; profile's existing provider round must validate their meaning and exact evidence. */
export function logicalIndexQuestions(context: JevEvaluationContext, document: JevInputDocument, nominated?: readonly TopicCandidate[]): {
  state: JevValues; questions: Record<string, JevQuestion>;
} {
  const topics = nominated ?? logicalTopicCandidateOrigins(context, document);
  const questions: Record<string, JevQuestion> = {};
  topics.forEach((topic, index) => {
    const subject = `logicalTopicCandidates[${index}]: ${JSON.stringify(topic.name)}${topic.definition ? `; scope: ${topic.definition}` : ''}`;
    questions[`logicalTopic_${index}`] = noul(`Is ${subject} a main substantive topic of document passages, rather than a passing mention, incidental heading, or administrative tag? Broad categories contain documents about their scope; the source need not define the category.`);
    questions[`logicalTopicEvidence_${index}`] = choice(`Which exact document passage supports ${subject} as a main substantive topic? Choose none if the supplied passages do not establish that topic.`, evidenceCandidates(document));
  });
  return { state: { logicalTopicCandidates: json(topics.map(({ name, definition }) => definition ? { name, definition } : { name })) }, questions };
}

export function logicalIndexResult(context: JevEvaluationContext, document: JevInputDocument,
  answers: Record<string, JevAnswer>, nominated?: readonly TopicCandidate[]): JevValues {
  const topics = (nominated ?? logicalTopicCandidateOrigins(context, document)).flatMap((topic, index) => {
    const support = answers[`logicalTopic_${index}`];
    if (!validatedTopicSupport(support, context)) return [];
    const evidence = exactEvidence(document, answers[`logicalTopicEvidence_${index}`]);
    return evidence.length ? [{ name: topic.name, ...(topic.definition ? { definition: topic.definition, origin: topic.origin } : {}), confidence: calibrated(support.noul, decisionBoundaries.topicMembership), evidence: json(evidence) }] : [];
  });
  const decisions = (nominated ?? logicalTopicCandidateOrigins(context, document)).flatMap((topic, index) => {
    const value = topicMembershipConfidence(answers[`logicalTopic_${index}`]);
    return value === undefined ? [] : [{ name: topic.name, confidence: value,
      ...(topic.definition ? { definition: topic.definition } : {}) }];
  });
  return { version: 1, calibration: 1, source: json(document.snapshot), topics, decisions };
}
export function topicMembershipConfidence(answer: JevAnswer | undefined): number | undefined {
  return answer?.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1
    ? calibrated(answer.noul, decisionBoundaries.topicMembership) : undefined;
}
function validatedTopicSupport(answer: JevAnswer | undefined, context: JevEvaluationContext): answer is JevAnswer & { noul: number } {
  const value = topicMembershipConfidence(answer);
  return value !== undefined && value >= semanticThreshold(context);
}

export type FreshProfileTopic = { name: string; confidence: number; evidence: JevPassage[]; definition?: string };
const bodyFields = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'] as const;
function record(value: JevJson | undefined): value is JevValues { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function currentBody(value: JevJson | undefined, source: JevSourceSnapshot): boolean {
  return record(value) && bodyFields.every(field => value[field] === source[field]);
}
function validProbability(value: JevJson | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function nonnegativeOffset(value: JevJson | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function passageBounds(item: JevValues, length: number): item is JevValues & { start: number; end: number } {
  if (!nonnegativeOffset(item.start) || !nonnegativeOffset(item.end)) return false;
  return item.end > item.start && item.end <= length;
}
function checkedPassage(item: JevValues, document: JevInputDocument): JevPassage[] {
  if (!currentBody(item.source, document.snapshot) || typeof item.quote !== 'string') return [];
  if (!passageBounds(item, document.block.content.length)) return [];
  if (document.block.content.slice(item.start, item.end) !== item.quote) return [];
  return [{ source: { ...document.snapshot }, start: item.start, end: item.end, quote: item.quote }];
}
function checkedEvidence(value: JevJson | undefined, document: JevInputDocument): JevPassage[] {
  return Array.isArray(value) ? value.filter(record).flatMap(item => checkedPassage(item, document)) : [];
}
function forbiddenLabelNames(context: JevEvaluationContext, document: JevInputDocument): Set<string> {
  const retired = context.vocabulary.filter(term => term.kind === 'label' && term.state === 'retired')
    .flatMap(term => [term.name, ...term.aliases]);
  return new Set([...(document.block.jevOwnership?.removedLabels ?? []), ...retired].map(name => name.toLocaleLowerCase()));
}
function namedTopic(value: JevJson): value is JevValues & { name: string } {
  return record(value) && typeof value.name === 'string' && value.name.trim().length >= 2;
}
function checkedProfileTopic(value: JevJson, document: JevInputDocument): FreshProfileTopic | undefined {
  if (!namedTopic(value)) return undefined;
  if (!validProbability(value.confidence)) return undefined;
  const evidence = checkedEvidence(value.evidence, document);
  if (!evidence.length) return undefined;
  return { name: value.name, confidence: value.confidence, evidence,
    ...(typeof value.definition === 'string' ? { definition: value.definition } : {}) };
}
function activeLabelDefinitionMatches(context: JevEvaluationContext, name: string, definition: JevJson | undefined): boolean {
  const term = context.vocabulary.find(term => term.kind === 'label' && term.state === 'active' && term.name === name);
  return !term || term.definition === definition;
}
function currentCalibratedIndex(index: JevValues | undefined, document: JevInputDocument): boolean {
  return index?.version === 1 && index.calibration === 1 && currentBody(index.source, document.snapshot);
}
function excludedProfileTopic(topic: FreshProfileTopic, forbidden: Set<string>): boolean {
  return topic.name.length > 40 || forbidden.has(topic.name.toLocaleLowerCase());
}
function storedProfileTopics(context: JevEvaluationContext, document: JevInputDocument): JevJson[] | undefined {
  const index = context.indexes?.[`${document.canvasId}:${document.block.id}`];
  return currentCalibratedIndex(index, document) && Array.isArray(index?.topics) ? index.topics : undefined;
}
/** Reuse only calibrated profile judgments with exact evidence from the same source body. */
export function freshProfileTopics(context: JevEvaluationContext, document: JevInputDocument): FreshProfileTopic[] | undefined {
  const storedTopics = storedProfileTopics(context, document);
  if (!storedTopics) return undefined;
  const forbidden = forbiddenLabelNames(context, document);
  const topics: FreshProfileTopic[] = [];
  for (const value of storedTopics) {
    const topic = checkedProfileTopic(value, document);
    if (!topic) return undefined;
    if (excludedProfileTopic(topic, forbidden)) continue;
    // Compare the original stored definition before omitting non-string optional data.
    if (!activeLabelDefinitionMatches(context, topic.name, (value as JevValues).definition)) return undefined;
    topics.push({ ...topic, name: topic.name.trim() });
  }
  return topics;
}

function profileRejection(context: JevEvaluationContext, current: Set<string>, decision: JevValues) {
  if (typeof decision.name !== 'string' || !current.has(decision.name)) return [];
  if (!validProbability(decision.confidence)) return [];
  if (1 - decision.confidence < semanticThreshold(context)) return [];
  if (!activeLabelDefinitionMatches(context, decision.name, decision.definition)) return [];
  return [{ name: decision.name, confidence: 1 - decision.confidence }];
}
/** Negative profile decisions preserve label removal checks without repeating a fresh judgment. */
export function freshProfileLabelRejections(context: JevEvaluationContext, document: JevInputDocument) {
  const index = context.indexes?.[`${document.canvasId}:${document.block.id}`];
  if (index?.calibration !== 1 || !currentBody(index.source, document.snapshot) || !Array.isArray(index.decisions)) return [];
  const current = new Set(document.block.tags ?? []);
  return index.decisions.filter(record).flatMap(decision => profileRejection(context, current, decision));
}
