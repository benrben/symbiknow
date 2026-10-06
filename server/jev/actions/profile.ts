import { groupLabel,normalizedGroup,validGroupKey } from '../../../shared/groups.js';
import type { JevActionRequest,JevEvaluation,JevValues } from '../../../shared/jev-types.js';
import { choice,noul,type JevQuestion } from '../../jev.js';
import {
candidates,
confidence,
currentTime,
derived,evaluation,evidenceCandidates,exactEvidence,
json,
judge,
passages,proposal,selected,selectedDocuments,semanticThreshold,sourceState,supported,
type JevEvaluationContext,type JevInputDocument
} from './context.js';
import { filingState } from './group-passages.js';
import { reusableGroup } from './group-topics.js';
import { bootstrapGrouping,coalesceGroupDefinitions } from './grouping.js';
import { completeGroupAssessment,groupAssessmentDecision,groupAssessmentSet } from './group-assessment.js';
import { judgeQuestionSets } from './question-batch.js';
import type { JevAnswer } from '../../jev.js';
import { membershipGroupKey,vocabularyGroupKey } from './groups.js';
import { readablePassage, semanticHeadingNames, sourcePassages } from './source-passages.js';
import { sharedSourceCategories } from './source-categories.js';
import { lexicalScore } from './candidates.js';
import { logicalIndexQuestions, logicalIndexResult, logicalTopicCandidateOrigins } from './logical-index.js';
import { groupingSignalState } from './group-signals.js';
import { roleShortlist } from './role-catalog.js';

export async function profile(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {} });
  const documentResults: JevValues = {};
  for (const document of selectedDocuments(context, request)) {
    const entities = [...context.settings.people.map(person => ({ id: person.id, name: person.name, kind: 'person' })),
      ...context.vocabulary.filter(term => term.kind === 'entity' && term.state === 'active')
        .map(term => ({ id: term.id, name: term.name, kind: 'entity' }))]
      .filter(entity => document.block.content.toLocaleLowerCase().includes(entity.name.toLocaleLowerCase())).slice(0, 8);
    const roleOptions = roleShortlist(document);
    const questions: Record<string, JevQuestion> = { role: choice('Which defined role best describes document passages?', roleOptions),
      keyPassage: choice('Choose a representative substantive passage for this document’s main subject. Several passages may qualify; prefer explanatory prose over a heading when both fit. Choose none when no supplied passage addresses the main subject.', evidenceCandidates(document)) };
    entities.forEach((_, index) => { questions[`entity_${index}`] = noul(`Is entityCandidates[${index}] meaningfully mentioned in document rather than an incidental match?`); });
    const logical = logicalIndexQuestions(context, document);
    Object.assign(questions, logical.questions);
    const answers = await judge(context, { document: sourceState(document), entityCandidates: entities, ...logical.state }, questions);
    const evidence = exactEvidence(document, answers.keyPassage);
    const values: JevValues = { role: selected(answers.role, context) ?? 'unknown',
      roleConfidence: confidence(answers.role), keyPassages: evidence.map(item => readablePassage(item.quote)),
      keyPassageSelectionConfidence: confidence(answers.keyPassage),
      entities: entities.filter((_, index) => supported(answers[`entity_${index}`], context)),
      logicalIndex: logicalIndexResult(context, document, answers),
      decisionOptions: { roleIds: Object.keys(roleOptions), topicCandidates: logicalTopicCandidateOrigins(context, document) },
      coverage: sourceState(document).coverage, analyzedAt: currentTime(context).toISOString() };
    documentResults[document.block.id] = values;
    result.proposals.push(derived(request, document, values, evidence));
  }
  result.result.documents = documentResults;
  return result;
}

function groupCandidates(context: JevEvaluationContext, document: JevInputDocument) {
  const existing = context.documents.filter(item => item.canvasId === document.canvasId)
    .flatMap(item => validGroupKey(item.block.group) ? [{ key: normalizedGroup(item.block.group)!, name: groupLabel(item.block.group),
      definition: `${item.block.title}: ${passages(item, 1).map(passage => passage.quote).join(' ')}` }] : []);
  const vocabulary = context.vocabulary.filter(term => term.kind === 'group' && term.state === 'active')
    .map(term => ({ key: vocabularyGroupKey(term), name: term.name, definition: term.definition }));
  const definitions = context.canvases.find(canvas => canvas.id === document.canvasId)?.groups ?? [];
  const groups = [...existing, ...vocabulary, ...definitions.filter(group => validGroupKey(group.id))
    .map(group => ({ key: membershipGroupKey(group.id), name: group.name, definition: group.definition ?? group.name }))];
  return [...new Map(groups.map(group => [group.key, group])).values()]
    .filter(group => reusableGroup(context, document, group)).sort((left, right) => Number(left.key.includes('/')) - Number(right.key.includes('/'))).slice(0, 16);
}
export async function file(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {} });
  for (const document of selectedDocuments(context, request)) {
    appendGrouping(result, await fileDocument(context, request, document), document);
  }
  coalesceGroupDefinitions(result);
  result.result.proposalCount = result.proposals.length;
  return result;
}
async function fileDocument(context: JevEvaluationContext, request: JevActionRequest, document: JevInputDocument): Promise<JevEvaluation> {
    const discoveryContext = context;
    let groups = groupCandidates(context, document);
    if (!groups.length) return bootstrapGrouping(context, request, document);
    if (groups.length === 1 && context.shareQuestionSources) context = { ...context, selectiveGroupAssessment: false };
    const rejected: string[] = [];
    const assessed = groups.filter(group => group.key !== normalizedGroup(document.block.group));
    const answers = await judgeQuestionSets(context, [existingGroupSelection(context, document, groups),
      ...assessed.map(group => groupAssessmentSet(context, document, group))]);
    const assessments = new Map(assessed.map((group, index) => [group.key, answers[index + 1]]));
    for (let attempt = 0; attempt < 3 && groups.length; attempt++) {
      const selection = await existingSelectionAnswers(context, document, groups, attempt, answers[0]);
      const group = groups.find((_, index) => `g${index}` === selected(selection.group, context));
      if (!group) break;
      const assessment = await completeGroupAssessment(context, document, group, assessments.get(group.key) ?? {});
      const result = checkedExistingGroup(context, request, document, group, confidence(selection.group), assessment);
      if (result) return result;
      rejected.push(group.key); groups = groups.filter(candidate => candidate.key !== group.key);
    }
    return bootstrapGrouping(discoveryContext, request, document, rejected);
}
async function existingSelectionAnswers(context: JevEvaluationContext, document: JevInputDocument,
  groups: ReturnType<typeof groupCandidates>, attempt: number, initial: Record<string, JevAnswer>) {
  if (!attempt) return initial;
  const next = existingGroupSelection(context, document, groups);
  return judge(context, next.state, next.questions);
}
function existingGroupSelection(context: JevEvaluationContext, document: JevInputDocument, groups: ReturnType<typeof groupCandidates>) {
  return { state: groupingState(context, document), questions: {
    group: choice('Which existing shared topic describes this document’s main subject? Match source passages to the supplied group definitions. A broad category can contain different documents about that subject. Use checked logical topics and labels in organizationSignals as supporting context; a link alone is insufficient. Prefer a root topic unless the document belongs in a supplied shared subgroup. Choose none if no definition fits, or unknown if the passages are insufficient.', candidates(
      groups.map((group, index) => ({ id: `g${index}`, description: `${group.name} (${group.key}): ${group.definition}` })))),
  } };
}
function checkedExistingGroup(context: JevEvaluationContext, request: JevActionRequest, document: JevInputDocument,
  group: { key: string; name: string; definition: string }, selectionConfidence: number, answers: Record<string, JevAnswer>): JevEvaluation | undefined {
    if (group.key === normalizedGroup(document.block.group)) return evaluation();
    const assessment = groupAssessmentDecision(context, document, group, answers);
    if (!assessment) return undefined;
    const { evidence, confidences } = assessment;
    const candidate = proposal(request, { kind: 'document', canvasId: document.canvasId,
      blockId: document.block.id, patch: { group: group.key } }, [document], `File under ${group.name}`,
    group.definition, evidence);
    candidate.decisionConfidences = [selectionConfidence, ...confidences];
    const result = evaluation(); result.proposals.push(candidate);
  return result;
}
function groupingState(context: JevEvaluationContext, document: JevInputDocument): JevValues {
  return { document: filingState(document), currentGroup: document.block.group ?? null, organizationSignals: groupingSignalState(context, document) };
}
function appendGrouping(result: JevEvaluation, generated: JevEvaluation, document: JevInputDocument): void {
  result.proposals.push(...generated.proposals);
  if (generated.result.status !== undefined) result.result.status = generated.result.status;
  const documents = result.result.documents as JevValues;
  documents[document.block.id] = { ...generated.result,
    status: generated.result.status ?? (generated.proposals.length ? 'proposed' : 'no_change'), source: json(document.snapshot) };
}

function labelCandidates(context: JevEvaluationContext, document: JevInputDocument) {
  const terms = context.vocabulary.filter(term => term.kind === 'label' && term.state === 'active')
    .map(term => ({ name: term.name, definition: term.definition,
      member: term.members.some(member => member.canvasId === document.canvasId && member.blockId === document.block.id) }));
  const existing = context.documents.flatMap(item => (item.block.tags ?? []).map(tagLabel));
  const current = new Set(document.block.tags ?? []);
  const saved = [...current].map(tagLabel).concat(existing, terms);
  const indexed = groupingSignalState(context, document).logicalIndex?.topics.map(topic => topic.name) ?? [];
  const indexedNames = new Set(indexed.map(name => name.toLocaleLowerCase()));
  const discovered = sourceLabelCandidates(context, document, indexed)
    .filter(term => !saved.length || indexedNames.has(term.name.toLocaleLowerCase()));
  // Existing definitions and source membership outrank same-name newly discovered topics.
  const candidates = [...new Map([...discovered, ...saved]
    .map(term => [term.name.toLocaleLowerCase(), term])).values()];
  const sourceText = sourcePassages(document.block.content).map(passage => passage.text).join(' ');
  return candidates.map(candidate => ({ ...candidate, priority: Number(current.has(candidate.name)) * 2 + Number(candidate.member),
    relevance: lexicalScore(candidate.name, document.block.title) * 2 + lexicalScore(candidate.name, sourceText) }))
    .sort((left, right) => right.priority - left.priority || right.relevance - left.relevance).slice(0, context.prefetchLabelCandidateLimit ?? 8)
    .map(({ name, definition }) => ({ name, definition }));
}
function sourceLabelCandidates(context: JevEvaluationContext, document: JevInputDocument, indexed: string[] = []) {
  const neighbors = [document, ...context.documents.filter(source => source.block.id !== document.block.id
    && source.canvasId === document.canvasId)].slice(0, 64);
  const names = [...indexed, ...sharedSourceCategories(neighbors, document).map(category => category.name),
    ...semanticHeadingNames(document.block.content)];
  const removed = new Set((document.block.jevOwnership?.removedLabels ?? []).map(name => name.toLocaleLowerCase()));
  const retired = new Set(context.vocabulary.filter(term => term.kind === 'label' && term.state === 'retired')
    .flatMap(term => [term.name, ...term.aliases]).map(name => name.toLocaleLowerCase()));
  return [...new Map(names.map(name => [name.toLocaleLowerCase(), name])).values()]
    .filter(name => name.trim().length >= 2 && name.length <= 40
      && !removed.has(name.toLocaleLowerCase()) && !retired.has(name.toLocaleLowerCase())).map(tagLabel);
}
function tagLabel(name: string) { return { name, definition: `Documents about ${name}`, member: false }; }
function labelQuestionSet(document: JevInputDocument, labels: Array<{ name: string; definition: string }>) {
  const questions: Record<string, JevQuestion> = {};
  labels.forEach((_, index) => {
    questions[`label_${index}`] = noul(`Is document substantially about labelCandidates[${index}] rather than a passing mention?`);
    questions[`evidence_${index}`] = choice(`Which exact passage supports labelCandidates[${index}]?`, evidenceCandidates(document));
  });
  return { state: { document: sourceState(document), labelCandidates: labels }, questions };
}
async function labelAnswers(context: JevEvaluationContext, document: JevInputDocument, labels: Array<{ name: string; definition: string }>) {
  if (!context.shareQuestionSources) {
    const set = labelQuestionSet(document, labels);
    return judge(context, set.state, set.questions);
  }
  const sets = labels.map(candidate => labelQuestionSet(document, [candidate]));
  const answers = await judgeQuestionSets(context, sets);
  return Object.fromEntries(answers.flatMap((answer, index) => [
    [`label_${index}`, answer.label_0], [`evidence_${index}`, answer.evidence_0],
  ]));
}
export async function label(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {} });
  const decisions = result.result.documents as JevValues;
  for (const document of selectedDocuments(context, request)) {
    const labels = labelCandidates(context, document);
    const options = labels.map(label => ({ ...label, origin: context.vocabulary.some(term => term.kind === 'label'
      && term.state === 'active' && term.name === label.name) ? 'validated_definition'
      : (document.block.tags ?? []).includes(label.name) ? 'existing_label' : 'source_phrase' }));
    if (!labels.length) {
      result.result.status = 'missing_label_vocabulary';
      decisions[document.block.id] = { status: 'no_change', reason: 'No supported label candidates', options };
      continue;
    }
    const answers = await labelAnswers(context, document, labels);
    const current = document.block.tags ?? [];
    const desired = new Set(current);
    const decisionConfidences: number[] = [];
    const evidence = labels.flatMap((candidate, index) => {
      const support = exactEvidence(document, answers[`evidence_${index}`]);
      if (supported(answers[`label_${index}`], context) && support.length) {
        if (!desired.has(candidate.name)) decisionConfidences.push(confidence(answers[`label_${index}`]));
        desired.add(candidate.name); return support;
      }
      if (1 - confidence(answers[`label_${index}`]) >= semanticThreshold(context) && desired.delete(candidate.name)) decisionConfidences.push(1 - confidence(answers[`label_${index}`]));
      return [];
    });
    const tags = [...desired].slice(0, 20);
    if (JSON.stringify(tags) === JSON.stringify(current)) {
      decisions[document.block.id] = { status: 'no_change', reason: 'Validated labels already match source', options };
      continue;
    }
    const candidate = proposal(request, { kind: 'document', canvasId: document.canvasId,
      blockId: document.block.id, patch: { tags } }, [document], 'Update supported labels',
    'Add supported labels and remove unsupported candidates; executor preserves explicit ownership', evidence);
    candidate.decisionConfidences = decisionConfidences;
    result.proposals.push(candidate);
    decisions[document.block.id] = { status: 'proposed', options, tags, decisionConfidences };
  }
  result.result.proposalCount = result.proposals.length;
  return result;
}
