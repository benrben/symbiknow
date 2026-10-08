import { normalizedGroup } from '../../../shared/groups.js';
import { choice, type JevAnswer, type JevQuestion } from '../../jev.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { semanticThreshold, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { filingCandidates, filingEvidence, filingState } from './group-passages.js';
import { sectionNames } from './source-passages.js';
import type { ProposedGroup } from './group-topics.js';
import { questionRequestFits } from './question-request-budget.js';

type PeerSubjectPreview = { title: string; subject: string; purpose: string; contextOnly: true };
export type FilingGroup = { key: string; name: string; definition: string;
  nomination?: ProposedGroup['nomination']; peerSubjectIds?: string[] };
type SharedPeerPreview = { id: string; preview: PeerSubjectPreview };
const letters = 'ABCDEFGHIJKLMNOP';
function rankedFilingGroups(groups: FilingGroup[], probabilities: Record<string, number>) {
  return groups.slice(0, 16).map((group, index) => ({ group, probability: probabilities[letters[index]] ?? 0 }))
    .sort((left, right) => right.probability - left.probability);
}
function winningFilingGroup(groups: FilingGroup[], probabilities: Record<string, number>) {
  const first = rankedFilingGroups(groups, probabilities)[0];
  return first && (probabilities.none ?? 0) < first.probability ? first.group : undefined;
}
function filingOptions(context: JevEvaluationContext, source: JevInputDocument, groups: FilingGroup[]) {
  return groups.slice(0, 16).map((group, index) => ({ key: group.key, name: group.name, definition: group.definition,
    ...(group.nomination ? { nomination: group.nomination, peerSubjectIds: group.peerSubjectIds } : {}), option: letters[index],
    members: context.documents.filter(document => document.canvasId === source.canvasId && document.block.id !== source.block.id && normalizedGroup(document.block.group) === group.key)
      .slice(0, 6).map(document => ({ title: document.block.title, sections: sectionNames(document.block.content, 4) })) }));
}
function refinementPeerIds(context: JevEvaluationContext, group: ProposedGroup, peers: Map<string, SharedPeerPreview>): string[] {
  return (group.candidatePeers ?? []).slice(0, 4).flatMap(snapshot => {
    const peer = context.documents.find(document => document.canvasId === snapshot.canvasId && document.block.id === snapshot.blockId);
    if (!peer) return [];
    const key = `${peer.canvasId}:${peer.block.id}`;
    const existing = peers.get(key);
    if (existing) return [existing.id];
    const subject = group.subjectContext?.find(subject => subject.passages.some(passage => passage.source.blockId === snapshot.blockId));
    const id = `peer${peers.size}`;
    peers.set(key, { id, preview: peerSubjectPreview(peer, group.name, subject) });
    return [id];
  });
}
function peerSubjectPreview(peer: JevInputDocument, name: string,
  subject: NonNullable<ProposedGroup['subjectContext']>[number] | undefined): PeerSubjectPreview {
  return { title: selectionPreview(peer.block.title, 80), subject: selectionPreview(subject?.name ?? name, 80),
    purpose: selectionPreview(subject?.passages.map(passage => passage.quote).join(' ') ?? '', 240), contextOnly: true };
}
function selectionPreview(value: string, byteLimit: number): string {
  let bytes = 0; let result = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > byteLimit) break;
    result += character; bytes += size;
  }
  return result;
}
function compactPeerPreviews(peers: Record<string, PeerSubjectPreview>, byteLimit: number) {
  return Object.fromEntries(Object.entries(peers).map(([id, peer]) => [id, {
    ...peer, title: selectionPreview(peer.title, Math.min(80, byteLimit)),
    subject: selectionPreview(peer.subject, Math.min(80, byteLimit)), purpose: selectionPreview(peer.purpose, byteLimit),
  }]));
}
function fitSelectionPreviews<T extends { state: { peerSubjects: Record<string, PeerSubjectPreview> }; questions: Record<string, JevQuestion> }>(set: T): T {
  let candidate = set;
  for (const bytes of [240, 160, 100, 60, 30]) {
    candidate = { ...set, state: { ...set.state, peerSubjects: compactPeerPreviews(set.state.peerSubjects, bytes) } };
    if (questionRequestFits(candidate.state, candidate.questions, false, 200)) return candidate;
  }
  return candidate;
}
/** Selection sees compact nominations; local candidates retain every exact proof and source guard. */
export function refinementQuestionSet(context: JevEvaluationContext, source: JevInputDocument,
  current: FilingGroup | undefined, alternatives: ProposedGroup[]) {
  const peers = new Map<string, SharedPeerPreview>();
  const groups = [...(current ? [{ ...current, definition: selectionPreview(current.definition, 300) }] : []), ...alternatives.map(group => ({
    key: group.key, name: group.name, nomination: group.nomination, peerSubjectIds: refinementPeerIds(context, group, peers),
    definition: selectionPreview(group.definition ?? group.origins.map(origin => origin.quote).join('\n'), 300),
  }))];
  const set = filingQuestionSet(context, source, groups, false);
  set.questions.place.instructions = 'Which supplied category provides useful shared organization for this canvas and the document’s main subject? Prefer a common subject family over separate page-title, guide, overview, or implementation folders for the same substantive theme. Compare baselineGroup with source-backed alternatives; peerSubjectIds refer to the peerSubjects dictionary, which provides context only, not verified memberships. A singleton subject is appropriate only when genuinely independent of nearby main subjects. Retain the baseline when no better useful category fits. Reject incidental shared words and unrelated topics. Choose none when no supplied category fits.';
  return fitSelectionPreviews({ ...set, groups, state: { ...set.state, currentGroup: normalizedGroup(source.block.group) ?? null,
    baselineGroup: current?.key ?? null, peerSubjects: Object.fromEntries([...peers.values()].map(peer => [peer.id, peer.preview])) } });
}
export function filingQuestionSet(context: JevEvaluationContext, source: JevInputDocument, groups: FilingGroup[], includeEvidence = true) {
  const options = filingOptions(context, source, groups);
  const passages = filingState(source).passages;
  return { state: { document: { title: source.block.title, sections: sectionNames(source.block.content, 14), passages }, groups: options }, questions: {
    place: choice('Which group in `groups` is about the main subject of `document`? Judge by each group\'s definition and member documents. Pick none if no group covers the subject, even if some words overlap.',
      { ...Object.fromEntries(options.map(group => [group.option, `"${group.name}" covers the main subject of document`])), none: 'No group covers the main subject of document' }),
    gate: choice('Pick the group whose definition covers the main subject of `document`. Pick none if no group does.',
      { ...Object.fromEntries(options.map(group => [group.option, `Group "${group.name}" covers the document`])), none: 'No group covers the document' }),
    ...(includeEvidence ? { evidence: choice('Which exact document passage substantively supports placement within the group selected by place? Choose none when no document passage supports that group.', filingCandidates(source)) } : {}),
  } };
}
function filingChoices(answers: Record<string, JevAnswer>) {
  if (answers.place?.type !== 'choice' || answers.gate?.type !== 'choice') return undefined;
  return { place: answers.place, gate: answers.gate };
}
export function filingDecision(context: JevEvaluationContext, source: JevInputDocument, groups: FilingGroup[], answers: Record<string, JevAnswer>) {
  const choices = filingChoices(answers);
  if (!choices || choices.gate.probabilities.none >= 0.6) return undefined;
  const confidence = calibrated(1 - choices.gate.probabilities.none, decisionBoundaries.fileGate);
  if (confidence < semanticThreshold(context)) return undefined;
  const group = winningFilingGroup(groups, choices.place.probabilities);
  return group ? { group, confidence, evidence: filingEvidence(source, answers.evidence) } : undefined;
}

export function filingEvidenceQuestionSet(source: JevInputDocument, group: FilingGroup) {
  return { state: { source: filingState(source), selectedGroup: group }, questions: {
    evidence: choice('Which exact passage in source substantively supports placement within selectedGroup and its parent, if present?', filingCandidates(source)),
  } };
}
