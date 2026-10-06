import type { CanvasBlock } from '../shared/types.js';
import type { IndexedDocument, NeighborScope, SimilarityNeighbor } from './similarity-types.js';
import { documentFingerprint, indexedDocument, unchangedDocument } from './similarity-documents.js';
import { jaccard } from './similarity-text.js';
import { rankedNeighbors } from './similarity-vectors.js';

export { shingleOverlap, tokenize } from './similarity-text.js';
export type { NeighborScope, SimilarityNeighbor } from './similarity-types.js';

/** An in-memory, workspace-scoped TF-IDF index. Storage owns synchronization. */
export class SimilarityIndex {
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly documentFrequency = new Map<string, number>();

  /** Returns whether text or title changed and the document was reindexed. */
  upsert(canvasId: string, block: CanvasBlock): boolean {
    const fingerprint = documentFingerprint(block);
    const old = this.documents.get(block.id);
    if (unchangedDocument(old, canvasId, fingerprint)) return false;

    const next = indexedDocument(canvasId, block, fingerprint);

    if (old) this.adjustFrequency(old.terms, -1);
    this.documents.set(block.id, next);
    this.adjustFrequency(next.terms, 1);
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
    return rankedNeighbors(this.documents, this.documentFrequency, blockId, k, scope);
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
