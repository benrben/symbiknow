import type { JevJson, JevPassage, JevValues } from '../../../shared/jev-types.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { plainGroupName } from '../../../shared/names.js';
import { sourcePassages, type SourcePassage } from './source-passages.js';

export interface SharedSourceCategory { name: string; sources: JevInputDocument[]; origins: JevPassage[] }
export interface SourceSubject { name: string; origins: JevPassage[]; bodyEvidence: JevPassage[] }
type CategoryPassage = { name: string; origin: JevPassage };
type CategorySource = { document: JevInputDocument; passages: SourcePassage[]; parent: string; signature: string };

function categoryPassages(source: CategorySource, sharedParents: Set<string>): CategoryPassage[] {
  const { document } = source;
  const found = new Map<string, CategoryPassage>();
  for (const passage of source.passages) {
    const name = categoryName(source, passage, sharedParents);
    if (!usableName(name)) continue;
    const key = name.toLocaleLowerCase();
    if (found.has(key)) continue;
    found.set(key, { name, origin: { source: document.snapshot, start: passage.start, end: passage.end, quote: passage.quote } });
  }
  return [...found.values()];
}
function manualLabels(document: JevInputDocument): boolean {
  if (!document.block.tags?.length) return false;
  return !document.block.jevOwnership || document.block.jevOwnership.pins.includes('tags');
}
function categoryName(source: CategorySource, passage: SourcePassage, sharedParents: Set<string>): string {
  if (passage.text.includes('·')) return plainGroupName(passage.text.split('·')[0]);
  if (passage.headingLevel !== 2 || manualLabels(source.document) || sharedParents.has(source.parent)) return '';
  return plainGroupName(passage.text);
}
function categorySource(document: JevInputDocument): CategorySource {
  const passages = sourcePassages(document.block.content).slice(0, 12);
  const parent = plainGroupName(passages.find(passage => passage.headingLevel === 1)?.text ?? '').toLocaleLowerCase();
  return { document, passages, parent, signature: JSON.stringify(passages.map(passage => passage.text)) };
}
function sharedParentNames(sources: CategorySource[]): Set<string> {
  const parents = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!source.parent) continue;
    const signatures = parents.get(source.parent) ?? new Set<string>();
    signatures.add(source.signature); parents.set(source.parent, signatures);
  }
  return new Set([...parents].filter(([, signatures]) => signatures.size > 1).map(([name]) => name));
}
function usableName(name: string): boolean { return name.length >= 2 && name.length <= 40; }
function localSource(document: JevInputDocument, member: JevInputDocument): boolean {
  return document.canvasId === member.canvasId && document.snapshot.workspaceId === member.snapshot.workspaceId
    && !document.block.archived && !document.block.processingExcluded;
}
function appendCategory(categories: Map<string, SharedSourceCategory>, document: JevInputDocument, passage: CategoryPassage): void {
  const key = passage.name.toLocaleLowerCase();
  const category = categories.get(key) ?? { name: passage.name, sources: [], origins: [] };
  category.sources.push(document); category.origins.push(passage.origin); categories.set(key, category);
}
/** Repeated visible category captions nominate a topic; provider confidence and each member's own purpose still authorize filing. */
export function sharedSourceCategories(documents: JevInputDocument[], member: JevInputDocument): SharedSourceCategory[] {
  const categories = new Map<string, SharedSourceCategory>();
  const sources = documents.filter(source => localSource(source, member)).map(categorySource);
  const sharedParents = sharedParentNames(sources);
  for (const source of sources) {
    for (const passage of categoryPassages(source, sharedParents)) appendCategory(categories, source.document, passage);
  }
  return [...categories.values()].filter(category => category.sources.length > 1
    && category.sources.some(source => source.block.id === member.block.id))
    .sort((left, right) => right.sources.length - left.sources.length);
}

function object(value: JevJson | undefined): value is JevValues {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function calibratedSubjectIndex(index: JevValues | undefined): index is JevValues & { source: JevValues } {
  return index?.version === 1 && index.calibration === 1 && object(index.source);
}
function currentSubjectIndex(context: JevEvaluationContext, document: JevInputDocument): JevValues | undefined {
  const index = context.indexes?.[`${document.canvasId}:${document.block.id}`];
  if (!calibratedSubjectIndex(index)) return undefined;
  const source = index.source;
  const fields = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'] as const;
  return fields.every(field => source[field] === document.snapshot[field]) ? index : undefined;
}
function exactSubjectEvidence(document: JevInputDocument, available: SourcePassage[], evidence: JevValues): SourcePassage[] {
  if (!object(evidence.source)) return [];
  const source = evidence.source;
  const fields = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'] as const;
  if (!fields.every(field => source[field] === document.snapshot[field])) return [];
  return available.filter(passage => passage.start === evidence.start && passage.end === evidence.end && passage.quote === evidence.quote);
}
function acceptedSubject(context: JevEvaluationContext, topic: JevValues): boolean {
  return typeof topic.confidence === 'number' && Number.isFinite(topic.confidence)
    && topic.confidence >= (context.settings.confidenceThresholds?.profile ?? .7) && topic.confidence <= 1;
}
function subjectCandidate(topic: JevValues): { name: string; evidence: JevJson[] } | undefined {
  if (typeof topic.name !== 'string' || !Array.isArray(topic.evidence)) return undefined;
  const name = plainGroupName(topic.name);
  return name.length >= 2 && name.length <= 80 ? { name, evidence: topic.evidence } : undefined;
}
function subjectTopic(context: JevEvaluationContext, document: JevInputDocument,
  available: SourcePassage[], topic: JevValues): SourceSubject[] {
  const candidate = subjectCandidate(topic);
  if (!candidate || !acceptedSubject(context, topic)) return [];
  const { name } = candidate;
  const checked = candidate.evidence.filter(object).flatMap(evidence => exactSubjectEvidence(document, available, evidence));
  const subject = checked.filter(passage => passage.headingLevel === 0
    || passage.headingLevel === 1 && plainGroupName(passage.text) === name);
  if (!subject.length) return [];
  const body = available.find(passage => passage.headingLevel === 0);
  if (!body) return [];
  const origins = [...new Map([...subject, body].map(passage => [`${passage.start}:${passage.end}`, {
    source: document.snapshot, start: passage.start, end: passage.end, quote: passage.quote,
  }])).values()];
  const bodyEvidence = checked.filter(passage => passage.headingLevel === 0)
    .map(passage => ({ source: document.snapshot, start: passage.start, end: passage.end, quote: passage.quote }));
  return [{ name, origins, bodyEvidence }];
}
/** Checked main subjects nominate reusable taxonomy; semantic validation still authorizes every placement. */
export function sourceSubjects(context: JevEvaluationContext, document: JevInputDocument): SourceSubject[] {
  const index = currentSubjectIndex(context, document);
  if (!Array.isArray(index?.topics)) return [];
  const available = sourcePassages(document.block.content);
  const heading = plainGroupName(available.find(passage => passage.headingLevel === 1)?.text ?? '');
  return index.topics.filter(object).flatMap(topic => subjectTopic(context, document, available, topic))
    .sort((left, right) => Number(right.name === heading) - Number(left.name === heading)).slice(0, 8);
}
