import { normalizeEvidence, type EvidenceReference } from './evidence.js';
import type { JevPassage } from './jev-types.js';

/** Translate checked Jev passages into the evidence used by existing task and source views. */
export function jevEvidenceReference(claim: string, evidence: JevPassage, sourceText: string,
  checkedAt: string, documentTitle?: string): EvidenceReference | null {
  const source = evidence.source;
  return normalizeEvidence({ claim, passage: evidence.quote, sourceText,
    canvasId: source.canvasId, documentId: source.blockId, documentTitle,
    contentHash: source.contentHash, incarnation: source.incarnation,
    sourceGeneration: source.sourceGeneration, metadataRevision: source.metadataRevision,
    start: evidence.start, end: evidence.end, checkedAt });
}
