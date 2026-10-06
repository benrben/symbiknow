import type { CanvasTask } from '../shared/types.js';
import type { EvidenceReference } from '../shared/evidence.js';
import { ApiError } from './errors.js';
import { assignee, blockIds, list, optionalText, record, text } from './coordination-values.js';

type Finding = NonNullable<CanvasTask['findingRef']>;
function optionalEvidence(entry: Record<string, unknown>, known: Set<string>) {
  return entry.evidence === undefined ? undefined : findingEvidence(entry.evidence, known);
}
function optionalReferences(entry: Record<string, unknown>, known: Set<string>) {
  return entry.references === undefined ? undefined : evidenceReferences(entry.references, known);
}
function optionalOwner(entry: Record<string, unknown>) {
  return entry.suggestedOwner === undefined ? undefined : assignee(entry.suggestedOwner);
}
export function findingRef(value: unknown, known: Set<string>): CanvasTask['findingRef'] {
  const entry = record(value, 'findingRef must identify a finding');
  const evidence = optionalEvidence(entry, known);
  const references = optionalReferences(entry, known);
  const suggestedOwner = optionalOwner(entry);
  return { id: text(entry.id, 'findingRef.id', 160, true), title: text(entry.title, 'findingRef.title', 200, true),
    canvasId: text(entry.canvasId, 'findingRef.canvasId', 160, true), blockIds: blockIds(entry.blockIds, known),
    ...optionalText(entry, 'detail', 'findingRef.detail', 4000),
    ...(evidence ? { evidence } : {}), ...(references ? { references } : {}), ...(suggestedOwner ? { suggestedOwner } : {}),
    ...optionalText(entry, 'investigationId', 'findingRef.investigationId', 160, true),
  };
}
function findingEvidence(value: unknown, known: Set<string>): Finding['evidence'] {
  const items = list(value, 12, 'findingRef.evidence must contain up to 12 evidence items');
  return items.map((item, index) => evidenceItem(item, index, known));
}
function sourceHashes(value: unknown, known: Set<string>): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const entry = record(value, 'findingRef evidence sourceHashes must be an object');
  const pairs = Object.entries(entry);
  if (pairs.length > 20 || pairs.some(([id, hash]) => !known.has(id) || typeof hash !== 'string' || hash.length > 128)) {
    throw new ApiError(400, 'findingRef evidence sourceHashes must reference documents on this canvas');
  }
  return Object.fromEntries(pairs as [string, string][]);
}
function evidenceItem(value: unknown, index: number, known: Set<string>): NonNullable<Finding['evidence']>[number] {
  const field = `findingRef.evidence[${index}]`;
  const entry = record(value, `${field} must be an object`);
  const sourceIds = entry.sourceIds === undefined ? undefined : blockIds(entry.sourceIds, known);
  const hashes = sourceHashes(entry.sourceHashes, known);
  return { questionId: text(entry.questionId, `${field}.questionId`, 160, true),
    answer: text(entry.answer, `${field}.answer`, 2000), excerpt: text(entry.excerpt, `${field}.excerpt`, 2000),
    ...(sourceIds ? { sourceIds } : {}), ...(hashes ? { sourceHashes: hashes } : {}) };
}
function evidenceReferences(value: unknown, known: Set<string>): Finding['references'] {
  const items = list(value, 12, 'findingRef.references must contain up to 12 references');
  return items.map((item, index) => referenceItem(item, index, known));
}
function navigationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new ApiError(400, 'findingRef evidence navigation must target a document on this canvas');
  return value as Record<string, unknown>;
}
function referenceNavigation(value: unknown, known: Set<string>) {
  const navigation = navigationObject(value);
  if (navigation.kind !== 'document' || !known.has(String(navigation.blockId ?? ''))) {
    throw new ApiError(400, 'findingRef evidence navigation must target a document on this canvas');
  }
  return navigation;
}
function checkReferenceIdentity(canvasId: string, documentId: string, navigation: Record<string, unknown>, known: Set<string>) {
  if (!known.has(documentId) || navigation.blockId !== documentId || navigation.canvasId !== canvasId) {
    throw new ApiError(400, 'findingRef evidence navigation must match its document');
  }
}
function passageKind(value: unknown): EvidenceReference['passageKind'] {
  if (value !== 'exact' && value !== 'approximation') throw new ApiError(400, 'findingRef evidence passageKind must be exact or approximation');
  return value;
}
function checkedDate(value: unknown, field: string) {
  const date = text(value, field, 64, true);
  if (!Number.isFinite(Date.parse(date))) throw new ApiError(400, 'findingRef evidence checkedAt must be a date');
  return new Date(date).toISOString();
}
function referenceStamp(entry: Record<string, unknown>): Partial<EvidenceReference> {
  const stamp: Partial<EvidenceReference> = {};
  if (entry.incarnation !== undefined) stamp.incarnation = text(entry.incarnation, 'findingRef evidence incarnation', 200, true);
  for (const field of ['sourceGeneration', 'metadataRevision', 'start', 'end'] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    stamp[field] = stampNumber(value, field);
  }
  stampRange(stamp);
  return stamp;
}
function stampNumber(value: unknown, field: string): number {
  const minimum = ['sourceGeneration', 'metadataRevision'].includes(field) ? 1 : 0;
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ApiError(400, 'Invalid evidence source revision or range');
  return Number(value);
}
function stampRange(stamp: Partial<EvidenceReference>): void {
  if (stamp.start === undefined && stamp.end === undefined) return;
  if (stamp.start === undefined || stamp.end === undefined) throw new ApiError(400, 'Invalid evidence range');
  if (stamp.end <= stamp.start) throw new ApiError(400, 'Invalid evidence range');
}
function referenceItem(value: unknown, index: number, known: Set<string>): EvidenceReference {
  const field = `findingRef.references[${index}]`;
  const entry = record(value, `${field} must be an object`);
  const navigation = referenceNavigation(entry.navigation, known);
  const canvasId = text(entry.canvasId, `${field}.canvasId`, 160, true);
  const documentId = text(entry.documentId, `${field}.documentId`, 160, true);
  checkReferenceIdentity(canvasId, documentId, navigation, known);
  const kind = passageKind(entry.passageKind);
  const checkedAt = checkedDate(entry.checkedAt, `${field}.checkedAt`);
  return { claim: text(entry.claim, `${field}.claim`, 2000, true), passage: text(entry.passage, `${field}.passage`, 4000, true), passageKind: kind,
    ...referenceStamp(entry),
    ...optionalText(entry, 'passageLabel', 'findingRef evidence passageLabel', 200), canvasId, documentId,
    ...optionalText(entry, 'documentTitle', 'findingRef evidence documentTitle', 200),
    ...optionalText(entry, 'contentHash', 'findingRef evidence contentHash', 128),
    ...optionalText(entry, 'revision', 'findingRef evidence revision', 160),
    checkedAt, navigation: { kind: 'document', canvasId, blockId: documentId } };
}
