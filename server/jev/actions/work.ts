import type { JevActionRequest,JevEvaluation,JevPassage,JevValues } from '../../../shared/jev-types.js';
import type { CanvasTask } from '../../../shared/types.js';
import { ApiError } from '../../errors.js';
import { choice,noul,score,type JevAnswer,type JevQuestion,type ScoreAnswer } from '../../jev.js';
import {
candidates,
confidence,evaluation,evidenceCandidates,exactEvidence,
passages,proposal,selected,selectedDocuments,semanticThreshold,sourceState,supported,textOption,
type JevEvaluationContext,type JevInputDocument
} from './context.js';
import { judgeQuestionSets } from './question-batch.js';

function taskCandidates(context: JevEvaluationContext, request: JevActionRequest) {
  const taskId = textOption(request, 'taskId');
  const tasks = context.tasks.filter(item => item.canvasId === request.canvasId);
  if (!taskId) return tasks.slice(0, 12);
  const selected = tasks.filter(item => item.task.id === taskId);
  if (!selected.length) throw new ApiError(404, 'Requested task is unavailable');
  return selected;
}
function updateTask(request: JevActionRequest, task: CanvasTask, patch: Partial<CanvasTask>,
  documents: JevInputDocument[], title: string, evidence: JevPassage[], certainty?: number) {
  return proposal(request, { kind: 'task_update', canvasId: request.canvasId,
    taskId: task.id, expectedUpdatedAt: task.updatedAt, expectedRevision: task.revision, patch }, documents, title,
  'Exact proposed fields are applied only after scope, ownership, source and task revision checks', evidence, certainty);
}
function taskState(task: CanvasTask) {
  return { title: task.title, detail: task.detail, criteria: task.acceptanceCriteria ?? [] };
}
type TaskSource = { source: JevInputDocument; task: CanvasTask };
type Answers = Record<string, JevAnswer>;
function attachmentPairs(context: JevEvaluationContext, request: JevActionRequest): TaskSource[] {
  return selectedDocuments(context, request).flatMap(source => taskCandidates(context, request)
    .filter(({ task }) => !task.blockIds.includes(source.block.id)).map(({ task }) => ({ source, task })));
}
function attachmentSet({ source, task }: TaskSource) {
  return { state: { document: sourceState(source), task: taskState(task) }, questions: {
    matches: noul('Does document directly concern task work or a declared acceptance criterion?'),
    evidence: choice('Which exact document passage supports attachment to task?', evidenceCandidates(source)) } };
}
function attachmentProposal(context: JevEvaluationContext, request: JevActionRequest, { source, task }: TaskSource, answers: Answers) {
  const evidence = exactEvidence(source, answers.evidence);
  if (!supported(answers.matches, context) || !evidence.length) return undefined;
  return updateTask(request, task, { blockIds: [...task.blockIds, source.block.id] },
    [source], `Attach to ${task.title}`, evidence, confidence(answers.matches));
}

export async function attachDocToTask(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation();
  const pairs = attachmentPairs(context, request);
  const answers = await judgeQuestionSets(context, pairs.map(attachmentSet));
  for (const [index, pair] of pairs.entries()) {
    const candidate = attachmentProposal(context, request, pair, answers[index]);
    if (candidate) result.proposals.push(candidate);
  }
  result.result.proposalCount = result.proposals.length;
  return result;
}
type AssignmentRole = ReturnType<typeof assignmentRole>;
type KnownPerson = JevEvaluationContext['settings']['people'][number];
type SelectedOwner = TaskSource & { person: KnownPerson; certainty: number; evidence: JevAnswer };
function ownerPairs(context: JevEvaluationContext, request: JevActionRequest): TaskSource[] {
  return taskCandidates(context, request).flatMap(({ task }) => selectedDocuments(context, request).map(source => ({ source, task })));
}
function passageReferences(source: JevInputDocument) {
  return candidates(passages(source).map((_, index) => ({ id: `p${index}`, description: `Exact source.passages entry with id p${index}` })));
}
function ownerSelectionSet({ source, task }: TaskSource, people: KnownPerson[], role: AssignmentRole) {
  const references = passageReferences(source);
  const evidence = Object.fromEntries(people.map((_, index) => [`evidence_${index}`, choice(
    `Which exact source passage explicitly assigns assignment.responsibility for this task to people[${index}]? Mere mention or authorship is insufficient. Choose none without exact responsibility evidence.`, references)]));
  return { state: { source: sourceState(source), task: taskState(task), people,
    assignment: { field: role.field, responsibility: role.description } }, questions: {
    person: choice(`Which known person is explicitly responsible for ${role.verb} this task? Mere mention/authorship is insufficient.`,
      candidates(people.map((person, index) => ({ id: `person${index}`, description: `${person.name}: ${person.role}` })))),
    ...evidence,
  } };
}
function selectedOwners(context: JevEvaluationContext, pairs: TaskSource[], people: KnownPerson[], answers: Answers[]): SelectedOwner[] {
  return pairs.flatMap((pair, index) => {
    const personIndex = people.findIndex((_, personIndex) => `person${personIndex}` === selected(answers[index].person, context));
    return personIndex >= 0 ? [{ ...pair, person: people[personIndex], certainty: confidence(answers[index].person),
      evidence: answers[index][`evidence_${personIndex}`] }] : [];
  });
}
function ownerProposal(request: JevActionRequest, { source, task, person, certainty, evidence: answer }: SelectedOwner, role: AssignmentRole) {
  const evidence = exactEvidence(source, answer);
  if (!evidence.length) return undefined;
  return updateTask(request, task, { [role.field]: person.id },
    [source], `Assign ${person.name} as ${role.label}`, evidence, certainty);
}

export async function assignOwner(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation();
  const role = assignmentRole(request);
  const people = context.settings.people.slice(0, 24);
  if (!people.length) return evaluation({ status: 'no_known_people' });
  const pairs = ownerPairs(context, request);
  const selections = await judgeQuestionSets(context, pairs.map(pair => ownerSelectionSet(pair, people, role)));
  const owners = selectedOwners(context, pairs, people, selections);
  for (const owner of owners) {
    const candidate = ownerProposal(request, owner, role);
    if (candidate) result.proposals.push(candidate);
  }
  result.result.proposalCount = result.proposals.length;
  return result;
}
function assignmentRole(request: JevActionRequest) {
  if (textOption(request, 'subaction') === 'assign_reviewer') return {
    field: 'reviewer', verb: 'reviewing', description: 'review responsibility', label: 'reviewer' } as const;
  return { field: 'assignee', verb: 'owning', description: 'ownership', label: 'owner' } as const;
}

const qualityLevels = ['Insufficient evidence', 'Substantial gaps', 'Partly supported', 'Well supported'] as const;
const qualityDimensions = ['specificity', 'traceability', 'declaredPurposeCompleteness', 'internalConsistency'];
function qualityScoreSet(source: JevInputDocument) {
  const questions: Record<string, JevQuestion> = {};
  const references = passageReferences(source);
  for (const dimension of qualityDimensions) {
    questions[dimension] = score(`Assess ${dimension} only against explicit purpose and source passages; missing evidence is unknown.`, qualityLevels);
    qualityLevels.forEach((label, level) => { questions[`${dimension}Evidence_${level}`] = choice(
      `Which exact source passage supports ${dimension} at numeric level ${level} (${label}) on qualityLevels? Choose none when that assessment lacks source evidence.`, references); });
  }
  return { state: { source: sourceState(source), declaredPurpose: source.block.purpose ?? null, qualityLevels }, questions };
}
function qualityRubric(context: JevEvaluationContext, source: JevInputDocument, answers: Answers, assessment: Answers) {
  const rubric: JevValues = {};
  const evidence = qualityDimensions.flatMap(dimension => {
    const score = (answers[dimension] as ScoreAnswer).score;
    const support = exactEvidence(source, Number.isInteger(score) ? answers[`${dimension}Evidence_${score}`] : assessment[`${dimension}Evidence`]);
    rubric[dimension] = support.length ? qualityAssessment(context, answers[dimension] as ScoreAnswer) : { status: 'insufficient_evidence' };
    return support;
  });
  return { rubric, evidence };
}
export async function scoreQuality(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {} });
  const documents: JevValues = {};
  const sources = selectedDocuments(context, request);
  const scores = await judgeQuestionSets(context, sources.map(qualityScoreSet));
  const assessments = await fractionalQualityEvidence(context, sources, scores);
  for (const [index, source] of sources.entries()) {
    const { rubric, evidence } = qualityRubric(context, source, scores[index], assessments[index]);
    documents[source.block.id] = { rubric, advisory: true };
    result.proposals.push(proposal(request, { kind: 'derived', blockId: source.block.id, values: { qualityRubric: rubric, advisory: true } },
      [source], 'Inspect purpose-specific quality', 'Individual dimensions are advisory; no composite score authorizes writes or ranks people', evidence));
  }
  result.result.documents = documents;
  return result;
}
function qualityAssessment(context: JevEvaluationContext, answer: ScoreAnswer): JevValues {
  if (answer.confidence < semanticThreshold(context)) return { score: answer.score,
    confidence: answer.confidence, status: 'uncertain' };
  return { score: answer.score, confidence: answer.confidence };
}
function qualityEvidenceSet(source: JevInputDocument, answers: Answers) {
  const dimensions = qualityDimensions.filter(dimension => !Number.isInteger((answers[dimension] as ScoreAnswer).score));
  const assessments = Object.fromEntries(dimensions.map(dimension => [dimension, {
    score: (answers[dimension] as ScoreAnswer).score, scale: qualityLevels,
  }]));
  const questions = Object.fromEntries(dimensions.map(dimension => [`${dimension}Evidence`,
    choice(`Which exact passage supports the numeric score on the supplied scale in assessments.${dimension}? Choose none when the assessment lacks source evidence.`, evidenceCandidates(source))]));
  return { state: { source: sourceState(source), declaredPurpose: source.block.purpose ?? null, assessments }, questions };
}
async function fractionalQualityEvidence(context: JevEvaluationContext, sources: JevInputDocument[], scores: Answers[]): Promise<Answers[]> {
  const sets = sources.map((source, index) => ({ index, set: qualityEvidenceSet(source, scores[index]) }))
    .filter(({ set }) => Object.keys(set.questions).length);
  const answers = await judgeQuestionSets(context, sets.map(({ set }) => set));
  const result: Answers[] = sources.map(() => ({}));
  sets.forEach(({ index }, position) => { result[index] = answers[position]; });
  return result;
}
