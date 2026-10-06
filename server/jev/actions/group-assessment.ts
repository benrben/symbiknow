import type { JevPassage } from '../../../shared/jev-types.js';
import { choice, noul, type JevAnswer, type JevQuestion } from '../../jev.js';
import { confidence, judge, supported, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { filingCandidates, filingEvidence, filingPassages, filingState } from './group-passages.js';
import { groupingSignalState } from './group-signals.js';
import { vocabularyGroupKey } from './groups.js';
import type { JevQuestionSet } from './question-batch.js';

export type GroupAssessmentGroup = { key: string; name: string; definition?: string; origins?: JevPassage[] };

/** Metadata revisions do not change what an exact source passage says about a group. */
export function semanticGroupState(group: GroupAssessmentGroup) {
  if (!group.origins) return { ...group };
  return { ...group, origins: group.origins.map(({ source, ...passage }) => ({ ...passage,
    source: { workspaceId: source.workspaceId, canvasId: source.canvasId, blockId: source.blockId,
      incarnation: source.incarnation, sourceGeneration: source.sourceGeneration, contentHash: source.contentHash } })) };
}

/** Select exact candidate evidence; document plans defer semantic checks until group selection. */
export function groupAssessmentSet(context: JevEvaluationContext, document: JevInputDocument,
  group: GroupAssessmentGroup, bootstrap = false): JevQuestionSet {
  const questions: Record<string, JevQuestion> = {
    evidence: choice('Which exact passage in source substantively supports placement within selectedGroup and its parent, if present?', filingCandidates(document)),
  };
  if (!context.selectiveGroupAssessment) Object.assign(questions, semanticQuestions(group, filingPassages(document).map((_, index) => index), bootstrap));
  return { state: groupAssessmentState(context, document, group, bootstrap, !context.selectiveGroupAssessment), questions };
}

function groupAssessmentState(context: JevEvaluationContext, document: JevInputDocument,
  group: GroupAssessmentGroup, bootstrap: boolean, semantic: boolean): JevQuestionSet['state'] {
  const selectedGroup = semanticGroupState(group);
  if (bootstrap) selectedGroup.definition = (group.origins ?? []).map(passage => passage.quote).join('\n');
  const state = { source: filingState(document), selectedGroup, organizationSignals: groupingSignalState(context, document) };
  // Evidence choice uses source and selectedGroup. These additional fields belong only to semantic validation.
  if (!semantic) return state;
  return { ...state, localEvidence: filingPassages(document).map(({ quote, start, end }) => ({ quote, start, end })),
    existingDefinitions: context.vocabulary.filter(term => term.kind === 'group')
      .map(term => ({ name: term.name, key: vocabularyGroupKey(term), definition: term.definition, state: term.state })) };
}

function semanticQuestions(group: GroupAssessmentGroup, indices: number[], bootstrap: boolean): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  if (bootstrap) questions.coherent = noul('Do the supplied source passages describe a meaningful shared topic matching selectedGroup.name? Judge the topic’s meaning, even if this is a new group. Reject a name combining unrelated subjects or conflicting with an existing definition. For a subgroup, also require the supplied parent-child heading hierarchy.');
  for (const index of indices) {
    questions[`purpose_${index}`] = noul(`Use only localEvidence[${index}] as localEvidence for this check. Is this document's main subject within selectedGroup's topical scope, supported by that exact passage? A definition containing quoted member passages gives examples of the category's scope; each document need not repeat all examples. Respect explicit restrictions in the definition. An explicit source category heading supports membership when the surrounding prose fits that category. Reject incidental shared words and neighboring topics.`);
    if (group.key.includes('/')) questions[`containment_${index}`] = noul(`Use only localEvidence[${index}] as localEvidence for this check. Do this document's own passages establish that its subject belongs within both the selected parent topic and subgroup? Require substantive containment; a neighboring heading hierarchy is insufficient.`);
  }
  return questions;
}

/** Keep group and passage selection independent of the selected passage's semantic checks. */
export async function completeGroupAssessment(context: JevEvaluationContext, document: JevInputDocument,
  group: GroupAssessmentGroup, answers: Record<string, JevAnswer>, bootstrap = false): Promise<Record<string, JevAnswer>> {
  if (!context.selectiveGroupAssessment) return answers;
  const evidence = filingEvidence(document, answers.evidence);
  if (!evidence.length) return answers;
  const index = filingPassages(document).findIndex(passage => passage.start === evidence[0].start && passage.end === evidence[0].end);
  const state = groupAssessmentState(context, document, group, bootstrap, true);
  const checked = await judge(context, state, semanticQuestions(group, [index], bootstrap));
  return { ...answers, ...checked };
}

export function groupAssessmentDecision(context: JevEvaluationContext, document: JevInputDocument,
  group: GroupAssessmentGroup, answers: Record<string, JevAnswer>, bootstrap = false) {
  if (bootstrap && !supported(answers.coherent, context)) return undefined;
  const evidence = filingEvidence(document, answers.evidence);
  if (!evidence.length) return undefined;
  const index = filingPassages(document).findIndex(passage => passage.start === evidence[0].start && passage.end === evidence[0].end);
  const checks = [answers[`purpose_${index}`]];
  if (group.key.includes('/')) checks.push(answers[`containment_${index}`]);
  if (!checks.every(answer => supported(answer, context))) return undefined;
  return { evidence, confidences: assessmentConfidences(answers, checks, bootstrap) };
}

function assessmentConfidences(answers: Record<string, JevAnswer>, checks: JevAnswer[], bootstrap: boolean) {
  return [...(bootstrap ? [confidence(answers.coherent)] : []), ...checks.map(confidence)];
}
