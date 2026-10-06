import { groupParent, validGroupKey } from '../../../shared/groups.js';
import type { JevActionRequest, JevPassage, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { ApiError } from '../../errors.js';
import { choice, noul } from '../../jev.js';
import { candidates, passages, selected, selectedEvidence, sourceState, supported, textOption,
  type JevEvaluationContext, type JevInputDocument } from './context.js';
import { childGroupKey, membershipGroupKey, vocabularyGroupKey } from './groups.js';
import { judgeQuestionSets } from './question-batch.js';

export type GroupHierarchy = { parentId?: string; groupKey: string };
function declaredHierarchy(context: JevEvaluationContext, request: JevActionRequest, name: string): GroupHierarchy | undefined {
  const parentId = textOption(request, 'parentId');
  const groupKey = textOption(request, 'groupKey');
  if (!parentId && !groupKey) return undefined;
  if (groupKey && !validGroupKey(groupKey)) throw new ApiError(400, 'Group key must be a valid native group path');
  const nativeParent = groupParent(groupKey);
  const parent = context.vocabulary.find(term => term.kind === 'group' &&
    (parentId ? term.id === parentId : vocabularyGroupKey(term) === nativeParent));
  return explicitHierarchy(parent, parentId, groupKey, name);
}
function explicitHierarchy(parent: JevVocabularyTerm | undefined, parentId: string, groupKey: string, name: string): GroupHierarchy {
  if (parentId && !parent) throw new ApiError(404, 'The requested parent group is unavailable');
  if (!parent) {
    if (groupParent(groupKey)) throw new ApiError(400, 'A nested group requires an existing parent definition');
    return { groupKey };
  }
  return parentHierarchy(parent, groupKey, name);
}
function parentHierarchy(parent: JevVocabularyTerm, groupKey: string, name: string): GroupHierarchy {
  if (parent.state !== 'active') throw new ApiError(409, 'The parent group must be active');
  const key = groupKey || childGroupKey(vocabularyGroupKey(parent), name);
  if (groupParent(key) !== vocabularyGroupKey(parent)) throw new ApiError(400, 'The child group key must directly descend from its parent');
  return { parentId: parent.id, groupKey: key };
}
export async function groupHierarchy(context: JevEvaluationContext, request: JevActionRequest,
  name: string, documents: JevInputDocument[]): Promise<GroupHierarchy> {
  const explicit = declaredHierarchy(context, request, name);
  if (explicit) return explicit;
  const parents = context.vocabulary.filter(term => term.kind === 'group' && term.state === 'active'
    && vocabularyGroupKey(term).startsWith('custom:') && vocabularyGroupKey(term).split('/').length < 8).slice(0, 16);
  if (!parents.length) return { groupKey: membershipGroupKey(name) };
  const evidence = new Map<string, JevPassage>(documents.flatMap((document, docIndex) => passages(document).map((passage, index) => [`d${docIndex}p${index}`, passage] as const)));
  const answers = await judgeQuestionSets(context, [parentSelectionSet(name, documents, parents),
    ...parents.map(parent => parentAssessmentSet(name, documents, parent, evidence))]);
  const index = parents.findIndex((_, index) => `parent${index}` === selected(answers[0].parent, context));
  if (index < 0) return { groupKey: membershipGroupKey(name) };
  const assessment = answers[index + 1];
  return inferredHierarchy(parents[index], name, supported(assessment.containment, context), evidence.get(selectedEvidence(assessment.parentEvidence) ?? ''));
}
function parentSelectionSet(name: string, documents: JevInputDocument[], parents: JevVocabularyTerm[]) {
  return { state: { childName: name, sources: documents.map(sourceState),
    parentCandidates: parents.map(term => ({ id: term.id, name: term.name, definition: term.definition, groupKey: vocabularyGroupKey(term) })) }, questions: {
    parent: choice('Which known parent definition contains this child concept as a proper subgroup? Select none for a separate root group.', candidates(
      parents.map((term, index) => ({ id: `parent${index}`, description: `${term.name}: ${term.definition}` })))),
  } };
}
function parentAssessmentSet(name: string, documents: JevInputDocument[], parent: JevVocabularyTerm, evidence: Map<string, JevPassage>) {
  return { state: { childName: name, sources: documents.map(sourceState), selectedParent: {
    id: parent.id, name: parent.name, definition: parent.definition, groupKey: vocabularyGroupKey(parent) } }, questions: {
    containment: noul('Do source passages explicitly support substantive containment of childName within selectedParent, beyond co-occurrence or shared words?'),
    parentEvidence: choice('Which exact passage establishes containment of childName within selectedParent?', candidates([...evidence]
      .map(([id, passage]) => ({ id, description: passage.quote })))),
  } };
}
function inferredHierarchy(parent: JevVocabularyTerm, name: string, supportedContainment: boolean,
  evidence: JevPassage | undefined): GroupHierarchy {
  if (!supportedContainment || !evidence) return { groupKey: membershipGroupKey(name) };
  return { parentId: parent.id, groupKey: childGroupKey(vocabularyGroupKey(parent), name) };
}
