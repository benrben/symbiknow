export interface IndexedDocument {
  canvasId: string;
  fingerprint: string;
  terms: Map<string, number>;
  shingles: Set<string>;
}
export interface SimilarityNeighbor { blockId: string; canvasId: string; score: number }
export interface NeighborScope { sameCanvas?: boolean; crossCanvas?: boolean }
