import { createHash } from 'node:crypto';
import type { JevActionRequest, JevEvaluation, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { choice, type JevAnswer } from '../../jev.js';
import { candidates, confidence, evaluation, judge, passages, proposal, selected,
  supported, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { filingEvidence, filingState } from './group-passages.js';
import { completeGroupAssessment, groupAssessmentDecision, groupAssessmentSet, semanticGroupState } from './group-assessment.js';
import { judgeQuestionSets, type JevQuestionSet } from './question-batch.js';
import { vocabularyGroupKey } from './groups.js';
import { groupingSignalState } from './group-signals.js';
import { canvasTopicCatalog, type ProposedGroup } from './group-topics.js';

function groupTerm(group: { name: string; key: string }, document: JevInputDocument,
  definition: string, parentId?: string): JevVocabularyTerm {
  return { id: `group_${createHash('sha256').update(group.key).digest('hex').slice(0, 16)}`, kind: 'group',
    name: group.name, groupKey: group.key, ...(parentId ? { parentId } : {}), definition, aliases: [],
    state: 'active', version: 1, members: [{ canvasId: document.canvasId, blockId: document.block.id }] };
}
function addDefinition(result: JevEvaluation, context: JevEvaluationContext, request: JevActionRequest,
  term: JevVocabularyTerm, evidence: ReturnType<typeof passages>): JevVocabularyTerm {
  const existing = context.vocabulary.find(candidate => candidate.kind === 'group' && vocabularyGroupKey(candidate) === term.groupKey);
  if (existing?.state === 'active' || existing?.state === 'retired') return existing;
  const proposed = existing ? { ...existing, state: 'active' as const, version: existing.version + 1 } : term;
  const sourceIds = new Set(evidence.map(passage => `${passage.source.canvasId}:${passage.source.blockId}`));
  const sources = context.documents.filter(candidate => sourceIds.has(`${candidate.canvasId}:${candidate.block.id}`));
  result.proposals.push(proposal(request, { kind: 'vocabulary', operation: existing ? 'promote' : 'define', term: proposed }, sources,
    `Define group: ${term.name}`, 'A proposed source-derived group definition; approval precedes canonical membership changes', [...evidence]));
  return proposed;
}
export async function bootstrapGrouping(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, rejectedKeys: string[] = []): Promise<JevEvaluation> {
  let groups = canvasTopicCatalog(context, document).filter(group => !rejectedKeys.includes(group.key));
  if (!groups.length) return evaluation({ status: 'no_source_derived_group_names' });
  // One candidate needs no speculative assessment fan-out: validate it in the selection request.
  if (groups.length === 1 && context.shareQuestionSources) context = { ...context, selectiveGroupAssessment: false };
  const checks = await judgeQuestionSets(context, [groupSelectionSet(context, document, groups),
    ...groups.map(group => groupAssessmentSet(context, document, group, true))]);
  const assessments = new Map(groups.map((group, index) => [group.key, checks[index + 1]]));
  let result = evaluation({ status: 'insufficient_group_evidence' });
  for (let attempt = 0; attempt < 3 && groups.length; attempt++) {
    const answers = await selectionAnswers(context, document, groups, attempt, checks[0]);
    const checked = await checkedSelection(context, request, document, groups, assessments, answers);
    if (!checked) return result;
    result = checked.result;
    if (!retryableGrouping(result)) return result;
    groups = groups.filter(candidate => candidate.key !== checked.group.key);
  }
  return result;
}
function groupSelectionSet(context: JevEvaluationContext, document: JevInputDocument, groups: ProposedGroup[]): JevQuestionSet {
  return { state: { source: filingState(document), proposedGroups: groups.map(semanticGroupState), organizationSignals: groupingSignalState(context, document) }, questions: {
    group: choice('Which shared topic describes this document’s main subject? Match source passages to proposedGroups. A broad category can contain different documents about that subject. Use checked logical topics and labels in organizationSignals as supporting context; a link alone is insufficient. Prefer a root topic unless the document specifically belongs in a supplied shared subgroup. Choose none if no topic fits, or unknown if the passages are insufficient.', candidates(
      groups.map((group, index) => ({ id: `new${index}`, description: `${group.name} (${group.key})` })))),
  } };
}
async function selectionAnswers(context: JevEvaluationContext, document: JevInputDocument, groups: ProposedGroup[],
  attempt: number, initial: Record<string, JevAnswer>): Promise<Record<string, JevAnswer>> {
  if (!attempt) return initial;
  const set = groupSelectionSet(context, document, groups);
  return judge(context, set.state, set.questions);
}
async function checkedSelection(context: JevEvaluationContext, request: JevActionRequest, document: JevInputDocument,
  groups: ProposedGroup[], assessments: Map<string, Record<string, JevAnswer>>, answers: Record<string, JevAnswer>) {
  const group = groups.find((_, index) => `new${index}` === selected(answers.group, context));
  if (!group) return undefined;
  const assessment = await completeGroupAssessment(context, document, group, assessments.get(group.key)!, true);
  return { group, result: assessedGrouping(context, request, document, group, assessment, confidence(answers.group)) };
}
function retryableGrouping(result: JevEvaluation): boolean {
  return result.result.status === 'insufficient_group_evidence' || result.result.status === 'insufficient_local_group_purpose';
}
function assessedGrouping(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, group: ProposedGroup, assessment: Record<string, JevAnswer>, selectionConfidence: number): JevEvaluation {
  const evidence = filingEvidence(document, assessment.evidence);
  if (!supported(assessment.coherent, context) || !evidence.length) return evaluation({ status: 'insufficient_group_evidence' });
  const decision = groupAssessmentDecision(context, document, group, assessment, true);
  if (!decision) return evaluation({ status: 'insufficient_local_group_purpose' });
  const decisionConfidences = [selectionConfidence, ...decision.confidences];
  const result = proposedGrouping(context, request, document, group, decision.evidence);
  result.proposals.forEach(candidate => { candidate.decisionConfidences = [...decisionConfidences]; });
  result.result.requiresExplicitReview = needsExplicitReview(context, request);
  result.result.confidenceBasis = ['group_selection', 'topic_coherence', 'local_main_purpose', 'local_subgroup_containment'];
  return result;
}
function needsExplicitReview(context: JevEvaluationContext, request: JevActionRequest): boolean {
  return context.settings.modes[request.action] !== 'auto';
}
function proposedGrouping(context: JevEvaluationContext, request: JevActionRequest, document: JevInputDocument,
  group: ProposedGroup, evidence: ReturnType<typeof passages>): JevEvaluation {
  const definitionEvidence = [...evidence, ...group.origins];
  const result = evaluation({ status: 'proposed_grouping', requiresExplicitReview: true });
  const parent = bootstrapParent(result, context, request, document, group, definitionEvidence);
  if (parent?.state === 'retired') return evaluation({ status: 'retired_group_requires_restore' });
  const term = addDefinition(result, context, request, groupTerm(group, document, group.origins.length ? [...new Set(group.origins.map(origin => origin.quote))].join('\n') : evidence[0].quote, parent?.id), definitionEvidence);
  if (term.state === 'retired') return evaluation({ status: 'retired_group_requires_restore' });
  result.proposals.push(proposal(request, { kind: 'document', canvasId: document.canvasId,
    blockId: document.block.id, patch: { group: group.key } }, [document], `File under ${group.name}`,
  'Apply this actual native canvas membership according to the configured Suggest or Auto policy, with source, ownership, and confidence checks', evidence));
  return result;
}
function bootstrapParent(result: JevEvaluation, context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, group: ProposedGroup, evidence: ReturnType<typeof passages>): JevVocabularyTerm | undefined {
  if (!group.parent) return undefined;
  const proposed = groupTerm(group.parent, document, evidence[0].quote);
  return addDefinition(result, context, request, proposed, evidence);
}

/** Coalesce repeated definitions without widening any individual document's revision guard. */
export function coalesceGroupDefinitions(result: JevEvaluation): void {
  const definitions = new Map<string, JevEvaluation['proposals'][number]>();
  result.proposals = result.proposals.filter(candidate => {
    const mutation = candidate.mutation;
    if (mutation.kind !== 'vocabulary') return true;
    const prior = definitions.get(mutation.term.id);
    if (!prior || prior.mutation.kind !== 'vocabulary') { definitions.set(mutation.term.id, candidate); return true; }
    prior.mutation.term.members = [...new Map([...prior.mutation.term.members, ...mutation.term.members]
      .map(member => [`${member.canvasId}:${member.blockId}`, member])).values()];
    prior.sources = [...new Map([...prior.sources, ...candidate.sources].map(source => [`${source.canvasId}:${source.blockId}`, source])).values()];
    prior.evidence.push(...candidate.evidence);
    prior.decisionConfidences = [...prior.decisionConfidences!, ...candidate.decisionConfidences!];
    return false;
  });
  const terms = result.proposals.filter(isVocabularyProposal).sort((left, right) =>
    left.mutation.term.groupKey!.split('/').length - right.mutation.term.groupKey!.split('/').length);
  result.proposals = [...terms, ...result.proposals.filter(candidate => candidate.mutation.kind !== 'vocabulary')];
}
function isVocabularyProposal(candidate: JevEvaluation['proposals'][number]): candidate is JevEvaluation['proposals'][number]
  & { mutation: Extract<JevEvaluation['proposals'][number]['mutation'], { kind: 'vocabulary' }> } {
  return candidate.mutation.kind === 'vocabulary';
}
