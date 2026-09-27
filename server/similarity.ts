import { createHash } from 'node:crypto';
import { documentText } from '../shared/document-text.js';
import type { CanvasBlock } from '../shared/types.js';

const wordPattern = /\p{L}[\p{L}\p{N}]{2,}/gu;
const stopWords = new Set([
  // Common words in the scripts used by the document corpus. Shorter words are
  // already excluded by the tokenizer's three-character minimum.
  'the', 'and', 'for', 'are', 'with', 'from', 'this', 'that', 'have', 'was', 'were', 'not',
  'של', 'הוא', 'היא', 'אבל', 'היה', 'אשר', 'זאת', 'הם', 'הן',
  'это', 'как', 'для', 'что', 'или', 'его', 'она', 'они',
  'على', 'هذا', 'هذه', 'التي', 'كان', 'ليس',
]);

/** Lowercase Unicode words of at least three letters/digits, minus common words. */
export function tokenize(text: string): string[] {
  return (text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().match(wordPattern) ?? [])
    .filter(word => !stopWords.has(word));
}

function shingles(words: string[]): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index <= words.length - 5; index++) {
    result.add(words.slice(index, index + 5).join('\u0000'));
  }
  return result;
}

function jaccard(first: Set<string>, second: Set<string>): number {
  if (!first.size || !second.size) return 0;
  let shared = 0;
  for (const value of first) if (second.has(value)) shared++;
  return shared / (first.size + second.size - shared);
}

/** Jaccard overlap of five-word shingles from two readable document bodies. */
export function shingleOverlap(first: string, second: string): number {
  return jaccard(shingles(tokenize(documentText(first))), shingles(tokenize(documentText(second))));
}

interface IndexedDocument {
  canvasId: string;
  fingerprint: string;
  terms: Map<string, number>;
  shingles: Set<string>;
}

export interface SimilarityNeighbor {
  blockId: string;
  canvasId: string;
  score: number;
}

export interface NeighborScope {
  sameCanvas?: boolean;
  crossCanvas?: boolean;
}

/** An in-memory, workspace-scoped TF-IDF index. Storage owns synchronization. */
export class SimilarityIndex {
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly documentFrequency = new Map<string, number>();

  /** Returns whether text or title changed and the document was reindexed. */
  upsert(canvasId: string, block: CanvasBlock): boolean {
    const hash = block.contentHash ?? createHash('sha256').update(block.content).digest('hex').slice(0, 16);
    const fingerprint = `${hash}\u0000${block.title}`;
    const old = this.documents.get(block.id);
    if (old?.fingerprint === fingerprint && old.canvasId === canvasId) return false;

    const words = tokenize(`${block.title} ${block.title} ${block.title} ${documentText(block.content)}`);
    const terms = new Map<string, number>();
    for (const word of words) terms.set(word, (terms.get(word) ?? 0) + 1);
    const next: IndexedDocument = { canvasId, fingerprint, terms, shingles: shingles(tokenize(documentText(block.content))) };

    if (old) this.adjustFrequency(old.terms, -1);
    this.documents.set(block.id, next);
    this.adjustFrequency(terms, 1);
    return true;
  }

  remove(blockId: string): boolean {
    const old = this.documents.get(blockId);
    if (!old) return false;
    this.documents.delete(blockId);
    this.adjustFrequency(old.terms, -1);
    return true;
  }

  clearCanvas(canvasId: string): void {
    for (const [blockId, document] of this.documents) {
      if (document.canvasId === canvasId) this.remove(blockId);
    }
  }

  /** Replace one canvas's index entries after loading or writing its blocks. */
  syncCanvas(canvasId: string, blocks: CanvasBlock[]): void {
    const present = new Set(blocks.map(block => block.id));
    for (const [blockId, document] of this.documents) {
      if (document.canvasId === canvasId && !present.has(blockId)) this.remove(blockId);
    }
    for (const block of blocks) this.upsert(canvasId, block);
  }

  neighbors(blockId: string, k: number, scope: NeighborScope = {}): SimilarityNeighbor[] {
    const source = this.documents.get(blockId);
    if (!source || k <= 0) return [];
    const sameCanvas = scope.sameCanvas ?? true;
    const crossCanvas = scope.crossCanvas ?? false;
    const idf = (term: string) => Math.log((this.documents.size + 1) / ((this.documentFrequency.get(term) ?? 0) + 1)) + 1;
    const tf = (count: number) => 1 + Math.log(count);
    const sourceNorm = this.norm(source.terms, idf);
    if (!sourceNorm) return [];

    const matches: SimilarityNeighbor[] = [];
    for (const [candidateId, candidate] of this.documents) {
      if (candidateId === blockId) continue;
      const same = candidate.canvasId === source.canvasId;
      if ((same && !sameCanvas) || (!same && !crossCanvas)) continue;
      let dot = 0;
      for (const [term, count] of source.terms) {
        const otherCount = candidate.terms.get(term);
        if (otherCount) dot += tf(count) * tf(otherCount) * idf(term) ** 2;
      }
      if (!dot) continue;
      const score = dot / (sourceNorm * this.norm(candidate.terms, idf));
      matches.push({ blockId: candidateId, canvasId: candidate.canvasId, score });
    }
    return matches.sort((a, b) => b.score - a.score || a.canvasId.localeCompare(b.canvasId) || a.blockId.localeCompare(b.blockId)).slice(0, k);
  }

  shingleOverlap(firstBlockId: string, secondBlockId: string): number {
    const first = this.documents.get(firstBlockId);
    const second = this.documents.get(secondBlockId);
    return first && second ? jaccard(first.shingles, second.shingles) : 0;
  }

  private adjustFrequency(terms: Map<string, number>, change: 1 | -1): void {
    for (const term of terms.keys()) {
      const count = (this.documentFrequency.get(term) ?? 0) + change;
      if (count) this.documentFrequency.set(term, count);
      else this.documentFrequency.delete(term);
    }
  }

  private norm(terms: Map<string, number>, idf: (term: string) => number): number {
    let sum = 0;
    for (const [term, count] of terms) sum += ((1 + Math.log(count)) * idf(term)) ** 2;
    return Math.sqrt(sum);
  }
}

const workspaceIndexes = new Map<string, SimilarityIndex>();

export function getSimilarityIndex(workspaceId: string): SimilarityIndex {
  let index = workspaceIndexes.get(workspaceId);
  if (!index) {
    index = new SimilarityIndex();
    workspaceIndexes.set(workspaceId, index);
  }
  return index;
}
