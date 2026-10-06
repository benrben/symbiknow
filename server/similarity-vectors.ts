import type { IndexedDocument, NeighborScope, SimilarityNeighbor } from './similarity-types.js';

type Scope = { sameCanvas: boolean; crossCanvas: boolean };
type InverseFrequency = (term: string) => number;

function selectedScope(scope: NeighborScope): Scope {
  return { sameCanvas: scope.sameCanvas ?? true, crossCanvas: scope.crossCanvas ?? false };
}

function allowsCandidate(sourceId: string, source: IndexedDocument, candidateId: string, candidate: IndexedDocument, scope: Scope): boolean {
  if (candidateId === sourceId) return false;
  const same = candidate.canvasId === source.canvasId;
  return !((same && !scope.sameCanvas) || (!same && !scope.crossCanvas));
}

function termFrequency(count: number): number { return 1 + Math.log(count); }

function norm(terms: Map<string, number>, idf: InverseFrequency): number {
  let sum = 0;
  for (const [term, count] of terms) sum += ((1 + Math.log(count)) * idf(term)) ** 2;
  return Math.sqrt(sum);
}

function dotProduct(source: IndexedDocument, candidate: IndexedDocument, idf: InverseFrequency): number {
  let dot = 0;
  for (const [term, count] of source.terms) {
    const otherCount = candidate.terms.get(term);
    if (otherCount) dot += termFrequency(count) * termFrequency(otherCount) * idf(term) ** 2;
  }
  return dot;
}

type MatchContext = { sourceId: string; source: IndexedDocument; scope: Scope; idf: InverseFrequency; sourceNorm: number };
function matchesFor(documents: Map<string, IndexedDocument>, context: MatchContext): SimilarityNeighbor[] {
  const { sourceId, source, scope, idf, sourceNorm } = context;
  const matches: SimilarityNeighbor[] = [];
  for (const [candidateId, candidate] of documents) {
    if (!allowsCandidate(sourceId, source, candidateId, candidate, scope)) continue;
    const dot = dotProduct(source, candidate, idf);
    if (!dot) continue;
    const score = dot / (sourceNorm * norm(candidate.terms, idf));
    matches.push({ blockId: candidateId, canvasId: candidate.canvasId, score });
  }
  return matches;
}

export function rankedNeighbors(documents: Map<string, IndexedDocument>, frequency: Map<string, number>,
  blockId: string, k: number, scope: NeighborScope): SimilarityNeighbor[] {
  const source = documents.get(blockId);
  if (!source || k <= 0) return [];
  const selected = selectedScope(scope);
  // Every queried term belongs to an indexed document; upsert/removal maintain its frequency alongside that document.
  const idf = (term: string) => Math.log((documents.size + 1) / (frequency.get(term)! + 1)) + 1;
  const sourceNorm = norm(source.terms, idf);
  if (!sourceNorm) return [];
  return matchesFor(documents, { sourceId: blockId, source, scope: selected, idf, sourceNorm })
    .sort((a, b) => b.score - a.score || a.canvasId.localeCompare(b.canvasId) || a.blockId.localeCompare(b.blockId)).slice(0, k);
}
