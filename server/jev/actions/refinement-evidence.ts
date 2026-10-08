import type { JevPassage, JevSourceSnapshot } from '../../../shared/jev-types.js';
import { noul, type JevAnswer } from '../../jev.js';
import { sameJevSource, sourceSnapshot } from '../stamps.js';
import { confidence, judge, supported, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { completeGroupAssessment, groupAssessmentDecision, groupAssessmentSet } from './group-assessment.js';
import { filingEvidence, filingState } from './group-passages.js';
import type { ProposedGroup } from './group-topics.js';
import { questionRequestFits } from './question-request-budget.js';
import { canonicalGroupScope } from './canonical-group-scope.js';

type Answers = Record<string, JevAnswer>;
type Verified = { group: ProposedGroup; answers: Answers; confidences: number[] };
type ScopedGroup = ProposedGroup & { definition: string };
export type RefinementEvidence = Verified | { failure: 'non_independent_subject' | 'unverified_shared_family' | 'retired_group_requires_restore' };

function currentPeer(context: JevEvaluationContext, member: JevInputDocument, expected: JevSourceSnapshot): JevInputDocument | undefined {
  if (!localPeerScope(context, member, expected)) return undefined;
  const source = context.documents.find(source => source.canvasId === expected.canvasId && source.block.id === expected.blockId);
  if (!availablePeer(source)) return undefined;
  return sameJevSource(sourceSnapshot(context.workspaceId, source.canvasId, source.block), expected) ? source : undefined;
}
function localPeerScope(context: JevEvaluationContext, member: JevInputDocument, expected: JevSourceSnapshot): boolean {
  return expected.workspaceId === context.workspaceId && expected.canvasId === member.canvasId && expected.blockId !== member.block.id;
}
function availablePeer(source: JevInputDocument | undefined): source is JevInputDocument {
  return Boolean(source?.block.incarnation) && !source!.block.archived && !source!.block.processingExcluded;
}
function candidatePeers(context: JevEvaluationContext, member: JevInputDocument, group: ProposedGroup): JevInputDocument[] {
  const candidates = group.candidatePeers ?? group.origins.map(origin => origin.source);
  const peers = candidates.flatMap(candidate => {
    const source = currentPeer(context, member, candidate);
    return source ? [source] : [];
  });
  return [...new Map(peers.map(source => [source.block.id, source])).values()].slice(0, 4);
}
async function independentSubject(context: JevEvaluationContext, member: JevInputDocument,
  group: ProposedGroup, peers: JevInputDocument[]): Promise<number | undefined> {
  const confidences: number[] = [];
  for (const peer of peers) {
    const checked = await independentPeer(context, member, group, peer);
    if (checked === undefined) return undefined;
    confidences.push(checked);
  }
  return Math.min(1, ...confidences);
}
async function independentPeer(context: JevEvaluationContext, member: JevInputDocument,
  group: ProposedGroup, peer: JevInputDocument): Promise<number | undefined> {
  const answers = await judge(context, { source: filingState(member), selectedSubject: group.name,
    peerSubjects: [filingState(peer)] }, { independent: noul('Does source have an independent main substantive subject from every supplied peerSubjects document? Different titles, implementation details, guides, overviews, or operational roles about the same subject are NOT independent topics and should share a useful category. Reject independence when any peer addresses the same main subject. Judge actual substantive passages rather than naming or incidental shared words; genuinely different subjects may remain separate.') });
  return supported(answers.independent, context) ? confidence(answers.independent) : undefined;
}
async function subjectCheck(context: JevEvaluationContext, document: JevInputDocument, group: ProposedGroup, bootstrap: boolean): Promise<Answers> {
  const taxonomy = { key: group.key, name: group.name, definition: group.definition,
    parent: group.parent, origins: group.origins, originsRole: 'nomination_examples', reusableTaxonomy: true };
  const prepared = assessmentContext(context, document, taxonomy, bootstrap);
  const answers = await judge(prepared.context, prepared.set.state, prepared.set.questions);
  return completeGroupAssessment(prepared.context, document, taxonomy, answers, bootstrap);
}
function assessmentContext(context: JevEvaluationContext, document: JevInputDocument,
  group: Parameters<typeof groupAssessmentSet>[2], bootstrap: boolean) {
  const set = groupAssessmentSet(context, document, group, bootstrap);
  if (questionRequestFits(set.state, set.questions, context.shareQuestionSources === true, 200)) return { context, set };
  const selective = { ...context, selectiveGroupAssessment: true };
  return { context: selective, set: groupAssessmentSet(selective, document, group, bootstrap) };
}
async function firstVerifiedPeer(context: JevEvaluationContext, peers: JevInputDocument[], group: ProposedGroup) {
  for (const peer of peers) {
    const answers = await subjectCheck(context, peer, group, false);
    const checked = groupAssessmentDecision(context, peer, group, answers);
    if (checked) return checked;
  }
  return undefined;
}
function evidenceDefinition(group: ScopedGroup, origins: JevPassage[]): string {
  return `${group.definition}\n${[...new Set(origins.map(origin => origin.quote))].join('\n')}`;
}
function candidateScope(group: ProposedGroup): ScopedGroup {
  return { ...group, definition: group.definition || `Documents whose main substantive subject belongs within ${group.name}. Source origins are nomination examples, not a required checklist of every page's details.` };
}
function verifiedFamily(group: ScopedGroup, own: JevPassage[], peer: NonNullable<Awaited<ReturnType<typeof firstVerifiedPeer>>>, answers: Answers): Verified {
  const origins = [...own, ...peer.evidence];
  return { group: { ...group, origins, definition: evidenceDefinition(group, origins) },
    answers, confidences: peer.confidences };
}
/** Peer nominations become definition proof only after independent exact-passage/main-purpose checks. */
export async function refinementEvidence(context: JevEvaluationContext, member: JevInputDocument, proposed: ProposedGroup): Promise<RefinementEvidence> {
  const canonical = canonicalGroupScope(context, member.canvasId, proposed);
  if (canonical.retired) return { failure: 'retired_group_requires_restore' };
  const group = candidateScope(canonical.group);
  const peers = candidatePeers(context, member, group);
  if (group.nomination === 'source_subject') {
    const independent = await independentSubject(context, member, group, peers);
    if (independent !== undefined) {
      const answers = await subjectCheck(context, member, group, true);
      return { group: { ...group, origins: [], definition: evidenceDefinition(group, filingEvidence(member, answers.evidence)) },
        answers, confidences: [independent] };
    }
  }
  return sharedEvidence(context, member, group, peers);
}
async function sharedEvidence(context: JevEvaluationContext, member: JevInputDocument,
  group: ScopedGroup, peers: JevInputDocument[]): Promise<RefinementEvidence> {
  if (!peers.length) return { failure: 'unverified_shared_family' };
  const answers = await subjectCheck(context, member, group, true);
  const own = groupAssessmentDecision(context, member, group, answers, true);
  if (!own) return { group: { ...group, origins: [] }, answers, confidences: [] };
  const peer = await firstVerifiedPeer(context, peers, group);
  return peer ? verifiedFamily(group, own.evidence, peer, answers) : { failure: 'unverified_shared_family' };
}
