export interface EvidenceReference {
  claim: string;
  passage: string;
  passageKind: 'exact' | 'approximation';
  passageLabel?: string;
  canvasId: string;
  documentId: string;
  documentTitle?: string;
  contentHash?: string;
  revision?: string;
  checkedAt: string;
  navigation: { kind: 'document'; canvasId: string; blockId: string };
}

export type EvidenceCandidate = {
  claim: string;
  passage: string;
  /** The complete source content, used only to check whether passage is a literal quote. Never returned. */
  sourceText?: string;
  canvasId: string;
  documentId: string;
  documentTitle?: string;
  contentHash?: string;
  revision?: string;
  checkedAt: string;
};

const approximationLabel = 'Approximate source context; open the document to verify the claim.';

/** Preserve provenance without presenting a model excerpt or paraphrase as a verbatim quote. */
export function normalizeEvidence(candidate: EvidenceCandidate): EvidenceReference | null {
  const claim = candidate.claim.trim();
  const passage = candidate.passage.trim();
  const canvasId = candidate.canvasId.trim();
  const documentId = candidate.documentId.trim();
  if (!claim || !passage || !canvasId || !documentId || !Number.isFinite(Date.parse(candidate.checkedAt))) return null;
  const source = candidate.sourceText?.replace(/\r\n?/g, '\n');
  const exact = source !== undefined && source.includes(passage.replace(/\r\n?/g, '\n'));
  return {
    claim, passage, passageKind: exact ? 'exact' : 'approximation',
    ...(exact ? {} : { passageLabel: approximationLabel }),
    canvasId, documentId,
    ...(candidate.documentTitle ? { documentTitle: candidate.documentTitle } : {}),
    ...(candidate.contentHash ? { contentHash: candidate.contentHash } : {}),
    ...(candidate.revision ? { revision: candidate.revision } : {}),
    checkedAt: new Date(candidate.checkedAt).toISOString(),
    navigation: { kind: 'document', canvasId, blockId: documentId },
  };
}
