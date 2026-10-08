import { createHash } from 'node:crypto';
import { groupLabel, groupParent, normalizedGroup, validGroupKey } from '../../../shared/groups.js';
import type { JevActionRequest, JevEvaluation, JevMutation, JevSettings, JevValues, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { choice, noul, type ChoiceAnswer, type JevAnswer } from '../../jev.js';
import { candidates, confidence, evaluation, selected, selectedDocuments, semanticThreshold,
  sourceState, supported, textOption, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { lexicalScore } from './candidates.js';
import { batchedDiscoveryContext } from './discovery-batch.js';
import { judgeQuestionSets, type JevQuestionSet } from './question-batch.js';
import { vocabularyGroupKey } from './groups.js';
import { semanticHeadingNames, sourcePassages } from './source-passages.js';
import { sharedSourceCategories } from './source-categories.js';
import { defineAssessedConcept, mergeAssessmentSet, mergeAssessedTerms, nominationFitSet, synonymConfidence, vocabularyLifecycle } from './vocabulary.js';

type People = JevSettings['people'];
type Kind = JevVocabularyTerm['kind'];
type Concept = { name: string; groupKey?: string; sources?: JevInputDocument[] };
const kinds: Kind[] = ['label', 'entity', 'group'];
const meanings: Record<Kind, string> = {
  label: 'a useful substantive topic label for this source',
  entity: 'a specifically named person, organization, product, or project in this source',
  group: 'a reusable broad subject or purpose for organizing this source',
};

function responsibilityNames(content: string): Array<{ name: string; role: string }> {
  const name = String.raw`([\p{Lu}][\p{L}\p{M}'’.-]*(?:[ \t]+[\p{Lu}][\p{L}\p{M}'’.-]*){0,3})`;
  const labels = new RegExp(String.raw`\b([Oo]wner|[Aa]ssignee|[Rr]eviewer)[ \t]*:[ \t]*${name}`, 'gu');
  const verbs = new RegExp(String.raw`\b${name}[ \t]+(owns|is responsible for|reviews|will review)\b`, 'gu');
  return [...content.matchAll(labels)].map(match => ({ name: match[2], role: match[1].toLowerCase() }))
    .concat([...content.matchAll(verbs)].map(match => ({ name: match[1], role: match[2] })));
}

/** Explicit responsibility syntax supplies candidates; the assignment evaluator still checks the task evidence. */
export function automaticPeople(documents: JevInputDocument[], knownPeople: People): People {
  const people = new Map(knownPeople.map(person => [person.id, person]));
  const names = new Set(knownPeople.map(person => person.name.toLocaleLowerCase()));
  const limit = people.size + 24;
  for (const document of documents.slice(0, 32).filter(item => !item.block.processingExcluded)) {
    for (const person of responsibilityNames(document.block.content.slice(0, 24000))) {
      const name = person.name.trim().replace(/\.+$/, '');
      const key = name.toLocaleLowerCase();
      if (names.has(key)) continue;
      if (people.size >= limit) break;
      const id = `source-person-${createHash('sha256').update(key).digest('hex').slice(0, 18)}`;
      if (people.has(id)) continue;
      names.add(key);
      people.set(id, { id, name, role: `Explicit source responsibility: ${person.role}` });
    }
  }
  return [...people.values()];
}

function sourceNames(document: JevInputDocument): string[] {
  return [...(document.block.tags ?? []), document.block.title, ...semanticHeadingNames(document.block.content)];
}

function sharedGroupConcepts(context: JevEvaluationContext, document: JevInputDocument): Concept[] {
  const documents = [document, ...context.documents.filter(source => source.canvasId === document.canvasId && source.block.id !== document.block.id)]
    .filter(source => !source.block.archived && !source.block.processingExcluded).slice(0, 64);
  return sharedSourceCategories(documents, document).map(category => ({ name: category.name, sources: category.sources.slice(0, 8) }));
}

function groupConcepts(context: JevEvaluationContext, document: JevInputDocument): Concept[] {
  const shared = sharedGroupConcepts(context, document);
  return shared.length ? shared : [...sourceNames(document).map(name => ({ name })), ...nativeConcepts(context, document)];
}

function nativeConcepts(context: JevEvaluationContext, document: JevInputDocument): Concept[] {
  const definitions = context.canvases.find(canvas => canvas.id === document.canvasId)?.groups ?? [];
  const existing = validGroupKey(document.block.group) ? [{ name: groupLabel(document.block.group), groupKey: normalizedGroup(document.block.group) }] : [];
  return [...existing, ...definitions.map(group => ({ name: group.name, groupKey: normalizedGroup(group.id) }))]
    .filter(concept => usableGroupPath(context, concept.groupKey) && admittedConcept(context, document, 'group', concept));
}

function usableGroupPath(context: JevEvaluationContext, key: string | undefined): boolean {
  if (!validGroupKey(key)) return false;
  const parent = groupParent(key);
  return !parent || context.vocabulary.some(term => term.kind === 'group' && term.state === 'active' && vocabularyGroupKey(term) === parent);
}

function sameName(term: JevVocabularyTerm, name: string): boolean {
  return [term.name, ...term.aliases].some(alias => alias.toLocaleLowerCase() === name.toLocaleLowerCase());
}

function mentionedPeople(context: JevEvaluationContext, document: JevInputDocument): string[] {
  const content = document.block.content.toLocaleLowerCase();
  return automaticPeople([document], context.settings.people).filter(person => content.includes(person.name.toLocaleLowerCase())).map(person => person.name);
}

function conceptCandidates(context: JevEvaluationContext, document: JevInputDocument, kind: Kind): Concept[] {
  const names = kind === 'entity' ? [...mentionedPeople(context, document), ...sourceNames(document)] : sourceNames(document);
  const concepts = kind === 'group' ? groupConcepts(context, document) : names.map(name => ({ name }));
  const unique = new Map(concepts.map(concept => [concept.name.toLocaleLowerCase(), concept]));
  return [...unique.values()].filter(concept => validConcept(document, kind, concept)).slice(0, 16);
}

function validConcept(document: JevInputDocument, kind: Kind, concept: Concept): boolean {
  if (!usableConceptName(concept.name, kind)) return false;
  return kind !== 'label' || !document.block.jevOwnership?.removedLabels.includes(concept.name);
}

function admittedConcept(context: JevEvaluationContext, document: JevInputDocument, kind: Kind, concept: Concept): boolean {
  const existing = context.vocabulary.find(term => term.kind === kind && sameName(term, concept.name));
  return discoverableTerm(existing, document);
}

function discoverableTerm(term: JevVocabularyTerm | undefined, document: JevInputDocument): boolean {
  return !term || term.state === 'candidate' || missingGroupMember(term, document);
}

function missingGroupMember(term: JevVocabularyTerm, document: JevInputDocument): boolean {
  if (term.kind !== 'group' || term.state !== 'active') return false;
  if (vocabularyGroupKey(term) !== normalizedGroup(document.block.group)) return false;
  return !term.members.some(member => member.canvasId === document.canvasId && member.blockId === document.block.id);
}

function usableConceptName(name: string, kind: Kind): boolean {
  const limit = kind === 'label' ? 40 : 80;
  return name.trim().length >= 2 && name.length <= limit;
}

function discoveryRequest(request: JevActionRequest, document: JevInputDocument, kind: Kind, concept: Concept): JevActionRequest {
  const sources = concept.sources ?? [document];
  const definition = sources.flatMap(source => definitionPassages(source, concept.name)).join('\n').slice(0, 1600);
  return { ...request, blockIds: sources.map(source => source.block.id), options: { operation: 'define', kind, name: concept.name,
    definition, definitionSource: 'visible_source_excerpts', conceptOrigin: conceptOrigin(document, concept),
    ...(concept.groupKey ? { groupKey: concept.groupKey } : {}) } };
}

function conceptOrigin(document: JevInputDocument, concept: Concept): string {
  if (concept.sources) return 'explicit_shared_source_category';
  if (concept.name === document.block.title) return 'document_title';
  if (semanticHeadingNames(document.block.content).includes(concept.name)) return 'visible_source_heading';
  return concept.groupKey ? 'native_group_definition' : 'explicit_source_name';
}

function definitionPassages(document: JevInputDocument, name: string): string[] {
  const evidence = sourcePassages(document.block.content);
  const first = Math.max(0, evidence.findIndex(passage => passage.text.toLocaleLowerCase().includes(name.toLocaleLowerCase())));
  return evidence.slice(first, first + 3).map(passage => passage.text.slice(0, 320));
}

function conceptDescription(concept: Concept): string {
  return concept.sources ? `${concept.name} — shared subject in ${concept.sources.map(source => source.block.title).join('; ')}` : concept.name;
}

async function discoverConcept(context: JevEvaluationContext, request: JevActionRequest, document: JevInputDocument, kind: Kind): Promise<JevEvaluation> {
  const concepts = conceptCandidates(context, document, kind);
  const admitted = concepts.map((concept, index) => ({ concept, index, request: discoveryRequest(request, document, kind, concept) }))
    .filter(item => admittedConcept(context, document, kind, item.concept));
  if (!admitted.length) return discoverySummary(evaluation({ status: 'no_source_concepts' }), document, kind, 0);
  const selection: JevQuestionSet = { state: { source: sourceState(document), kind }, questions: {
    concept: choice(`Which exact supplied name denotes ${meanings[kind]}? Choose none when unsupported.`,
      candidates(concepts.map((concept, index) => ({ id: `c${index}`, description: conceptDescription(concept) })))),
  } };
  const answers = await judgeQuestionSets(context, [selection, ...admitted.map(item =>
    conceptFitSet(context, item.request, document, item.concept))]);
  const answer = answers[0].concept as ChoiceAnswer;
  const decision = { choice: answer.choice, selectionConfidence: answer.confidence };
  const id = selected(answer, context);
  const index = concepts.findIndex((_, index) => `c${index}` === id);
  if (index < 0) return discoverySummary(evaluation({ status: 'insufficient_concept_evidence' }), document, kind, concepts.length, decision);
  const concept = concepts[index];
  const admittedIndex = admitted.findIndex(item => item.index === index);
  const result = admittedIndex < 0 ? existingConcept(context, concept, kind) : await checkedConcept(context,
    admitted[admittedIndex].request, concept, confidence(answer), answers[admittedIndex + 1].fit);
  return discoverySummary(result, document, kind, concepts.length, { ...decision, selectedName: concept.name });
}

function existingConcept(context: JevEvaluationContext, concept: Concept, kind: Kind): JevEvaluation {
  const existing = context.vocabulary.find(term => term.kind === kind && sameName(term, concept.name))!;
  return evaluation({ status: 'existing_concept', termId: existing.id, termState: existing.state });
}

function conceptFitSet(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, concept: Concept): JevQuestionSet {
  const existing = context.vocabulary.find(term => term.kind === textOption(request, 'kind') && sameName(term, concept.name));
  if (!existing) return nominationFitSet(request, concept.name, selectedDocuments(context, request));
  return { state: { source: sourceState(document), concept: existing }, questions: {
    fit: noul('Does source substantively support this candidate concept and its exact existing definition?'),
  } };
}

function discoverySummary(result: JevEvaluation, document: JevInputDocument, kind: Kind, count: number, decision: JevValues = {}): JevEvaluation {
  result.result.discovery = { blockId: document.block.id, kind, candidateCount: count,
    status: String(result.result.status), checkedConfidence: result.result.confidence ?? null,
    proposalCount: result.proposals.length, ...decision };
  return result;
}

async function checkedConcept(context: JevEvaluationContext, request: JevActionRequest,
  concept: Concept, selectionConfidence: number, fit: JevAnswer): Promise<JevEvaluation> {
  const existing = context.vocabulary.find(term => term.kind === textOption(request, 'kind') && sameName(term, concept.name));
  if (!existing) return defineConcept(context, request, concept.name, selectionConfidence, fit);
  if (!supported(fit, context)) return evaluation({ status: 'insufficient_existing_concept_evidence', confidence: confidence(fit) });
  const result = await vocabularyLifecycle(context, { ...request, options: { operation: 'promote', termId: existing.id } });
  for (const candidate of result.proposals) candidate.decisionConfidences = [selectionConfidence, confidence(fit)];
  return result;
}

async function defineConcept(context: JevEvaluationContext, request: JevActionRequest,
  name: string, selectionConfidence: number, fit: JevAnswer): Promise<JevEvaluation> {
  const result = await defineAssessedConcept(context, request, selectedDocuments(context, request), name, fit);
  for (const candidate of result.proposals) candidate.decisionConfidences = [selectionConfidence, Number(result.result.confidence)];
  return result;
}

function appendVocabulary(result: JevEvaluation, generated: JevEvaluation, context: JevEvaluationContext): void {
  result.proposals.push(...generated.proposals);
  (result.result.discoveries as JevValues[]).push(generated.result.discovery as JevValues);
  const definitions = generated.proposals.map(candidate => candidate.mutation)
    .filter((mutation): mutation is Extract<JevMutation, { kind: 'vocabulary' }> => mutation.kind === 'vocabulary');
  for (const { term } of definitions) {
    context.vocabulary = [...context.vocabulary.filter(previous => previous.id !== term.id), term];
  }
}

function mergePairs(context: JevEvaluationContext): Array<{ source: JevVocabularyTerm; target: JevVocabularyTerm }> {
  const terms = context.vocabulary.filter(term => term.state === 'active').slice(0, 16);
  const pairs = terms.flatMap((source, index) => terms.slice(index + 1).filter(target => source.kind === target.kind)
    .map(target => ({ source: target, target: source })));
  if (pairs.length <= 8) return pairs;
  return pairs.sort((a, b) => mergePairRank(b) - mergePairRank(a)).slice(0, 8);
}

function mergePairRank(pair: { source: JevVocabularyTerm; target: JevVocabularyTerm }): number {
  return lexicalScore(`${pair.source.name} ${pair.source.definition}`, `${pair.target.name} ${pair.target.definition}`);
}

async function mergeVocabulary(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const pairs = mergePairs(context);
  if (!pairs.length) return evaluation();
  const requests = pairs.map(pair => ({ ...request, options: { operation: 'merge', termId: pair.source.id, targetId: pair.target.id } }));
  const answers = await judgeQuestionSets(context, requests.map(item => mergeAssessmentSet(context, item)));
  const best = answers.map((answer, index) => ({ index, value: synonymConfidence(answer.synonymous) }))
    .filter(item => item.value >= semanticThreshold(context)).sort((a, b) => b.value - a.value)[0];
  if (!best) return evaluation();
  return mergeAssessedTerms(context, requests[best.index], answers[best.index].synonymous);
}

function discoveryKinds(request: JevActionRequest): Kind[] {
  const selectedKind = textOption(request, 'kind');
  return selectedKind ? kinds.filter(kind => selectedKind === kind) : kinds;
}

function discoverWithLabelNotice(context: JevEvaluationContext, request: JevActionRequest,
  document: JevInputDocument, kind: Kind): Promise<JevEvaluation> {
  const discovery = discoverConcept(context, request, document, kind);
  if (kind !== 'label') return discovery;
  return discovery.then(result => {
    context.prefetchLabelDefinitions?.(result);
    return result;
  });
}

async function discoverVocabulary(context: JevEvaluationContext, request: JevActionRequest, result: JevEvaluation): Promise<void> {
  const selectedKinds = discoveryKinds(request);
  const documents = selectedDocuments(context, request).filter(item => !item.block.processingExcluded).slice(0, 8);
  for (const document of documents) {
    const batched = batchedDiscoveryContext(context);
    const discoveries = await Promise.allSettled(selectedKinds.map(kind => discoverWithLabelNotice(batched, request, document, kind)));
    for (const discovery of discoveries) {
      if (discovery.status === 'rejected') throw discovery.reason;
      appendVocabulary(result, discovery.value, context);
    }
  }
}

export async function automaticVocabulary(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  if (textOption(request, 'operation')) return vocabularyLifecycle(context, request);
  if (textOption(request, 'name')) return vocabularyLifecycle(context, { ...request, options: { ...request.options, operation: 'define' } });
  const working = { ...context, vocabulary: [...context.vocabulary] };
  const result = evaluation({ automaticDiscovery: true, discoveries: [] });
  await discoverVocabulary(working, request, result);
  const merged = await mergeVocabulary(working, request);
  result.proposals.push(...merged.proposals);
  result.result.synonymySupported = merged.result.synonymySupported ?? false;
  result.result.proposalCount = result.proposals.length;
  result.result.status = result.proposals.length ? 'proposed' : 'no_change';
  return result;
}
