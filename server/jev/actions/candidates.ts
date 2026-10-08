import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { sourcePassages } from './source-passages.js';

export function terms(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}
export function lexicalScore(query: string, content: string): number {
  return scoreTerms(terms(query), content);
}
function scoreTerms(required: Set<string>, content: string): number {
  if (!required.size) return 0;
  const available = terms(content);
  return [...required].filter(term => available.has(term)).length / required.size;
}
function knowledgeText(content: string): string {
  return sourcePassages(content).map(passage => passage.text).join(' ');
}
const commonWords = new Set(['a', 'about', 'after', 'all', 'also', 'an', 'and', 'are', 'as', 'at', 'before',
  'be', 'by', 'can', 'do', 'each', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'may',
  'of', 'on', 'or', 'our', 'should', 'that', 'the', 'their', 'these', 'this', 'to', 'use', 'using', 'was',
  'were', 'when', 'which', 'will', 'with']);
function meaningTerms(text: string): Set<string> {
  return new Set([...terms(text)].filter(term => !commonWords.has(term)));
}
function intersectionSize(left: Set<string>, right: Set<string>): number {
  return [...left].filter(term => right.has(term)).length;
}
function referenceWords(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}
function bodyReferencePhrases(content: string): Set<string> {
  return new Set(sourcePassages(content).filter(passage => passage.headingLevel === 0).flatMap(passage => {
    const words = referenceWords(passage.text);
    return words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`);
  }));
}
function referencedTitle(phrases: Set<string>, title: string): boolean {
  const words = referenceWords(title).filter(word => !commonWords.has(word));
  // A body phrase may omit a title qualifier: "SSO review" names "SSO security review".
  // This only nominates a bounded pair; typed evidence still determines whether an edge exists.
  return words.some((word, index) => words.slice(index + 1).some(next => phrases.has(`${word} ${next}`)));
}
function existingLink(source: JevInputDocument, target: JevInputDocument): boolean {
  return (source.canvasId === target.canvasId && source.block.links.includes(target.block.id))
    || (source.block.crossLinks ?? []).some(link => link.canvasId === target.canvasId && link.blockId === target.block.id);
}
function substantiveOverlap(overlap: number, coverage: number, sourceTopicInTarget: boolean): boolean {
  return overlap >= 3 && coverage >= .08 && (sourceTopicInTarget || overlap >= 5);
}
export function neighbors(context: JevEvaluationContext, source: JevInputDocument, limit = 5): JevInputDocument[] {
  const query = `${source.block.title} ${(source.block.tags ?? []).join(' ')} ${knowledgeText(source.block.content).slice(0, 1800)}`;
  const required = terms(query);
  return context.documents.filter(document => document.snapshot.workspaceId === context.workspaceId)
    .filter(document => document.block.id !== source.block.id || document.canvasId !== source.canvasId)
    .filter(document => !document.block.archived)
    .map(document => ({ document, score: scoreTerms(required, `${document.block.title} ${knowledgeText(document.block.content)}`)
      + (source.block.links.includes(document.block.id) ? 1 : 0) }))
    .sort((left, right) => right.score - left.score || left.document.block.id.localeCompare(right.document.block.id))
    .slice(0, limit).map(item => item.document);
}

/** Automatic pair checks skip unsupported lexical candidates instead of filling a quota with arbitrary documents. */
export function relevantNeighbors(context: JevEvaluationContext, source: JevInputDocument, limit = 12): JevInputDocument[] {
  const query = `${source.block.title} ${(source.block.tags ?? []).join(' ')} ${knowledgeText(source.block.content).slice(0, 1800)}`;
  const required = meaningTerms(query);
  const sourceBody = meaningTerms(knowledgeText(source.block.content));
  const titleTerms = meaningTerms(`${source.block.title} ${(source.block.tags ?? []).join(' ')}`);
  const references = bodyReferencePhrases(source.block.content);
  const ranked = context.retrievedNeighbors?.[`${source.canvasId}:${source.block.id}`] ?? [];
  const semanticRank = new Map(ranked.slice(0, 24).map((id, index) => [id, index]));
  return context.documents.filter(document => document.snapshot.workspaceId === context.workspaceId)
    .filter(document => document.block.id !== source.block.id || document.canvasId !== source.canvasId)
    .filter(document => !document.block.archived && !document.block.processingExcluded)
    .map(document => {
      const available = meaningTerms(`${document.block.title} ${knowledgeText(document.block.content)}`);
      const targetBody = meaningTerms(knowledgeText(document.block.content));
      const overlap = intersectionSize(required, available);
      const bodyOverlap = intersectionSize(sourceBody, targetBody);
      const bodyCoverage = bodyOverlap / Math.max(1, Math.min(sourceBody.size, targetBody.size));
      const sourceTopicInTargetBody = intersectionSize(titleTerms, targetBody) > 0;
      const titleOverlap = intersectionSize(titleTerms, available);
      const linked = existingLink(source, document);
      const rank = semanticRank.get(`${document.canvasId}:${document.block.id}`);
      const referenced = referencedTitle(references, document.block.title);
      return { document, score: overlap / Math.max(1, required.size) + titleOverlap * .2 + Number(linked) + Number(referenced)
        + (rank === undefined ? 0 : 1 + (24 - rank) / 24),
        // A copied title or metadata keyword alone is not evidence for a pair check.
        relevant: rank !== undefined || linked || referenced || substantiveOverlap(bodyOverlap, bodyCoverage, sourceTopicInTargetBody) };
    })
    .filter(candidate => candidate.relevant)
    .sort((left, right) => right.score - left.score || left.document.block.id.localeCompare(right.document.block.id))
    .slice(0, Math.min(Math.max(0, limit), 24)).map(candidate => candidate.document);
}
export function topologicalOrder(nodes: string[], dependencies: Map<string, string[]>): { order: string[]; cycles: string[]; missing: string[] } {
  const available = new Set(nodes);
  const order: string[] = [];
  const pending = new Set(nodes);
  const missing = [...new Set([...dependencies.values()].flat().filter(id => !available.has(id)))];
  while (pending.size) {
    const ready = [...pending].filter(id => (dependencies.get(id) ?? []).every(dependency => !pending.has(dependency)));
    if (!ready.length) break;
    for (const id of ready) { order.push(id); pending.delete(id); }
  }
  return { order, cycles: [...pending], missing };
}
