import type { JevJson, JevPassage, JevValues } from '../../../shared/jev-types.js';
import { plainGroupName } from '../../../shared/names.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { childGroupKey, membershipGroupKey, vocabularyGroupKey } from './groups.js';
import { groupLabel, normalizedGroup, validGroupKey } from '../../../shared/groups.js';
import { sameJevSource } from '../stamps.js';
import { groupingSignals, type GroupingNeighbor } from './group-signals.js';
import { sourcePassages, type SourcePassage } from './source-passages.js';
import { sharedSourceCategories } from './source-categories.js';

export type ProposedGroup = { name: string; key: string; parent?: { name: string; key: string }; origins: JevPassage[] };
type TopicSource = { document: JevInputDocument; groups: ProposedGroup[]; logicalKeys: string[]; text: string };
type RankedTopic = { group: ProposedGroup; rank: number; reusable: boolean };

function sourceGroups(document: JevInputDocument, available: SourcePassage[]): ProposedGroup[] {
  const headings = available.slice(0, 40).flatMap(source => {
    const name = plainGroupName(source.text.replace(/\s+#+$/, ''));
    const passage = { source: document.snapshot, start: source.start, end: source.end, quote: source.quote };
    return source.headingLevel > 0 && source.headingLevel <= 2 && name.length >= 2 && name.length <= 80
      ? [{ level: source.headingLevel, name, passage }] : [];
  });
  const nested: ProposedGroup[] = [];
  let parent: { name: string; key: string; passage: JevPassage } | undefined;
  for (const heading of headings) {
    if (heading.level === 1) { parent = { name: heading.name, key: membershipGroupKey(heading.name), passage: heading.passage }; continue; }
    if (parent) nested.push({ name: `${parent.name} / ${heading.name}`, key: childGroupKey(parent.key, heading.name),
      parent: { name: parent.name, key: parent.key }, origins: [parent.passage, heading.passage] });
  }
  const roots = headings.filter(heading => heading.level === 1)
    .map(heading => ({ name: heading.name, key: membershipGroupKey(heading.name), origins: [heading.passage] }));
  const names = [...(document.block.tags ?? []), document.block.title].map(plainGroupName).filter(name => name.length >= 2);
  const labels = names.map(name => ({ name, key: membershipGroupKey(name),
    origins: available.filter(passage => passage.text.includes(name)).slice(0, 2)
      .map(({ start, end, quote }) => ({ source: document.snapshot, start, end, quote })) }));
  return mergedSourceGroups([...roots, ...nested, ...labels]).slice(0, 8);
}

/** Heading, title and tag nominations share one document; preserve each distinct verified source passage. */
function mergedSourceGroups(groups: ProposedGroup[]): ProposedGroup[] {
  const merged = new Map<string, ProposedGroup>();
  for (const group of groups) {
    const previous = merged.get(group.key);
    if (!previous) { merged.set(group.key, group); continue; }
    const origins = [...new Map([...previous.origins, ...group.origins]
      .map(passage => [`${passage.start}:${passage.end}`, passage])).values()];
    merged.set(group.key, { ...group, name: previous.name, origins });
  }
  return [...merged.values()];
}

function visibleText(available: SourcePassage[]): string {
  return available.map(passage => passage.text).join(' ').slice(0, 5000).toLocaleLowerCase();
}

function topicSource(context: JevEvaluationContext, document: JevInputDocument): TopicSource {
  const available = sourcePassages(document.block.content);
  const logical = logicalGroups(context, document, available);
  return { document, groups: mergedSourceGroups([...nativeGroups(context, document, available), ...logical, ...sourceGroups(document, available)]),
    logicalKeys: logical.map(group => group.key), text: visibleText(available) };
}
function record(value: JevJson): value is JevValues { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function topicConfidence(topic: JevValues, threshold: number): boolean {
  return typeof topic.confidence === 'number' && Number.isFinite(topic.confidence)
    && topic.confidence >= threshold && topic.confidence <= 1;
}
function logicalTopicShape(topic: JevValues): topic is JevValues & { name: string; evidence: JevJson[] } {
  return typeof topic.name === 'string' && Array.isArray(topic.evidence);
}
function validTopicName(name: string): boolean { return name.length >= 2 && name.length <= 80; }
function logicalGroup(topic: JevValues, context: JevEvaluationContext, document: JevInputDocument,
  available: SourcePassage[]): ProposedGroup[] {
  if (!logicalTopicShape(topic) || !topicConfidence(topic, context.settings.confidenceThresholds?.profile ?? .7)) return [];
  const name = plainGroupName(topic.name);
  if (!validTopicName(name)) return [];
  const origins = topic.evidence.filter(record).flatMap(evidence => exactIndexOrigin(document, available, evidence));
  return origins.length ? [{ name, key: membershipGroupKey(name), origins }] : [];
}
function logicalGroups(context: JevEvaluationContext, document: JevInputDocument, available: SourcePassage[]): ProposedGroup[] {
  const index = context.indexes?.[`${document.canvasId}:${document.block.id}`];
  if (index?.version !== 1 || !Array.isArray(index.topics)) return [];
  return index.topics.filter(record).flatMap(topic => logicalGroup(topic, context, document, available)).slice(0, 8);
}
function exactIndexOrigin(document: JevInputDocument, available: SourcePassage[], evidence: JevValues): JevPassage[] {
  if (!evidence.source || !record(evidence.source)) return [];
  const source = evidence.source;
  const fields = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'] as const;
  if (!fields.every(key => source[key] === document.snapshot[key])) return [];
  const passage = available.find(item => item.start === evidence.start && item.end === evidence.end && item.quote === evidence.quote);
  return passage ? [{ source: document.snapshot, start: passage.start, end: passage.end, quote: passage.quote }] : [];
}
function nativeGroups(context: JevEvaluationContext, document: JevInputDocument, available: SourcePassage[]): ProposedGroup[] {
  if (!validGroupKey(document.block.group)) return [];
  const key = normalizedGroup(document.block.group)!;
  const definition = context.canvases.find(canvas => canvas.id === document.canvasId)?.groups?.find(group => normalizedGroup(group.id) === key);
  const term = context.vocabulary.find(term => term.kind === 'group' && vocabularyGroupKey(term) === key);
  // Existing membership nominates its original native name; these quotes do not authorize a new member.
  return [{ key, name: definition?.name ?? term?.name ?? groupLabel(key), origins: available.slice(0, 2)
    .map(({ start, end, quote }) => ({ source: document.snapshot, start, end, quote })) }];
}


function mentions(text: string, group: { name: string }): boolean {
  return group.name.split(' / ').every(name => text.includes(name.toLocaleLowerCase()));
}

function rankedTopic(group: ProposedGroup, texts: string[]): RankedTopic {
  const recurring = texts.filter(text => mentions(text, group)).length;
  return { group, rank: Number(recurring < 2) * 1000 + Number(Boolean(group.parent)) * 100 - recurring,
    reusable: !group.key.includes('/') || recurring >= 2 };
}

/** A section heading becomes a subgroup only when it describes multiple local sources. */
export function reusableGroup(context: JevEvaluationContext, member: JevInputDocument, group: { key: string; name: string }): boolean {
  if (!group.key.includes('/')) return true;
  const scoped = catalogContext(context, member);
  if (!scoped) return false;
  const texts = catalogDocuments(scoped, member, groupingSignals(scoped, member).neighbors).map(document => visibleText(sourcePassages(document.block.content)));
  return texts.filter(text => mentions(text, group)).length >= 2;
}

/** Neighbor quotes nominate candidates; only the member's own evidence can justify placement. */
export function canvasTopicCatalog(context: JevEvaluationContext, member: JevInputDocument): ProposedGroup[] {
  const scoped = catalogContext(context, member);
  if (!scoped) return [];
  const signals = groupingSignals(scoped, member).neighbors;
  const documents = catalogDocuments(scoped, member, signals);
  const categories = sharedSourceCategories(documents, member);
  const catalog = new Map<string, ProposedGroup>(categories
    .map(category => [membershipGroupKey(category.name), { name: category.name, key: membershipGroupKey(category.name), origins: category.origins }]));
  const sources = documents.map(document => topicSource(scoped, document));
  const relevant = new Set(signals.filter(signal => signal.indexScore >= .15 || signal.sharedLabels.length || signal.relations.length)
    .map(signal => signal.document));
  const memberText = sources.find(source => source.document === member)!.text;
  addSourceGroups(catalog, sources, member, relevant, memberText);
  const texts = sources.map(source => source.text);
  const ranked = [...catalog.values()].map(group => scoredTopic(group, sources, texts, signals)).filter(topic => topic.reusable);
  const sharedRoots = sharedRootKeys(sources, member, categories.map(category => membershipGroupKey(category.name)));
  const manual = manualGroupKeys(sources);
  const eligible = sharedRoots.size ? ranked.filter(topic => sharedRoots.has(topic.group.key) || manual.has(topic.group.key)) : ranked;
  return retainedTopics(eligible, memberGroups(sources, member)).map(group => ({ ...group, origins: uniqueOrigins(group.origins).slice(0, 4) }));
}
function addSourceGroups(catalog: Map<string, ProposedGroup>, sources: TopicSource[], member: JevInputDocument,
  relevant: Set<JevInputDocument>, memberText: string): void {
  for (const source of sources) for (const group of source.groups) {
    if (includeSourceGroup(source, group, member, relevant, memberText)) mergeCatalogGroup(catalog, group);
  }
}
function includeSourceGroup(source: TopicSource, group: ProposedGroup, member: JevInputDocument,
  relevant: Set<JevInputDocument>, memberText: string): boolean {
  if (source.document === member) return true;
  return Boolean(group.origins.length && (relevant.has(source.document) || mentions(memberText, group)));
}
function mergeCatalogGroup(catalog: Map<string, ProposedGroup>, group: ProposedGroup): void {
  const existing = catalog.get(group.key);
  if (existing) existing.origins.push(...group.origins);
  else catalog.set(group.key, { ...group, origins: [...group.origins] });
}
function scoredTopic(group: ProposedGroup, sources: TopicSource[], texts: string[], signals: GroupingNeighbor[]): RankedTopic {
  const topic = rankedTopic(group, texts);
  const logicalSupport = sources.filter(source => source.logicalKeys.includes(group.key)).length;
  const signalSupport = signals.filter(signal => group.origins.some(origin => origin.source.canvasId === signal.document.canvasId
    && origin.source.blockId === signal.document.block.id)).reduce((best, signal) => Math.max(best,
    signal.indexScore + signal.sharedLabels.length * .2 + Number(signal.relations.length > 0) * 2), 0);
  return { ...topic, rank: topic.rank - logicalSupport * 2000 - signalSupport };
}
/** Repeated visible categories and independently checked topic meanings nominate shared roots.
 * Do not offer private title folders alongside them; the provider can still reject every shared option. */
function sharedRootKeys(sources: TopicSource[], member: JevInputDocument, categoryKeys: string[]): Set<string> {
  const ownTopics = sources.find(source => source.document === member)!.logicalKeys;
  const indexed = ownTopics.filter(key => !key.includes('/') && sources.filter(source => source.logicalKeys.includes(key)).length > 1);
  return new Set([...categoryKeys, ...indexed]);
}
function manualGroupKeys(sources: TopicSource[]): Set<string> {
  return new Set(sources.flatMap(({ document }) => {
    const { group, jevOwnership } = document.block;
    const manual = jevOwnership?.pins.includes('group') || !jevOwnership?.managed.includes('group');
    return validGroupKey(group) && manual ? [normalizedGroup(group)!] : [];
  }));
}
function uniqueOrigins(origins: JevPassage[]): JevPassage[] {
  return [...new Map(origins.map(origin => [`${origin.source.canvasId}:${origin.source.blockId}:${origin.start}:${origin.end}`, origin])).values()];
}
function catalogContext(context: JevEvaluationContext, member: JevInputDocument): JevEvaluationContext | undefined {
  const allowed = (document: JevInputDocument) => catalogIdentityValid(context, document)
    && (!document.block.archived || document === member) && !document.block.processingExcluded;
  if (!allowed(member)) return undefined;
  const documents = context.documents.filter(allowed);
  const position = documents.findIndex(document => document.canvasId === member.canvasId && document.block.id === member.block.id);
  if (position < 0) documents.push(member);
  else {
    if (!sameJevSource(documents[position].snapshot, member.snapshot)) return undefined;
    documents[position] = member;
  }
  return { ...context, documents };
}
function catalogIdentityValid(context: JevEvaluationContext, document: JevInputDocument): boolean {
  return document.snapshot.workspaceId === context.workspaceId
    && document.snapshot.canvasId === document.canvasId && document.snapshot.blockId === document.block.id
    && context.canvases.some(canvas => canvas.id === document.canvasId);
}
function catalogDocuments(context: JevEvaluationContext, member: JevInputDocument, signals: GroupingNeighbor[]): JevInputDocument[] {
  const linked = new Set(signals.filter(signal => signal.relations.length).map(signal => signal.document));
  return context.documents.filter(document => document.canvasId === member.canvasId || linked.has(document));
}

function memberGroups(sources: TopicSource[], member: JevInputDocument): ProposedGroup[] {
  return sources.find(source => source.document === member)!.groups;
}

function retainedTopics(topics: RankedTopic[], groups: ProposedGroup[]): ProposedGroup[] {
  const localKeys = new Set(groups.map(group => group.key));
  const ranked = topics.sort((left, right) => left.rank - right.rank);
  const local = ranked.filter(topic => localKeys.has(topic.group.key));
  const neighbors = ranked.filter(topic => !localKeys.has(topic.group.key)).slice(0, 24 - local.length);
  return [...local, ...neighbors].sort((left, right) => left.rank - right.rank).map(topic => topic.group);
}
