export interface EvidenceSourceRevision {
  incarnation?: string;
  sourceGeneration?: number;
  metadataRevision?: number;
  start?: number;
  end?: number;
}

export interface EvidenceReference extends EvidenceSourceRevision {
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

export type EvidenceCandidate = EvidenceSourceRevision & {
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

function hasSourceIdentity(claim: string, passage: string, canvasId: string, documentId: string) {
  return Boolean(claim && passage && canvasId && documentId);
}

function passageDescription(candidate: EvidenceCandidate, passage: string): Pick<EvidenceReference, 'passageKind' | 'passageLabel'> {
  const source = candidate.sourceText?.replace(/\r\n?/g, '\n');
  const exact = source !== undefined && source.includes(passage.replace(/\r\n?/g, '\n'));
  return exact ? { passageKind: 'exact' } : { passageKind: 'approximation', passageLabel: approximationLabel };
}

function optionalProvenance(candidate: EvidenceCandidate) {
  return {
    ...(candidate.documentTitle ? { documentTitle: candidate.documentTitle } : {}),
    ...(candidate.contentHash ? { contentHash: candidate.contentHash } : {}),
    ...(candidate.revision ? { revision: candidate.revision } : {}),
  };
}

function validGeneration(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1);
}

function validRevision(candidate: EvidenceCandidate): boolean {
  if (candidate.incarnation !== undefined && !candidate.incarnation.trim()) return false;
  return validGeneration(candidate.sourceGeneration) && validGeneration(candidate.metadataRevision);
}

export function isEvidenceRange(start: number | undefined, end: number | undefined, sourceLength: number): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  return start! >= 0 && end! > start! && end! <= sourceLength;
}

function exactOffsets(candidate: EvidenceCandidate, passage: string): Pick<EvidenceSourceRevision, 'start' | 'end'> | null {
  const { start, end } = candidate;
  if (start === undefined && end === undefined) return {};
  if (candidate.sourceText === undefined) return null;
  if (!isEvidenceRange(start, end, candidate.sourceText.length)) return null;
  if (candidate.sourceText.slice(start, end) !== passage) return null;
  return { start, end };
}

function sourceRevision(candidate: EvidenceCandidate): EvidenceSourceRevision {
  return {
    ...(candidate.incarnation === undefined ? {} : { incarnation: candidate.incarnation }),
    ...(candidate.sourceGeneration === undefined ? {} : { sourceGeneration: candidate.sourceGeneration }),
    ...(candidate.metadataRevision === undefined ? {} : { metadataRevision: candidate.metadataRevision }),
  };
}

/** Preserve provenance without presenting a model excerpt or paraphrase as a verbatim quote. */
export function normalizeEvidence(candidate: EvidenceCandidate): EvidenceReference | null {
  const claim = candidate.claim.trim();
  const passage = candidate.passage.trim();
  const canvasId = candidate.canvasId.trim();
  const documentId = candidate.documentId.trim();
  if (!hasSourceIdentity(claim, passage, canvasId, documentId) || !Number.isFinite(Date.parse(candidate.checkedAt))) return null;
  if (!validRevision(candidate)) return null;
  const offsets = exactOffsets(candidate, passage);
  if (!offsets) return null;
  return {
    claim, passage, ...passageDescription(candidate, passage),
    canvasId, documentId,
    ...optionalProvenance(candidate),
    ...sourceRevision(candidate), ...offsets,
    checkedAt: new Date(candidate.checkedAt).toISOString(),
    navigation: { kind: 'document', canvasId, blockId: documentId },
  };
}
