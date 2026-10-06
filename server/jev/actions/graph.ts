import type { JevActionRequest,JevDocumentPatch,JevEvaluation,JevValues } from '../../../shared/jev-types.js';
import type { LinkRelation } from '../../../shared/types.js';
import { choice,noul,score,type JevAnswer,type ScoreAnswer } from '../../jev.js';
import { relevantNeighbors } from './candidates.js';
import { judgeQuestionSets } from './question-batch.js';
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
type Pair = { source: JevInputDocument; target: JevInputDocument; hypothesis: string };
type VerifiedPair = Pair & { finding: ReturnType<typeof verification> };
const automaticRelations = { prerequisite: meanings.prerequisite, implements: meanings.implements,
  example_of: meanings.example_of, same_topic: meanings.same_topic, related: meanings.related,
  none: 'No directional relationship is sufficiently supported by both documents',
  unknown: 'The supplied excerpts do not establish the relationship or its direction' };

function verificationSet({ source, target, hypothesis }: Pair, kind: 'link' | 'duplicate' | 'recheck', chooseRelation: boolean) {
  return { state: { source: sourceState(source), target: sourceState(target), hypothesis }, questions: {
    supported: noul('Do source and target provide explicit evidence for hypothesis, including its direction, time, and scope?'),
    sourceEvidence: choice('Which exact source passage supports hypothesis?', evidenceCandidates(source)),
    targetEvidence: choice('Which exact target passage supports hypothesis?', evidenceCandidates(target)),
    ...(kind !== 'duplicate' ? { usefulness: score('How useful is target for understanding the supported hypothesis in source?',
      ['No useful value', 'Useful supporting context', 'Required or directly relevant context']) } : {}),
    ...(chooseRelation ? { relation: choice('Which relationship is directly supported from source to target? Choose none when direction or type is unclear.', automaticRelations) } : {}),
  } };
}
function explicitlyUnsupported(context: JevEvaluationContext, answer: JevAnswer): boolean {
  return answer.type === 'noul' && answer.noul < 0.5 && 1 - answer.noul >= semanticThreshold(context);
}
function verification(context: JevEvaluationContext, { source, target }: Pair, answers: Record<string, JevAnswer>) {
  const sourceEvidence = exactEvidence(source, answers.sourceEvidence);
  const targetEvidence = exactEvidence(target, answers.targetEvidence);
  const evidence = [...sourceEvidence, ...targetEvidence];
  return { eligible: supported(answers.supported, context) && sourceEvidence.length > 0 && targetEvidence.length > 0,
    unsupported: explicitlyUnsupported(context, answers.supported),
    confidence: confidence(answers.supported), evidence, usefulness: answers.usefulness ? (answers.usefulness as ScoreAnswer).score : 2,
    relation: answers.relation ? selectedRelation(context, answers.relation) : undefined };
}
function selectedRelation(context: JevEvaluationContext, answer: JevAnswer): LinkRelation | undefined {
  if (answer.type !== 'choice' || answer.confidence < semanticThreshold(context)) return undefined;
  return answer.choice !== 'none' && answer.choice !== 'unknown' && Object.hasOwn(automaticRelations, answer.choice)
    ? answer.choice as LinkRelation : undefined;
}
async function verifyPairs(context: JevEvaluationContext, pairs: Pair[], kind: 'link' | 'duplicate' | 'recheck' = 'link', chooseRelation = false): Promise<VerifiedPair[]> {
  const answers = await judgeQuestionSets(context, pairs.map(pair => verificationSet(pair, kind, chooseRelation)));
  return pairs.map((pair, index) => ({ ...pair, finding: verification(context, pair, answers[index]) }));
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
    return { links: [...new Set([...source.block.links, target.block.id])].slice(0, 20),
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
  const pairs = await verifyPairs(context, candidates, 'link', !explicitRelation);
  result.result.verifiedPairs = pairs.length;
  for (const source of sources) {
    const generated = sourceLinks(request, source, explicitRelation, pairs.filter(pair => pair.source === source));
    edgeResults.push(...generated.edges);
    if (generated.candidate) result.proposals.push(generated.candidate);
  }
  result.result.edges = edgeResults;
  if (!edgeResults.length) result.result.reason = candidates.length ? 'No pair had sufficient typed evidence' : 'No relevant neighbors';
  return result;
}
function findingKind(request: JevActionRequest) {
  if (request.action === 'flag_duplicate') return { kind: 'duplicate', title: 'Compare possible duplicates',
    hypothesis: 'source and target record substantially the same knowledge or work without a meaningful distinct update',
    choices: ['keep_both', 'dismiss', 'link', 'review_merge'] };
  return { kind: 'conflict', title: 'Conflicting claims', hypothesis: meanings.contradicts,
    choices: ['dismiss', 'correct_source', 'select_authority'] };
}
function exactDuplicatePairs(request: JevActionRequest, pairs: Pair[]): Pair[] {
  return request.action === 'flag_duplicate' ? pairs.filter(pair => pair.source.block.content.trim().length > 0
    && pair.source.block.content === pair.target.block.content) : [];
}
function pairKey(pair: Pair): string {
  return `${pair.source.canvasId}:${pair.source.block.id}|${pair.target.canvasId}:${pair.target.block.id}`;
}
export async function pairFinding(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const kind = findingKind(request);
  const findings: JevValues[] = [];
  const result = evaluation();
  const pairs = uniquePairs(candidatePairs(context, selectedDocuments(context, request), kind.hypothesis));
  result.result.candidateOptions = pairs.map(pair => ({ sourceId: pair.source.block.id, targetId: pair.target.block.id,
    targetCanvasId: pair.target.canvasId, origin: candidateOrigin(context, pair) }));
  const exact = exactDuplicatePairs(request, pairs);
  const exactKeys = new Set(exact.map(pairKey));
  const semantic = pairs.filter(pair => !exactKeys.has(pairKey(pair)));
  const verified = [...exact.map(pair => ({ ...pair, finding: { eligible: true, confidence: 1,
    evidence: [...passages(pair.source, 1), ...passages(pair.target, 1)], usefulness: 2,
    unsupported: false, relation: undefined } })), ...await verifyPairs(context, semantic, 'duplicate')];
  for (const { source, target, finding } of verified) {
      if (!finding.eligible) continue;
      const values: JevValues = { kind: kind.kind, targetCanvasId: target.canvasId,
        targetId: target.block.id, confidence: finding.confidence, status: 'detected',
        method: exactKeys.has(pairKey({ source, target, hypothesis: kind.hypothesis })) ? 'exact_content' : 'semantic_review' };
      findings.push(values);
      result.proposals.push(proposal(request, { kind: 'derived', blockId: source.block.id, values }, [source, target],
        kind.title, kind.hypothesis, finding.evidence, finding.confidence));
  }
  result.result.findings = findings;
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
