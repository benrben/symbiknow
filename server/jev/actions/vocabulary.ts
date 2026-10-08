import { createHash } from 'node:crypto';
import type { JevActionRequest, JevDocumentPatch, JevEvaluation, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { ApiError } from '../../errors.js';
import { plainGroupName } from '../../../shared/names.js';
import { choice, noul, type JevAnswer } from '../../jev.js';
import { matchesGroupTerm, renamedGroupKey, vocabularyGroupKey } from './groups.js';
import { groupHierarchy } from './vocabulary-hierarchy.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import type { JevQuestionSet } from './question-batch.js';
import { arrayOption, candidates, confidence, evaluation, judge, passages, proposal, selected,
  selectedDocuments, semanticThreshold, sourceState, supported, textOption, type JevEvaluationContext,
  type JevInputDocument } from './context.js';

function kindFor(request: JevActionRequest): JevVocabularyTerm['kind'] {
  const kind = textOption(request, 'kind') || 'label';
  return kind as JevVocabularyTerm['kind'];
}
function findTerm(context: JevEvaluationContext, id: string): JevVocabularyTerm {
  const term = context.vocabulary.find(candidate => candidate.id === id);
  if (!term) throw new ApiError(404, 'Requested vocabulary term is unavailable');
  return term;
}
function uniqueMembers(documents: JevInputDocument[]) {
  return documents.map(document => ({ canvasId: document.canvasId, blockId: document.block.id }));
}
function termId(kind: string, name: string): string {
  return `${kind}_${createHash('sha256').update(name.toLocaleLowerCase().trim()).digest('hex').slice(0, 16)}`;
}
function affectedDocuments(context: JevEvaluationContext, term: JevVocabularyTerm): JevInputDocument[] {
  return context.documents.filter(document => term.members.some(member =>
    member.canvasId === document.canvasId && member.blockId === document.block.id) || actualMembership(document, term));
}
function actualMembership(document: JevInputDocument, term: JevVocabularyTerm): boolean {
  if (term.kind === 'group') return matchesGroupTerm(document.block.group, term);
  return term.kind === 'label' && Boolean(document.block.tags?.includes(term.name));
}
function termProposal(request: JevActionRequest, operation: string, term: JevVocabularyTerm,
  sources: JevInputDocument[], previousId?: string) {
  const checked = term.kind === 'group' ? { ...term, groupKey: vocabularyGroupKey(term) } : term;
  return proposal(request, { kind: 'vocabulary', operation, term: checked, ...(previousId ? { previousId } : {}) }, sources,
    `${operation} ${term.kind}: ${term.name}`, `${term.members.length} memberships; definition: ${term.definition}`,
    sources.flatMap(document => passages(document, 2)));
}
function migrateMemberships(result: JevEvaluation, request: JevActionRequest, documents: JevInputDocument[],
  previous: JevVocabularyTerm, next: JevVocabularyTerm) {
  for (const document of documents) {
    if (previous.kind === 'entity') continue;
    if (previous.kind === 'group' && !matchesGroupTerm(document.block.group, previous)) continue;
    const patch = membershipPatch(document, previous, next);
    result.proposals.push(proposal(request, { kind: 'document', canvasId: document.canvasId,
      blockId: document.block.id, patch }, [document], `Migrate membership to ${next.name}`,
    'Checked member migration preserves newer explicit edits and reports partial execution', passages(document, 2)));
  }
}
function membershipPatch(document: JevInputDocument, previous: JevVocabularyTerm, next: JevVocabularyTerm): JevDocumentPatch {
  if (previous.kind === 'group') return { group: vocabularyGroupKey(next) };
  return { tags: [...new Set((document.block.tags ?? []).map(tag => tag === previous.name ? next.name : tag))] };
}
function nominationNames(documents: JevInputDocument[]): string[] {
  const names = documents.flatMap(document => [document.block.title,
    ...(document.block.tags ?? []), ...document.block.content.split('\n')
      .filter(line => /^#{1,4}\s/.test(line)).map(plainGroupName)]);
  return [...new Set(names.map(name => name.trim()).filter(name => name.length >= 2 && name.length <= 80))].slice(0, 16);
}
async function nominate(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const documents = selectedDocuments(context, request);
  const explicitName = textOption(request, 'name');
  const names = explicitName ? [explicitName] : nominationNames(documents);
  if (!names.length) return evaluation({ status: 'no_text_derived_names' });
  const answers = await judge(context, { sources: documents.map(sourceState),
    proposedDefinition: textOption(request, 'definition') }, {
    concept: choice('Which supplied text-derived name denotes a coherent useful concept across these sources?',
      candidates(names.map((name, index) => ({ id: `n${index}`, description: name })))),
  });
  const name = names.find((_, index) => `n${index}` === selected(answers.concept, context));
  if (!name) return evaluation({ status: 'insufficient_concept_evidence' });
  const fitSet = nominationFitSet(request, name, documents);
  const assessment = await judge(context, fitSet.state, fitSet.questions);
  return defineAssessedConcept(context, request, documents, name, assessment.fit);
}
export function nominationFitSet(request: JevActionRequest, name: string, documents: JevInputDocument[]): JevQuestionSet {
  return { state: { sources: documents.map(sourceState), selectedConcept: assessedConcept(request, name) }, questions: {
    fit: noul('Do the visible sources substantively support this intended concept and scope? A label names a main topic; a group names a coherent shared subject; an entity must be meaningfully named. An explicit source category, title, or heading is valid topic evidence when the body fits it; prose need not define the label word. For visible_source_excerpts, the definition contains quoted scope examples, not a formal definition. For supplied_definition, verify its meaning against source facts. Reject incidental names and unrelated excerpts.'),
  } };
}
/** Selection and semantic assessment may share a request; proposals still require the selected concept's own fit. */
export async function defineAssessedConcept(context: JevEvaluationContext, request: JevActionRequest,
  documents: JevInputDocument[], name: string, fit: JevAnswer): Promise<JevEvaluation> {
  if (!supported(fit, context)) return evaluation({ status: 'insufficient_concept_evidence', confidence: confidence(fit) });
  const kind = kindFor(request);
  const existing = context.vocabulary.find(term => term.kind === kind && [term.name, ...term.aliases]
    .some(alias => alias.toLocaleLowerCase() === name.toLocaleLowerCase()));
  if (existing) return evaluation({ status: 'existing_concept', termId: existing.id });
  const term = await nominatedHierarchy(context, request, kind, name, documents);
  const result = evaluation({ status: 'proposed', distinctDocuments: documents.length, confidence: confidence(fit) });
  result.proposals.push(termProposal(request, 'define', term, documents));
  return result;
}
function assessedConcept(request: JevActionRequest, name: string) {
  return { name, kind: kindFor(request), definition: textOption(request, 'definition'),
    definitionBasis: textOption(request, 'definitionSource') || 'supplied_definition',
    nameOrigin: textOption(request, 'conceptOrigin') || 'supplied_name' };
}
async function nominatedHierarchy(context: JevEvaluationContext, request: JevActionRequest,
  kind: JevVocabularyTerm['kind'], name: string, documents: JevInputDocument[]): Promise<JevVocabularyTerm> {
  const term = nominatedTerm(request, kind, name, documents);
  if (kind === 'group') Object.assign(term, await groupHierarchy(context, request, name, documents));
  return term;
}
function nominatedTerm(request: JevActionRequest, kind: JevVocabularyTerm['kind'], name: string, documents: JevInputDocument[]): JevVocabularyTerm {
  return { id: termId(kind, name), kind, name,
    definition: textOption(request, 'definition') || documents.flatMap(document => passages(document, 1)).map(passage => passage.quote).join(' ').slice(0, 600),
    aliases: [], state: textOption(request, 'operation') === 'define' ? 'active' : 'candidate', version: 1,
    members: uniqueMembers(documents) };
}
function lifecycleState(operation: string): JevVocabularyTerm['state'] {
  return operation === 'retire' ? 'retired' : 'active';
}
async function changeTerm(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const operation = textOption(request, 'operation');
  const previous = findTerm(context, textOption(request, 'termId'));
  const documents = affectedDocuments(context, previous);
  const name = textOption(request, 'name') || previous.name;
  validateTermName(context, request, previous, name);
  const term = { ...changedTerm(request, previous, name), members: uniqueMembers(documents) };
  const result = evaluation({ status: 'proposed', affectedMembers: documents.length });
  result.proposals.push(termProposal(request, operation, term, documents));
  if (operation === 'rename') {
    migrateMemberships(result, request, documents, previous, term);
    migrateDescendants(result, context, request, previous, term);
  }
  return result;
}
function validateTermName(context: JevEvaluationContext, request: JevActionRequest, previous: JevVocabularyTerm, name: string) {
  const operation = textOption(request, 'operation');
  if (operation === 'rename' && !textOption(request, 'name')) throw new ApiError(400, 'Rename requires an explicit name');
  const collision = context.vocabulary.some(term => term.id !== previous.id && term.kind === previous.kind && term.name === name);
  if (collision) throw new ApiError(409, 'Vocabulary name already exists; use an explicit merge preview');
}
function changedTerm(request: JevActionRequest, previous: JevVocabularyTerm, name: string): JevVocabularyTerm {
  const operation = textOption(request, 'operation');
  const aliases = arrayOption(request, 'aliases');
  return { ...previous, name, definition: textOption(request, 'definition') || previous.definition,
    ...(previous.kind === 'group' ? { groupKey: renamedGroupKey(previous, name) } : {}),
    aliases: [...new Set([...previous.aliases, ...aliases, ...(name !== previous.name ? [previous.name] : [])])],
    state: ['promote', 'retire', 'restore'].includes(operation) ? lifecycleState(operation) : previous.state,
    version: previous.version + 1 };
}
async function merge(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const set = mergeAssessmentSet(context, request);
  const answers = await judge(context, set.state, set.questions);
  return mergeAssessedTerms(context, request, answers.synonymous);
}
export function mergeAssessmentSet(context: JevEvaluationContext, request: JevActionRequest): JevQuestionSet {
  const previous = findTerm(context, textOption(request, 'termId'));
  const target = findTerm(context, textOption(request, 'targetId'));
  if (previous.id === target.id || previous.kind !== target.kind) throw new ApiError(400, 'Merge requires two distinct terms of the same kind');
  const documents = affectedDocuments(context, previous);
  return { state: { sourceConcept: previous.definition, targetConcept: target.definition,
    sourceName: previous.name, targetName: target.name, contexts: documents.map(sourceState) }, questions: {
    synonymous: noul('Do sourceConcept and targetConcept have the same intended meaning and boundaries? Co-occurrence alone is insufficient.'),
  } };
}
/** Keep synonym admission and execution on the existing slider scale. */
export function synonymConfidence(synonymous: JevAnswer): number {
  return calibrated(confidence(synonymous), decisionBoundaries.synonym);
}
/** A selected pair consumes only its own checked meaning assessment. */
export function mergeAssessedTerms(context: JevEvaluationContext, request: JevActionRequest, synonymous: JevAnswer): JevEvaluation {
  const previous = findTerm(context, textOption(request, 'termId'));
  const target = findTerm(context, textOption(request, 'targetId'));
  if (previous.id === target.id || previous.kind !== target.kind) throw new ApiError(400, 'Merge requires two distinct terms of the same kind');
  const documents = affectedDocuments(context, previous);
  const members = [...new Map([...target.members, ...previous.members, ...uniqueMembers(documents)]
    .map(member => [`${member.canvasId}:${member.blockId}`, member])).values()];
  const term = { ...target, aliases: [...new Set([...target.aliases, previous.name, ...previous.aliases])],
    ...(target.kind === 'group' ? { groupKey: vocabularyGroupKey(target) } : {}),
    members, version: target.version + 1 };
  const semanticConfidence = synonymConfidence(synonymous);
  const result = evaluation({ status: 'proposed', synonymySupported: semanticConfidence >= semanticThreshold(context),
    semanticConfidence, requiresExplicitReview: context.settings.modes[request.action] !== 'auto', affectedMembers: documents.length });
  const reviewedMembers = context.documents.filter(document => members.some(member =>
    member.canvasId === document.canvasId && member.blockId === document.block.id));
  result.proposals.push(termProposal(request, 'merge', term, reviewedMembers, previous.id));
  migrateDescendants(result, context, request, previous, term);
  result.proposals.push(termProposal(request, 'retire', { ...previous, state: 'retired', version: previous.version + 1 }, documents));
  migrateMemberships(result, request, documents, previous, term);
  for (const candidate of result.proposals) candidate.decisionConfidences = [semanticConfidence];
  return result;
}
function migrateDescendants(result: JevEvaluation, context: JevEvaluationContext, request: JevActionRequest,
  previous: JevVocabularyTerm, next: JevVocabularyTerm): void {
  if (previous.kind !== 'group') return;
  const oldKey = vocabularyGroupKey(previous);
  const newKey = vocabularyGroupKey(next);
  if (oldKey === newKey) return;
  const descendants = context.vocabulary.filter(term => term.kind === 'group' && vocabularyGroupKey(term).startsWith(`${oldKey}/`));
  for (const child of descendants) {
    const migrated = { ...child, groupKey: `${newKey}${vocabularyGroupKey(child).slice(oldKey.length)}`,
      parentId: child.parentId === previous.id ? next.id : child.parentId, version: child.version + 1 };
    const documents = affectedDocuments(context, child);
    result.proposals.push(termProposal(request, 'rename', migrated, documents));
    migrateMemberships(result, request, documents, child, migrated);
  }
}
async function split(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const previous = findTerm(context, textOption(request, 'termId'));
  const names = arrayOption(request, 'splitNames');
  validateSplitNames(names);
  const documents = affectedDocuments(context, previous);
  const result = evaluation({ status: 'proposed', unresolvedMembers: [] });
  const children = names.map(name => ({ ...previous, id: termId(previous.kind, name), name,
    ...(previous.kind === 'group' ? { groupKey: renamedGroupKey(previous, name) } : {}),
    definition: name, aliases: [], members: [], version: 1 } as JevVocabularyTerm));
  const unresolved: string[] = [];
  for (const document of documents) {
    const answers = await judge(context, { source: sourceState(document), oldDefinition: previous.definition }, {
      child: choice('Which child definition best fits source? Select none when split membership is ambiguous.', candidates(
        children.map((child, index) => ({ id: `child${index}`, description: child.definition })))),
    });
    const child = children.find((_, index) => `child${index}` === selected(answers.child, context));
    if (!child) { unresolved.push(document.block.id); continue; }
    child.members.push({ canvasId: document.canvasId, blockId: document.block.id });
    migrateMemberships(result, request, [document], previous, child);
  }
  for (const child of children) result.proposals.unshift(termProposal(request, 'define', child, documents));
  result.result.unresolvedMembers = unresolved;
  result.result.retirementDeferredUntilAllMembersResolved = unresolved.length > 0;
  if (!unresolved.length) result.proposals.push(termProposal(request, 'retire', { ...previous, state: 'retired', version: previous.version + 1 }, documents));
  return result;
}
function validateSplitNames(names: string[]): void {
  if (names.length < 2 || names.length > 8 || new Set(names).size !== names.length) throw new ApiError(400, 'Split requires two to eight distinct explicit child names');
}
export async function vocabularyLifecycle(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const operation = textOption(request, 'operation') || 'nominate';
  if (['nominate', 'define'].includes(operation)) return nominate(context, request);
  if (['promote', 'rename', 'alias', 'retire', 'restore'].includes(operation)) return changeTerm(context, request);
  if (operation === 'merge') return merge(context, request);
  return split(context, request);
}
