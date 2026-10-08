import type { JevActionRequest,JevDocumentPatch,JevEvaluation,JevValues } from '../../../shared/jev-types.js';
import type { LinkRelation } from '../../../shared/types.js';
import { choice,noul,score,type JevAnswer,type ScoreAnswer } from '../../jev.js';
import { relevantNeighbors } from './candidates.js';
import { judgeQuestionSets } from './question-batch.js';
import { duplicateQuestionSet, duplicatePairAssessment } from './graph-duplicate.js';
export { duplicateQuestionSet, duplicatePairAssessment } from './graph-duplicate.js';
import { automaticLinkSet, automaticLinkAssessment } from './graph-link.js';
export { automaticLinkSet, automaticLinkAssessment } from './graph-link.js';
import {
confidence,currentTime,evaluation,evidenceCandidates,exactEvidence,passages,
json,
proposal,
selectedDocuments,semanticThreshold,sourceState,supported,textOption,type JevEvaluationContext,
type JevInputDocument
} from './context.js';

const meanings: Record<LinkRelation, string> = {
  prerequisite: 'source depends on target to be understood or carried out',
  implements: 'source implements the explicit requirements or plan in target',
  decision_for: 'source records a concrete decision about the proposal or subject in target',
  supersedes: 'source explicitly replaces target',
  contradicts: 'source and target make incompatible claims for the same subject, time, and scope',
  example_of: 'source is a concrete example of the concept described in target',
  same_topic: 'source and target share a substantial topic and useful reading context',
  related: 'target supplies specific useful supporting context when reading source',
};
function requestedRelation(request: JevActionRequest): LinkRelation | undefined {
  return (textOption(request, 'relation') || undefined) as LinkRelation | undefined;
}
export type Pair = { source: JevInputDocument; target: JevInputDocument; hypothesis: string };
type GraphFinding = { eligible: boolean; unsupported: boolean; confidence: number; evidence: ReturnType<typeof passages>;
  usefulness: number; relation?: LinkRelation; overlap?: 'copy' | 'older_version'; calibration?: number };
type VerifiedPair = Pair & { finding: GraphFinding };

function verificationSet({ source, target, hypothesis }: Pair, kind: 'link' | 'duplicate' | 'recheck') {
  return { state: { source: sourceState(source), target: sourceState(target), hypothesis }, questions: {
    supported: noul('Do source and target provide explicit evidence for hypothesis, including its direction, time, and scope?'),
    sourceEvidence: choice('Which exact source passage supports hypothesis?', evidenceCandidates(source)),
    targetEvidence: choice('Which exact target passage supports hypothesis?', evidenceCandidates(target)),
    ...(kind !== 'duplicate' ? { usefulness: score('How useful is target for understanding the supported hypothesis in source?',
      ['No useful value', 'Useful supporting context', 'Required or directly relevant context']) } : {}),
  } };
}
function explicitlyUnsupported(context: JevEvaluationContext, answer: JevAnswer): boolean {
  return answer.type === 'noul' && answer.noul < 0.5 && 1 - answer.noul >= semanticThreshold(context);
}
function verification(context: JevEvaluationContext, { source, target }: Pair, answers: Record<string, JevAnswer>): GraphFinding {
  const sourceEvidence = exactEvidence(source, answers.sourceEvidence);
  const targetEvidence = exactEvidence(target, answers.targetEvidence);
  const evidence = [...sourceEvidence, ...targetEvidence];
  return { eligible: supported(answers.supported, context) && sourceEvidence.length > 0 && targetEvidence.length > 0,
    unsupported: explicitlyUnsupported(context, answers.supported),
    confidence: confidence(answers.supported), evidence, usefulness: answers.usefulness ? (answers.usefulness as ScoreAnswer).score : 2,
    relation: undefined };
}
async function verifyPairs(context: JevEvaluationContext, pairs: Pair[], kind: 'link' | 'duplicate' | 'recheck' = 'link'): Promise<VerifiedPair[]> {
  const answers = await judgeQuestionSets(context, pairs.map(pair => verificationSet(pair, kind)));
  return pairs.map((pair, index) => ({ ...pair, finding: verification(context, pair, answers[index]) }));
}
async function verifyAutomaticLinks(context: JevEvaluationContext, pairs: Pair[]): Promise<VerifiedPair[]> {
  const answers = await judgeQuestionSets(context, pairs.map(automaticLinkSet));
  return pairs.map((pair, index) => ({ ...pair, finding: automaticLinkAssessment(context, pair, answers[index]) }));
}
function candidatePairs(context: JevEvaluationContext, sources: JevInputDocument[], hypothesis: string): Pair[] {
  return sources.flatMap(source => relevantNeighbors(context, source).map(target => ({ source, target, hypothesis })));
}
function candidateOrigin(context: JevEvaluationContext, pair: Pair): string {
  return context.retrievedNeighbors?.[`${pair.source.canvasId}:${pair.source.block.id}`]
    ?.includes(`${pair.target.canvasId}:${pair.target.block.id}`) ? 'shared_index' : 'local_text_or_existing_link';
}
function uniquePairs(pairs: Pair[]): Pair[] {
  const visited = new Set<string>();
  return pairs.filter(({ source, target }) => {
    const key = [source, target].map(item => `${item.canvasId}:${item.block.id}`).sort().join('|');
    if (visited.has(key)) return false;
    visited.add(key);
    return true;
  });
}
function edgePatch(source: JevInputDocument, target: JevInputDocument, relation: LinkRelation, certainty: number) {
  if (source.canvasId === target.canvasId) {
    return { links: [...new Set([...source.block.links, target.block.id])],
      linkTypes: { ...source.block.linkTypes, [target.block.id]: relation } };
  }
  const existing = source.block.crossLinks ?? [];
  const keep = existing.filter(link => link.canvasId !== target.canvasId || link.blockId !== target.block.id);
  return { crossLinks: [...keep, { canvasId: target.canvasId, blockId: target.block.id, relation, confidence: certainty }].slice(0, 20) };
}
function changedEdgePatch(source: JevInputDocument, updated: JevInputDocument): JevDocumentPatch {
  const patch: JevDocumentPatch = {};
  if (JSON.stringify(source.block.links) !== JSON.stringify(updated.block.links)) patch.links = updated.block.links;
  if (JSON.stringify(source.block.linkTypes) !== JSON.stringify(updated.block.linkTypes)) patch.linkTypes = updated.block.linkTypes;
  if (JSON.stringify(source.block.crossLinks) !== JSON.stringify(updated.block.crossLinks)) patch.crossLinks = updated.block.crossLinks;
  return patch;
}
function manuallyOwnedEdge(source: JevInputDocument, target: JevInputDocument): boolean {
  const exists = source.canvasId === target.canvasId ? source.block.links.includes(target.block.id)
    : (source.block.crossLinks ?? []).some(link => link.canvasId === target.canvasId && link.blockId === target.block.id);
  if (!exists) return false;
  const key = `link:${target.canvasId}:${target.block.id}`;
  return !source.block.jevOwnership?.managed.includes(key) || source.block.jevOwnership.pins.includes(key);
}
type LinkAccumulator = { updated: JevInputDocument; edges: JevValues[]; supporting: JevInputDocument[];
  evidence: ReturnType<typeof passages>; confidences: number[] };
function supportedRelation(finding: VerifiedPair['finding'], explicitRelation: LinkRelation | undefined): LinkRelation | undefined {
  if (!finding.eligible || finding.usefulness < 1) return undefined;
  return explicitRelation ?? finding.relation;
}
function addSupportedEdge(source: JevInputDocument, explicitRelation: LinkRelation | undefined,
  pair: VerifiedPair, accumulated: LinkAccumulator): void {
  const { target, finding } = pair;
  const relation = supportedRelation(finding, explicitRelation);
  if (!relation) return;
  accumulated.edges.push({ sourceId: source.block.id, targetId: target.block.id, targetCanvasId: target.canvasId,
    relation, confidence: finding.confidence, usefulness: finding.usefulness });
  if (!explicitRelation && manuallyOwnedEdge(source, target)) return;
  accumulated.updated = { ...accumulated.updated, block: { ...accumulated.updated.block,
    ...edgePatch(accumulated.updated, target, relation, finding.confidence) } };
  accumulated.supporting.push(target);
  accumulated.evidence.push(...finding.evidence);
  accumulated.confidences.push(finding.confidence);
}
function sourceLinks(request: JevActionRequest, source: JevInputDocument,
  explicitRelation: LinkRelation | undefined, pairs: VerifiedPair[]) {
  const accumulated: LinkAccumulator = { updated: source, edges: [], supporting: [source], evidence: [], confidences: [] };
  for (const pair of pairs) addSupportedEdge(source, explicitRelation, pair, accumulated);
  if (accumulated.supporting.length < 2) return { candidate: undefined, edges: accumulated.edges };
  const patch = changedEdgePatch(source, accumulated.updated);
  if (!Object.keys(patch).length) return { candidate: undefined, edges: accumulated.edges };
  const candidate = proposal(request, { kind: 'document', canvasId: source.canvasId,
    blockId: source.block.id, patch }, accumulated.supporting, `Connect ${source.block.title}`,
  'Each supported edge retains its own confidence; the atomic source patch preserves all selected links', accumulated.evidence);
  candidate.decisionConfidences = accumulated.confidences;
  return { candidate, edges: accumulated.edges };
}
export async function link(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ verifiedPairs: 0, edges: [] });
  const edgeResults: JevValues[] = [];
  const explicitRelation = requestedRelation(request);
  const sources = selectedDocuments(context, request);
  const hypothesis = explicitRelation ? meanings[explicitRelation] : 'source and target have a useful, evidence-backed directional relationship';
  const candidates = candidatePairs(context, sources, hypothesis);
  result.result.candidateOptions = candidates.map(pair => ({ sourceId: pair.source.block.id, targetId: pair.target.block.id,
    targetCanvasId: pair.target.canvasId, origin: candidateOrigin(context, pair) }));
  const pairs = explicitRelation ? await verifyPairs(context, candidates, 'link') : await verifyAutomaticLinks(context, candidates);
  result.result.verifiedPairs = pairs.length;
  for (const source of sources) {
    const generated = sourceLinks(request, source, explicitRelation, pairs.filter(pair => pair.source === source));
    edgeResults.push(...generated.edges);
    if (generated.candidate) result.proposals.push(generated.candidate);
  }
  recordLinkResults(result, edgeResults, candidates.length);
  return result;
}
function recordLinkResults(result: JevEvaluation, edges: JevValues[], candidateCount: number): void {
  result.result.edges = edges;
  if (!edges.length) result.result.reason = candidateCount ? 'No pair had sufficient typed evidence' : 'No relevant neighbors';
}
function findingKind(request: JevActionRequest) {
  if (request.action === 'flag_duplicate') return { kind: 'duplicate', title: 'Compare possible duplicates',
    hypothesis: 'source and target record substantially the same knowledge or work without a meaningful distinct update',
    choices: ['keep_both', 'dismiss', 'link', 'review_merge'] };
  return { kind: 'conflict', title: 'Conflicting claims', hypothesis: meanings.contradicts,
    choices: ['dismiss', 'correct_source', 'select_authority'] };
}
function duplicateBody(content: string): string {
  const body = content.replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\n)*/, '')
    .replace(/^#[ \t]+[^\n]*(?:\n|$)/, '');
  // Keep every body byte, including code, indentation, internal blank lines, and later headings.
  return body.replace(/^(?:[ \t]*\n)*/, '').replace(/(?:\n[ \t]*)+$/, '');
}
function duplicateBodyEvidence(document: JevInputDocument) {
  return passages(document).filter(passage => !/^#{1,6}[ \t]/.test(passage.quote)).slice(0, 1);
}
export function deterministicDuplicateMethod(source: JevInputDocument, target: JevInputDocument): string | undefined {
  if (source.block.content === target.block.content) return passages(source, 1).length ? 'exact_content' : undefined;
  if (!duplicateBodyEvidence(source).length || !duplicateBodyEvidence(target).length) return undefined;
  return duplicateBody(source.block.content) === duplicateBody(target.block.content) ? 'substantive_content' : undefined;
}
function deterministicDuplicatePairs(request: JevActionRequest, pairs: Pair[]): Pair[] {
  return request.action === 'flag_duplicate' ? pairs.filter(pair => deterministicDuplicateMethod(pair.source, pair.target)) : [];
}
function deterministicDuplicateTargets(context: JevEvaluationContext, source: JevInputDocument): JevInputDocument[] {
  return context.documents.filter(target => target.snapshot.workspaceId === context.workspaceId)
    .filter(target => !target.block.archived && !target.block.processingExcluded)
    .filter(target => target.canvasId !== source.canvasId || target.block.id !== source.block.id)
    .filter(target => deterministicDuplicateMethod(source, target)).slice(0, 12);
}
function deterministicDuplicateCandidates(context: JevEvaluationContext, request: JevActionRequest,
  sources: JevInputDocument[], hypothesis: string): Pair[] {
  if (request.action !== 'flag_duplicate') return [];
  return sources.filter(source => passages(source, 1).length > 0)
    .flatMap(source => deterministicDuplicateTargets(context, source).map(target => ({ source, target, hypothesis })));
}
function findingCandidates(context: JevEvaluationContext, request: JevActionRequest, hypothesis: string): Pair[] {
  const sources = selectedDocuments(context, request);
  return uniquePairs([...candidatePairs(context, sources, hypothesis),
    ...deterministicDuplicateCandidates(context, request, sources, hypothesis)]);
}
function pairKey(pair: Pair): string {
  return `${pair.source.canvasId}:${pair.source.block.id}|${pair.target.canvasId}:${pair.target.block.id}`;
}
function deterministicEvidence(pair: Pair) {
  const evidence = deterministicDuplicateMethod(pair.source, pair.target) === 'exact_content'
    ? (document: JevInputDocument) => passages(document, 1) : duplicateBodyEvidence;
  return [...evidence(pair.source), ...evidence(pair.target)];
}
async function semanticFindings(context: JevEvaluationContext, request: JevActionRequest, pairs: Pair[]): Promise<VerifiedPair[]> {
  if (request.action !== 'flag_duplicate') return verifyPairs(context, pairs, 'duplicate');
  const answers = await judgeQuestionSets(context, pairs.map(duplicateQuestionSet));
  return pairs.map((pair, index) => ({ ...pair, finding: duplicatePairAssessment(context, pair, answers[index]) }));
}
function findingTitle(kind: ReturnType<typeof findingKind>, finding: VerifiedPair['finding']): string {
  if (!finding.overlap) return kind.title;
  return finding.overlap === 'copy' ? 'Possible copy' : 'Possible older version';
}
function addPairFinding(request: JevActionRequest, kind: ReturnType<typeof findingKind>, pair: VerifiedPair,
  methods: Map<string, string | undefined>, result: JevEvaluation, findings: JevValues[]) {
  const { source, target, finding } = pair;
  if (!finding.eligible) return;
  const values: JevValues = { kind: kind.kind, targetCanvasId: target.canvasId, targetId: target.block.id,
    confidence: finding.confidence, status: 'detected', method: methods.get(pairKey(pair)) ?? 'semantic_review',
    ...(finding.overlap ? { overlap: finding.overlap, calibration: 1 } : {}) };
  findings.push(values);
  const candidate = proposal(request, { kind: 'derived', blockId: source.block.id, values }, [source, target],
    findingTitle(kind, finding), kind.hypothesis, finding.evidence, finding.confidence);
  if (finding.overlap) candidate.decisionConfidences = [finding.confidence];
  result.proposals.push(candidate);
}
export async function pairFinding(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const kind = findingKind(request);
  const findings: JevValues[] = [];
  const result = evaluation();
  const pairs = findingCandidates(context, request, kind.hypothesis);
  result.result.candidateOptions = pairs.map(pair => ({ sourceId: pair.source.block.id, targetId: pair.target.block.id,
    targetCanvasId: pair.target.canvasId, origin: candidateOrigin(context, pair) }));
  const deterministic = deterministicDuplicatePairs(request, pairs);
  const methods = new Map(deterministic.map(pair => [pairKey(pair), deterministicDuplicateMethod(pair.source, pair.target)]));
  const semantic = pairs.filter(pair => !methods.has(pairKey(pair)));
  const verified: VerifiedPair[] = [...deterministic.map(pair => ({ ...pair, finding: { eligible: true, confidence: 1,
    evidence: deterministicEvidence(pair), usefulness: 2,
    unsupported: false, relation: undefined, overlap: 'copy' as const, calibration: 1 } })), ...await semanticFindings(context, request, semantic)];
  for (const pair of verified) addPairFinding(request, kind, pair, methods, result, findings);
  result.result.findings = findings;
  if (request.action === 'flag_duplicate') result.result.calibration = 1;
  if (!findings.length) result.result.reason = pairs.length ? 'No candidate pair met duplicate evidence' : 'No relevant duplicate candidates';
  return result;
}

function linkedTargets(context: JevEvaluationContext, source: JevInputDocument) {
  return context.documents.filter(target =>
    (target.canvasId === source.canvasId && source.block.links.includes(target.block.id))
    || (source.block.crossLinks ?? []).some(edge => edge.canvasId === target.canvasId && edge.blockId === target.block.id));
}
function removeEdge(source: JevInputDocument, target: JevInputDocument): JevInputDocument {
  if (source.canvasId !== target.canvasId) return { ...source, block: { ...source.block,
    // Cross-canvas targets reach removal only through linkedTargets' exact existing edge match.
    crossLinks: source.block.crossLinks!.filter(edge => edge.canvasId !== target.canvasId || edge.blockId !== target.block.id) } };
  const linkTypes = { ...source.block.linkTypes };
  delete linkTypes[target.block.id];
  return { ...source, block: { ...source.block, links: source.block.links.filter(id => id !== target.block.id), linkTypes } };
}
function existingRelation(source: JevInputDocument, target: JevInputDocument): LinkRelation {
  if (source.canvasId === target.canvasId) return source.block.linkTypes?.[target.block.id] ?? 'related';
  return crossCanvasRelation(source, target);
}
function crossCanvasRelation(source: JevInputDocument, target: JevInputDocument): LinkRelation {
  return source.block.crossLinks?.find(edge => edge.canvasId === target.canvasId && edge.blockId === target.block.id)?.relation ?? 'related';
}
function mayRemove(source: JevInputDocument, target: JevInputDocument, unsupported: boolean): boolean {
  const edgeKey = `link:${target.canvasId}:${target.block.id}`;
  const ownership = source.block.jevOwnership;
  return Boolean(unsupported && ownership?.managed.includes(edgeKey) && !ownership.pins.includes(edgeKey));
}
function supportStatus(eligible: boolean, unsupported: boolean): string {
  if (eligible) return 'fresh';
  return unsupported ? 'unsupported' : 'insufficient_evidence';
}
function sourceRecheck(context: JevEvaluationContext, request: JevActionRequest,
  source: JevInputDocument, pairs: VerifiedPair[]) {
    const proposals: JevEvaluation['proposals'] = [];
    let updated = source;
    const sourceEdges: JevValues[] = [];
    const removedTargets: JevInputDocument[] = [];
    const removalEvidence = [];
    const removalConfidences: number[] = [];
    for (const { target, finding } of pairs) {
      const values: JevValues = { targetId: target.block.id, targetCanvasId: target.canvasId,
        status: supportStatus(finding.eligible, finding.unsupported),
        confidence: finding.confidence, checkedAt: currentTime(context).toISOString() };
      sourceEdges.push(values);
      if (!mayRemove(source, target, finding.unsupported)) continue;
      updated = removeEdge(updated, target);
      removedTargets.push(target);
      removalEvidence.push(...finding.evidence);
      removalConfidences.push(1 - finding.confidence);
    }
    proposals.push(proposal(request, { kind: 'derived', blockId: source.block.id, values: { linkRechecks: sourceEdges } },
      [source, ...pairs.map(pair => pair.target)], 'Recheck current link support',
      'Manual edges remain protected; each current endpoint and support status is retained', []));
    if (!removedTargets.length) return { edges: sourceEdges, proposals };
    const candidate = proposal(request, { kind: 'document', canvasId: source.canvasId, blockId: source.block.id,
      patch: changedEdgePatch(source, updated) },
    [source, ...removedTargets], 'Remove unsupported managed links',
    'Only exact per-edge Symbi Reflex ownership permits removal; manual and pinned edges remain intact', removalEvidence);
    candidate.decisionConfidences = removalConfidences;
    proposals.push(candidate);
    return { edges: sourceEdges, proposals };
}
export async function recheckLinks(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ edges: [] });
  const edges: JevValues[] = [];
  const sources = selectedDocuments(context, request);
  const pending = sources.flatMap(source => linkedTargets(context, source).slice(0, 10).map(target =>
    ({ source, target, hypothesis: meanings[existingRelation(source, target)] })));
  const pairs = await verifyPairs(context, pending);
  for (const source of sources) {
    const rechecked = sourceRecheck(context, request, source, pairs.filter(pair => pair.source === source));
    edges.push(...rechecked.edges);
    result.proposals.push(...rechecked.proposals);
  }
  result.result.edges = edges;
  result.result.coverage = json({ maximumEdgesPerDocument: 10 });
  return result;
}
