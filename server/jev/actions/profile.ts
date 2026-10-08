import { groupLabel,normalizedGroup,validGroupKey } from '../../../shared/groups.js';
import type { JevActionRequest,JevEvaluation,JevValues,JevPassage } from '../../../shared/jev-types.js';
import { choice,noul,type JevQuestion } from '../../jev.js';
import {
confidence,
currentTime,
derived,evaluation,evidenceCandidates,exactEvidence,
json,
judge,
passages,proposal,selected,selectedDocuments,semanticThreshold,sourceState,supported,
type JevEvaluationContext,type JevInputDocument
} from './context.js';
import { filingDecision, filingQuestionSet, filingEvidenceQuestionSet, refinementQuestionSet, type FilingGroup } from './filing-selection.js';
import { reusableGroup } from './group-topics.js';
import { assessGroupRefinement,bootstrapGrouping,coalesceGroupDefinitions,sharedGroupRefinements } from './grouping.js';
import { completeGroupAssessment,groupAssessmentDecision } from './group-assessment.js';
import { judgeQuestionSets } from './question-batch.js';
import type { JevAnswer } from '../../jev.js';
import { membershipGroupKey,vocabularyGroupKey } from './groups.js';
import { outlineState, readablePassage, semanticHeadingNames, sourcePassages } from './source-passages.js';
import { sharedSourceCategories } from './source-categories.js';
import { lexicalScore } from './candidates.js';
import { logicalIndexQuestions, logicalIndexResult, logicalTopicCandidateOrigins, type TopicCandidate, type FreshProfileTopic, freshProfileTopics, freshProfileLabelRejections, topicMembershipConfidence } from './logical-index.js';
import { groupingSignalState } from './group-signals.js';
import { roleShortlist } from './role-catalog.js';
import { topicCategoryCandidates } from './topic-category-candidates.js';
import { canonicalGroupScope } from './canonical-group-scope.js';

export function profileQuestionSet(context: JevEvaluationContext, document: JevInputDocument, nominated?: readonly TopicCandidate[]) {
  const entities = [...context.settings.people.map(person => ({ id: person.id, name: person.name, kind: 'person' })),
    ...context.vocabulary.filter(term => term.kind === 'entity' && term.state === 'active')
    .map(term => ({ id: term.id, name: term.name, kind: 'entity' }))]
    .filter(entity => document.block.content.toLocaleLowerCase().includes(entity.name.toLocaleLowerCase())).slice(0, 8);
  const roleOptions = roleShortlist(document);
  const questions: Record<string, JevQuestion> = { role: choice('Which defined role best describes document passages?', roleOptions),
    keyPassage: choice('Choose a representative substantive passage for this document’s main subject. Several passages may qualify; prefer explanatory prose over a heading when both fit. Choose none when no supplied passage addresses the main subject.', evidenceCandidates(document)) };
  entities.forEach((_, index) => { questions[`entity_${index}`] = noul(`Is entityCandidates[${index}] meaningfully mentioned in document rather than an incidental match?`); });
  const logical = logicalIndexQuestions(context, document, nominated);
  Object.assign(questions, logical.questions);
  return { state: { document: outlineState(document, 30), entityCandidates: entities, ...logical.state }, questions, entities, roleOptions };
}

export async function profile(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {} });
  const documentResults: JevValues = {};
  for (const document of selectedDocuments(context, request)) {
    const { state, questions, entities, roleOptions } = profileQuestionSet(context, document);
    const answers = await judge(context, state, questions);
    const evidence = exactEvidence(document, answers.keyPassage);
    const values: JevValues = { calibration: 1, role: selected(answers.role, context) ?? 'unknown',
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
  const current = normalizedGroup(document.block.group);
  return [...new Map(groups.map(group => [group.key, group])).values()]
    .flatMap(group => {
      const canonical = canonicalGroupScope(context, document.canvasId, { ...group, origins: [] });
      return canonical.retired ? [] : [{ ...canonical.group, definition: canonical.group.definition ?? canonical.group.name }];
    })
    .filter(group => reusableGroup(context, document, group)).sort((left, right) =>
      Number(right.key === current) - Number(left.key === current)
      || Number(left.key.includes('/')) - Number(right.key.includes('/'))).slice(0, 16);
}
export async function file(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {}, calibration: 1 });
  for (const document of selectedDocuments(context, request)) {
    appendGrouping(result, await fileDocument(context, request, document), document);
  }
  coalesceGroupDefinitions(result);
  result.result.proposalCount = result.proposals.length;
  return result;
}
async function fileDocument(context: JevEvaluationContext, request: JevActionRequest, document: JevInputDocument): Promise<JevEvaluation> {
  const groups = groupCandidates(context, document);
  if (!groups.length) return filingFallback(context, request, document, groups);
  const set = filingQuestionSet(context, document, groups, false);
  const answers = await judge(context, set.state, set.questions);
  const selected = filingDecision(context, document, groups, answers);
  if (!selected) return filingFallback(context, request, document, groups);
  const refined = await preferredGroupRefinement(context, request, document, selected.group);
  return refined ?? placeSelectedGroup(context, request, document, selected, groups);
}
async function filingFallback(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, groups: FilingGroup[], rejectedKeys: string[] = []): Promise<JevEvaluation> {
  if (!refinableGroupOwnership(document)) return evaluation();
  const current = groups.find(group => group.key === normalizedGroup(document.block.group));
  const alternatives = sharedGroupRefinements(context, document, current?.key ?? '')
    .filter(group => !rejectedKeys.includes(group.key));
  if (hasSourceBackedAlternative(alternatives)) return refinementAttempts(context, request, document, current, alternatives);
  return bootstrapGrouping(context, request, document, rejectedKeys, { sourceSubjects: true });
}
function hasSourceBackedAlternative(groups: ReturnType<typeof sharedGroupRefinements>): boolean {
  return groups.some(group => Boolean(group.nomination));
}
async function preferredGroupRefinement(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, selected: FilingGroup): Promise<JevEvaluation | undefined> {
  const currentGroup = normalizedGroup(document.block.group);
  const refined = await refineSelectedGroup(context, request, document, selected);
  if (!refined.proposals.length) return currentGroup === selected.key ? refined : undefined;
  // A verified return to the current subject must also prevent the broad initial winner from applying.
  refined.proposals = refined.proposals.filter(candidate => candidate.mutation.kind !== 'document'
    || candidate.mutation.patch.group !== currentGroup);
  if (!refined.proposals.length) refined.result.status = 'no_change';
  return refined;
}
async function placeSelectedGroup(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, selected: { group: FilingGroup; confidence: number }, groups: FilingGroup[]): Promise<JevEvaluation> {
  const evidenceSet = filingEvidenceQuestionSet(document, selected.group);
  const assessment = await judge(context, evidenceSet.state, evidenceSet.questions);
  const checked = await checkedFilingEvidence(context, document, selected.group, assessment);
  if (!checked) return filingFallback(context, request, document, groups, [selected.group.key]);
  const candidate = proposal(request, { kind: 'document', canvasId: document.canvasId,
    blockId: document.block.id, patch: { group: selected.group.key } }, [document], `File under ${selected.group.name}`,
    selected.group.definition, checked.evidence);
  candidate.decisionConfidences = [selected.confidence, ...checked.confidences];
  return { result: { calibration: 1 }, proposals: [candidate] };
}
async function refineSelectedGroup(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, current: FilingGroup): Promise<JevEvaluation> {
  if (!refinableGroupOwnership(document)) return evaluation();
  const alternatives = sharedGroupRefinements(context, document, current.key);
  if (!alternatives.length) return evaluation();
  return refinementAttempts(context, request, document, current, alternatives);
}
function refinableGroupOwnership(document: JevInputDocument): boolean {
  const ownership = document.block.jevOwnership;
  if (ownership?.pins.includes('group')) return false;
  return !normalizedGroup(document.block.group) || Boolean(ownership?.managed.includes('group'));
}
async function refinementAttempts(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, current: FilingGroup | undefined, alternatives: ReturnType<typeof sharedGroupRefinements>): Promise<JevEvaluation> {
  let result = evaluation();
  for (let attempt = 0; attempt < 3 && alternatives.length; attempt++) {
    const selected = await selectRefinement(context, document, current, alternatives);
    if (!selected) return evaluation();
    result = await assessGroupRefinement(context, request, document, selected.group, selected.confidence);
    if (result.proposals.length) return result;
    alternatives = alternatives.filter(group => group.key !== selected.group.key);
  }
  return result;
}
async function selectRefinement(context: JevEvaluationContext, document: JevInputDocument,
  current: FilingGroup | undefined, alternatives: ReturnType<typeof sharedGroupRefinements>) {
  const set = refinementQuestionSet(context, document, current, alternatives);
  const answers = await judge(context, set.state, set.questions);
  const selected = filingDecision(context, document, set.groups, answers);
  const refinement = alternatives.find(group => group.key === selected?.group.key);
  return refinement && selected ? { group: refinement, confidence: selected.confidence } : undefined;
}
async function checkedFilingEvidence(context: JevEvaluationContext, document: JevInputDocument,
  group: FilingGroup, answers: Record<string, JevAnswer>) {
  const selective = { ...context, selectiveGroupAssessment: true };
  const checked = await completeGroupAssessment(selective, document, group, answers);
  return groupAssessmentDecision(selective, document, group, checked);
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
  const discovered = sourceLabelCandidates(context, document, indexed);
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
  const categories = topicCategoryCandidates(context, document);
  const checked = indexed.filter(name => categories.some(category => category.name === name));
  const names = [...(checked.length ? checked : indexed), ...sharedSourceCategories(neighbors, document).map(category => category.name),
    ...(checked.length ? [] : semanticHeadingNames(document.block.content))];
  const removed = new Set((document.block.jevOwnership?.removedLabels ?? []).map(name => name.toLocaleLowerCase()));
  const retired = new Set(context.vocabulary.filter(term => term.kind === 'label' && term.state === 'retired')
    .flatMap(term => [term.name, ...term.aliases]).map(name => name.toLocaleLowerCase()));
  return [...new Map(names.map(name => [name.toLocaleLowerCase(), name])).values()]
    .filter(name => name.trim().length >= 2 && name.length <= 40
      && !removed.has(name.toLocaleLowerCase()) && !retired.has(name.toLocaleLowerCase()))
    .map(name => ({ ...tagLabel(name), definition: categories.find(category => category.name === name)?.definition ?? tagLabel(name).definition }));
}
function tagLabel(name: string) { return { name, definition: `Documents about ${name}`, member: false }; }
export function labelQuestionSet(document: JevInputDocument, labels: Array<{ name: string; definition: string }>) {
  const questions: Record<string, JevQuestion> = {};
  labels.forEach((label, index) => {
    const topic = `labelCandidates[${index}]: name ${JSON.stringify(label.name)}; definition ${JSON.stringify(label.definition)}`;
    questions[`label_${index}`] = noul(`Does this document belong to the subject category ${topic}? Judge topical membership from this document's substantive passages. The document need not explain or define the category itself. An explicit source title or heading is topic evidence when the surrounding substantive passages fit that scope. Reject incidental mentions, unrelated categories, and a launch reference that does not describe a main subject of this document.`);
    questions[`evidence_${index}`] = choice(`Which exact document passage supports topical membership in ${topic}? Choose none when the local passages do not substantively establish this topic.`, evidenceCandidates(document));
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
type LabelCandidate = { name: string; definition: string };
type LabelPlan = { desired: Set<string>; evidence: JevPassage[]; decisionConfidences: number[] };
function labelOrigin(context: JevEvaluationContext, document: JevInputDocument, name: string): string {
  const validated = context.vocabulary.some(term => term.kind === 'label' && term.state === 'active' && term.name === name);
  if (validated) return 'validated_definition';
  return (document.block.tags ?? []).includes(name) ? 'existing_label' : 'source_phrase';
}
function reuseProfileLabels(context: JevEvaluationContext, document: JevInputDocument,
  topics: FreshProfileTopic[], rejections: Array<{ name: string; confidence: number }>): LabelPlan {
  const plan: LabelPlan = { desired: new Set(document.block.tags ?? []), evidence: [], decisionConfidences: [] };
  for (const rejection of rejections) {
    if (plan.desired.delete(rejection.name)) plan.decisionConfidences.push(rejection.confidence);
  }
  for (const topic of topics) {
    if (topic.confidence < semanticThreshold(context)) continue;
    addSupportedLabel(plan, topic.name, topic.confidence, topic.evidence);
  }
  return plan;
}
function addSupportedLabel(plan: LabelPlan, name: string, value: number, evidence: JevPassage[]): void {
  if (!plan.desired.has(name)) plan.decisionConfidences.push(value);
  plan.desired.add(name);
  plan.evidence.push(...evidence);
}
function judgeLabelCandidate(context: JevEvaluationContext, document: JevInputDocument, plan: LabelPlan,
  candidate: LabelCandidate, supportAnswer: JevAnswer | undefined, evidenceAnswer: JevAnswer | undefined): void {
  const evidence = exactEvidence(document, evidenceAnswer);
  // judge validates every requested noul before any label candidate is evaluated.
  const value = topicMembershipConfidence(supportAnswer)!;
  if (value >= semanticThreshold(context) && evidence.length) {
    addSupportedLabel(plan, candidate.name, value, evidence);
    return;
  }
  if (1 - value >= semanticThreshold(context) && plan.desired.delete(candidate.name)) plan.decisionConfidences.push(1 - value);
}
function labelDecision(result: JevEvaluation, document: JevInputDocument, decision: JevValues): void {
  (result.result.documents as JevValues)[document.block.id] = decision;
}
function proposeLabels(result: JevEvaluation, request: JevActionRequest, document: JevInputDocument,
  plan: LabelPlan, options: JevValues[]): void {
  const tags = [...plan.desired].slice(0, 20);
  if (JSON.stringify(tags) === JSON.stringify(document.block.tags ?? [])) {
    labelDecision(result, document, { status: 'no_change', reason: 'Validated labels already match source', options });
    return;
  }
  const candidate = proposal(request, { kind: 'document', canvasId: document.canvasId,
    blockId: document.block.id, patch: { tags } }, [document], 'Update supported labels',
    'Add supported labels and remove unsupported candidates; executor preserves explicit ownership', plan.evidence);
  candidate.decisionConfidences = plan.decisionConfidences;
  result.proposals.push(candidate);
  labelDecision(result, document, { status: 'proposed', options, tags, decisionConfidences: plan.decisionConfidences });
}
function missingLabelCandidates(labels: LabelCandidate[], reusable: FreshProfileTopic[], rejected: Array<{ name: string }>): boolean {
  return !labels.length && !reusable.length && !rejected.length;
}
async function labelDocument(context: JevEvaluationContext, request: JevActionRequest,
  result: JevEvaluation, document: JevInputDocument): Promise<void> {
  const fresh = freshProfileTopics(context, document);
  const labels = fresh === undefined ? labelCandidates(context, document) : [];
  const options = labels.map(candidate => ({ ...candidate, origin: labelOrigin(context, document, candidate.name) }));
  const rejected = fresh === undefined ? [] : freshProfileLabelRejections(context, document);
  const reusable = fresh ?? [];
  if (missingLabelCandidates(labels, reusable, rejected)) {
    result.result.status = 'missing_label_vocabulary';
    labelDecision(result, document, { status: 'no_change', reason: 'No supported label candidates', options });
    return;
  }
  const answers = labels.length ? await labelAnswers(context, document, labels) : {};
  const plan = reuseProfileLabels(context, document, reusable, rejected);
  labels.forEach((candidate, index) => judgeLabelCandidate(context, document, plan,
    candidate, answers[`label_${index}`], answers[`evidence_${index}`]));
  proposeLabels(result, request, document, plan, options);
}
export async function label(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {}, calibration: 1 });
  for (const document of selectedDocuments(context, request)) await labelDocument(context, request, result, document);
  result.result.proposalCount = result.proposals.length;
  return result;
}
