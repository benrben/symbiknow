import type { JevJson, JevValues } from '../../../shared/jev-types.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { sourcePassages } from './source-passages.js';

type LogicalTopic = { name: string; confidence: number };
type LogicalIndex = { version: 1; topics: LogicalTopic[] };
type Entry = { document: JevInputDocument; content: string; title: string; signature: string;
  labels: string[]; logicalIndex: LogicalIndex | null; weights: Map<string, number>; magnitude: number };
type Index = { scope: string; entries: Entry[] };
export type GroupingNeighbor = { document: JevInputDocument; indexScore: number; sharedLabels: string[]; relations: string[] };
const indexes = new WeakMap<JevInputDocument, Index>();
const stopWords = new Set('a an and are as at be been but by for from has have in into is it its of on or that the their this to was were will with'.split(' '));
const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
const identity = (document: JevInputDocument) => `${document.canvasId}:${document.block.id}`;
function record(value: JevJson | undefined): value is JevValues { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function logicalIndex(context: JevEvaluationContext, document: JevInputDocument): LogicalIndex | null {
  const value = context.indexes?.[identity(document)];
  if (value?.version !== 1 || !Array.isArray(value.topics)) return null;
  const threshold = context.settings.confidenceThresholds?.profile ?? .7;
  const topics = value.topics.filter(record).flatMap(topic => typeof topic.name === 'string' && topic.name.trim()
    && typeof topic.confidence === 'number' && Number.isFinite(topic.confidence) && topic.confidence >= threshold && topic.confidence <= 1
    ? [{ name: topic.name.trim(), confidence: topic.confidence }] : []);
  return { version: 1, topics: [...new Map(topics.map(topic => [normalized(topic.name), topic])).values()].slice(0, 16) };
}
function labels(document: JevInputDocument): string[] {
  return [...new Map((document.block.tags ?? []).filter(label => label.trim()).map(label => [normalized(label), label.trim()])).values()];
}
function signature(context: JevEvaluationContext, document: JevInputDocument): string {
  return JSON.stringify([document.snapshot, document.block.tags, document.block.links, document.block.linkTypes,
    document.block.crossLinks, document.block.group, context.indexes?.[identity(document)], context.settings.confidenceThresholds?.profile]);
}
function allowedDocuments(context: JevEvaluationContext): JevInputDocument[] {
  const allowed = new Set(context.canvases.map(canvas => canvas.id));
  return context.documents.filter(document => document.snapshot.workspaceId === context.workspaceId
    && allowed.has(document.canvasId) && document.snapshot.canvasId === document.canvasId && document.snapshot.blockId === document.block.id
    && !document.block.archived && !document.block.processingExcluded && document.block.contentLoaded !== false);
}
function terms(text: string): string[] {
  return (normalized(text).match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(term => !stopWords.has(term));
}
function counts(document: JevInputDocument, logical: LogicalIndex | null, content: string): Map<string, number> {
  const result = new Map<string, number>();
  const add = (text: string, weight = 1) => { for (const term of terms(text)) result.set(term, (result.get(term) ?? 0) + weight); };
  add(document.block.title);
  for (const passage of sourcePassages(content)) add(passage.text);
  for (const topic of logical?.topics ?? []) add(topic.name, 3);
  return result;
}
function buildIndex(context: JevEvaluationContext, documents: JevInputDocument[], scope: string): Index {
  const entries = documents.map(document => {
    const logical = logicalIndex(context, document);
    const content = document.block.content;
    return { document, content, title: document.block.title, signature: signature(context, document),
      labels: labels(document), logicalIndex: logical, weights: counts(document, logical, content), magnitude: 0 };
  });
  const frequency = new Map<string, number>();
  for (const entry of entries) for (const term of entry.weights.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  for (const entry of entries) {
    for (const [term, count] of entry.weights) entry.weights.set(term, (1 + Math.log(count)) * (1 + Math.log((entries.length + 1) / (frequency.get(term)! + 1))));
    entry.magnitude = Math.sqrt([...entry.weights.values()].reduce((sum, value) => sum + value * value, 0));
  }
  return { scope, entries };
}
function index(context: JevEvaluationContext): Index {
  const documents = allowedDocuments(context);
  const scope = JSON.stringify([context.workspaceId, context.canvases.map(canvas => canvas.id).sort()]);
  const cacheKey = documents[0];
  const cached = cacheKey ? indexes.get(cacheKey) : undefined;
  if (cached?.scope === scope && cached.entries.length === documents.length && cached.entries.every((entry, position) => {
    const document = documents[position];
    return entry.document === document && entry.content === document.block.content && entry.title === document.block.title
      && entry.signature === signature(context, document);
  })) return cached;
  const next = buildIndex(context, documents, scope);
  if (cacheKey) indexes.set(cacheKey, next);
  return next;
}
function similarity(left: Entry, right: Entry): number {
  if (!left.magnitude || !right.magnitude) return 0;
  let dot = 0; for (const [term, weight] of left.weights) dot += weight * (right.weights.get(term) ?? 0);
  return Math.min(1, dot / (left.magnitude * right.magnitude));
}
function directedRelations(from: JevInputDocument, to: JevInputDocument, direction: string): string[] {
  const local = from.canvasId === to.canvasId && from.block.links.includes(to.block.id)
    ? [`${direction}:${from.block.linkTypes?.[to.block.id] ?? 'related'}`] : [];
  return [...local, ...(from.block.crossLinks ?? []).filter(link => link.canvasId === to.canvasId && link.blockId === to.block.id)
    .map(link => `${direction}:${link.relation ?? 'related'}`)];
}
function shared(left: string[], right: string[]): string[] {
  const keys = new Set(right.map(normalized)); return left.filter(value => keys.has(normalized(value)));
}
function rankedNeighbor(member: Entry, candidate: Entry) {
  const relations = [...new Set([...directedRelations(member.document, candidate.document, 'outgoing'),
    ...directedRelations(candidate.document, member.document, 'incoming')])];
  if (member.document.canvasId !== candidate.document.canvasId && !relations.length) return [];
  const indexScore = similarity(member, candidate);
  const sharedLabels = shared(member.labels, candidate.labels);
  const logicalMatches = shared(member.logicalIndex?.topics.map(topic => topic.name) ?? [], candidate.logicalIndex?.topics.map(topic => topic.name) ?? []);
  // Retrieval signals nominate candidates only. In particular, a link (including contradiction) is not group evidence.
  const rank = indexScore + Math.min(sharedLabels.length, 3) * .2 + Math.min(logicalMatches.length, 3) * .3 + Number(relations.length > 0) * .25;
  return rank > 0 ? [{ neighbor: { document: candidate.document, indexScore, sharedLabels, relations }, rank }] : [];
}
function memberEntry(value: Index, member: JevInputDocument): Entry | undefined {
  return value.entries.find(entry => entry.document === member);
}
/** Content-term similarity is retrieval, while validated Jev topics are the logical index signal. */
export function groupingSignals(context: JevEvaluationContext, member: JevInputDocument): { indexTerms: string[]; neighbors: GroupingNeighbor[] } {
  const value = index(context); const selected = memberEntry(value, member);
  if (!selected) return { indexTerms: [], neighbors: [] };
  const indexTerms = [...selected.weights].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 12).map(([term]) => term);
  const neighbors = value.entries.filter(entry => entry !== selected).flatMap(entry => rankedNeighbor(selected, entry))
    .sort((left, right) => right.rank - left.rank || identity(left.neighbor.document).localeCompare(identity(right.neighbor.document)))
    .map(item => item.neighbor);
  return { indexTerms, neighbors };
}
/** Small scoped provider projection. Exact neighbor source snapshots remain on groupingSignals(). */
export function groupingSignalState(context: JevEvaluationContext, member: JevInputDocument) {
  const value = index(context); const selected = memberEntry(value, member);
  const signals = groupingSignals(context, member);
  return { indexTerms: signals.indexTerms, labels: selected?.labels.slice() ?? [],
    logicalIndex: selected?.logicalIndex ? { version: 1, topics: selected.logicalIndex.topics.map(topic => ({ ...topic })) } : null,
    neighbors: signals.neighbors.slice(0, 8).map(neighbor => ({ canvasId: neighbor.document.canvasId, blockId: neighbor.document.block.id,
      title: neighbor.document.block.title, indexScore: neighbor.indexScore, sharedLabels: neighbor.sharedLabels, relations: neighbor.relations,
      group: neighbor.document.block.group ?? null, logicalTopics: logicalIndex(context, neighbor.document)?.topics ?? [] })) };
}
