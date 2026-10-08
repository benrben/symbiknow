/** Frozen-corpus first pass: proposals are inspected, never applied to an app store. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { JevEvaluation, JevPassage, JevValues } from '../../shared/jev-types.js';
import type { JevDecider } from '../../server/jev.js';
import { ApiError } from '../../server/errors.js';
import { emptyJevWorkspace } from '../../server/jev/workspace.js';
import type { JevEvaluationContext, JevInputDocument } from '../../server/jev/actions/context.js';
import { sharedGroupRefinements } from '../../server/jev/actions/grouping.js';
import { profile, label } from '../../server/jev/actions/profile.js';
import { changedJevStamp, sameJevSource, sourceSnapshot } from '../../server/jev/stamps.js';
import { groups, alternates } from './data/placement-families.mjs';

export const atlasIds = Object.freeze(['README', 'architecture', 'assistant-and-research', 'brand-and-ui', 'canvas-ui',
  'chat-internals', 'data-model', 'document-operations', 'errors', 'history', 'mcp-and-api', 'operations', 'plan-status',
  'reflex-internals', 'safe-collaboration', 'sdk-and-webmcp', 'search-and-brain-tools', 'security-and-access', 'symbi-reflex', 'testing']);
export type GroupOwnership = 'managed' | 'manual' | 'pinned';
// The starting membership is intentionally broad; the frozen answer key remains unchanged.
export const engineering = { ...groups.find(group => group.key === 'custom:engineering')!,
  definition: 'Building and maintaining technical systems: software architecture, implementation, APIs, databases, infrastructure, debugging, testing, and reliability.' };
export const request = { action: 'file' as const, canvasId: 'atlas', blockIds: [...atlasIds] };

function frozenDocument(id: string, ownership: GroupOwnership): JevInputDocument {
  const content = readFileSync(new URL(`./data/atlas/${id}.md`, import.meta.url), 'utf8');
  const block = { id, title: content.match(/^#\s+(.+)$/m)?.[1] ?? id, content, file: `${id}.md`, kind: 'markdown' as const,
    x: 0, y: 0, width: 400, height: 300, links: [], tags: [], group: engineering.key,
    incarnation: `bench-${id}`, sourceGeneration: 1, metadataRevision: 1,
    jevOwnership: { managed: ownership === 'manual' ? ['tags'] : ['group', 'tags'], pins: ownership === 'pinned' ? ['group'] : [],
      removedLabels: [], removedLinks: [] } };
  return { canvasId: 'atlas', block, snapshot: sourceSnapshot('w', 'atlas', block) };
}

export function broadStartContext(ownership: GroupOwnership, decider: JevDecider, apiKey = 'local-payload-review'): JevEvaluationContext {
  const documents = atlasIds.map(id => frozenDocument(id, ownership));
  return { workspaceId: 'w', documents, tasks: [], canvases: [{ id: 'atlas', name: 'Project Atlas' }],
    vocabulary: [{ id: 'engineering', kind: 'group', name: engineering.name, definition: engineering.definition,
      groupKey: engineering.key, state: 'active', version: 1, aliases: [],
      members: documents.map(document => ({ canvasId: document.canvasId, blockId: document.block.id })) }],
    settings: { ...emptyJevWorkspace().settings, externalProcessing: true }, confidenceThreshold: .7, apiKey, decider };
}

export function exactPassage(context: JevEvaluationContext, passage: JevPassage): boolean {
  const source = context.documents.find(document => document.canvasId === passage.source.canvasId && document.block.id === passage.source.blockId);
  return Boolean(source && sameJevSource(source.snapshot, passage.source)
    && source.block.content.slice(passage.start, passage.end) === passage.quote);
}

function installProfileIndexes(context: JevEvaluationContext, evaluated: JevEvaluation): void {
  for (const proposal of evaluated.proposals) {
    const mutation = proposal.mutation;
    if (mutation.kind !== 'derived') continue;
    const index = mutation.values.logicalIndex;
    if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error('Profile did not produce a logical index');
    context.indexes![`atlas:${mutation.blockId}`] = index;
  }
}
function failedProfile(document: string, error: unknown) {
  return { document, error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ApiError ? { status: error.status } : {}) };
}
async function profileDocuments(context: JevEvaluationContext) {
  const documents: JevValues = {};
  const profiled: JevEvaluation = { result: { documents }, proposals: [] };
  const failedProfiles: ReturnType<typeof failedProfile>[] = [];
  const successfulDocuments: string[] = [];
  context.indexes = {};
  for (const source of context.documents) {
    try {
      const evaluated = await profile(context, { ...request, action: 'profile', blockIds: [source.block.id] });
      installProfileIndexes(context, evaluated);
      Object.assign(documents, evaluated.result.documents);
      profiled.proposals.push(...evaluated.proposals);
      successfulDocuments.push(source.block.id);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      failedProfiles.push(failedProfile(source.block.id, error));
    }
  }
  return { profiled, failedProfiles, successfulDocuments };
}
function applyLabelMetadata(context: JevEvaluationContext, labeled: JevEvaluation): void {
  for (const proposal of labeled.proposals) {
    const mutation = proposal.mutation;
    if (mutation.kind !== 'document') continue;
    if (!Array.isArray(mutation.patch.tags)) throw new Error('Label proposal did not contain a tag list');
    const source = context.documents.find(document => document.canvasId === mutation.canvasId && document.block.id === mutation.blockId)!;
    source.block = changedJevStamp(source.block, { ...source.block, tags: mutation.patch.tags },
      { mutationId: `bench-label-${source.block.id}`, managed: true });
    source.snapshot = sourceSnapshot(context.workspaceId, source.canvasId, source.block);
  }
}
/** Match separate per-document queue jobs; one failed profile never certifies or blocks unrelated sources. */
export async function broadStartPrerequisites(context: JevEvaluationContext,
  phase: (action: 'profile' | 'label') => void = () => undefined) {
  phase('profile');
  const profiles = await profileDocuments(context);
  phase('label');
  const labeled = profiles.successfulDocuments.length
    ? await label(context, { ...request, action: 'label', blockIds: profiles.successfulDocuments })
    : { result: { documents: {} }, proposals: [] };
  applyLabelMetadata(context, labeled);
  return { ...profiles, labeled, indexes: context.indexes!,
    appliedLabelMetadata: context.documents.map(document => ({ document: document.block.id,
      tags: document.block.tags, ownership: document.block.jevOwnership, source: document.snapshot })) };
}

export function broadStartManifest(context: JevEvaluationContext) {
  const candidates = context.documents.map(document => ({ document: document.block.id,
    alternatives: sharedGroupRefinements(context, document, engineering.key) }));
  if (!candidates.every(row => row.alternatives.every(group => group.origins.every(passage => exactPassage(context, passage))))) {
    throw new Error('Broad-start candidates contain inexact frozen-source provenance');
  }
  return { corpus: 'frozen Project Atlas Markdown corpus', documents: context.documents.map(document => ({
    id: document.block.id, title: document.block.title, bytes: Buffer.byteLength(document.block.content), source: document.snapshot })),
  corpusSha256: createHash('sha256').update(JSON.stringify(context.documents.map(document => document.snapshot))).digest('hex'),
  existingGroups: context.vocabulary, ownership: context.documents[0].block.jevOwnership,
  frozenFamilyKeys: groups, acceptableAlternates: alternates, unscoredDocuments: ['README'], candidates,
  limits: { sharedAlternatives: 15, comparisonGroups: 16, originsPerAlternative: 4,
    typicalSharedFamilyRefinementCallsPerDocument: 4, selectiveSharedFamilyRefinementCallsPerDocument: 6,
    refinementAttemptsPerDocument: 3, peerChecksPerCandidate: 4,
    providerCallCeiling: 200, providerRetriesPerCall: 2 },
  interpretation: 'Family keys are frozen reviewer context. Raw source-derived names are not mapped to gold names or auto-scored as semantic correctness.' };
}

function membershipRows(context: JevEvaluationContext, result: JevEvaluation) {
  return context.documents.map(document => {
    const memberships = result.proposals.filter(proposal => proposal.mutation.kind === 'document' && proposal.mutation.blockId === document.block.id);
    if (memberships.length > 1) throw new Error(`Ambiguous placements for ${document.block.id}`);
    const proposal = memberships[0];
    const target = proposal?.mutation.kind === 'document' ? proposal.mutation.patch.group : undefined;
    const family = groups.find(group => group.members.includes(document.block.id));
    return { document: document.block.id, expectedFamilies: family ? alternates[document.block.id] ?? [family.key] : [],
      scored: Boolean(family), current: document.block.group, proposed: target ?? null,
      projected: target ?? document.block.group, refined: Boolean(target && target !== document.block.group),
      decision: (result.result.documents as Record<string, unknown>)[document.block.id],
      evidence: proposal?.evidence ?? [], sourceGuards: proposal?.sources ?? [], decisionConfidences: proposal?.decisionConfidences ?? [] };
  });
}

function definitionOrder(context: JevEvaluationContext, result: JevEvaluation): boolean {
  const defined = new Set(context.vocabulary.map(term => term.groupKey));
  return result.proposals.every(proposal => {
    if (proposal.mutation.kind === 'vocabulary') { defined.add(proposal.mutation.term.groupKey); return true; }
    return proposal.mutation.kind !== 'document' || defined.has(proposal.mutation.patch.group ?? undefined);
  });
}

function guardedProposal(context: JevEvaluationContext, proposal: JevEvaluation['proposals'][number]): boolean {
  const guarded = proposal.sources.length > 0 && proposal.sources.every(snapshot => context.documents.some(document => sameJevSource(document.snapshot, snapshot)));
  if (!guarded || !proposal.evidence.length || !proposal.evidence.every(passage => exactPassage(context, passage))) return false;
  if (proposal.mutation.kind !== 'document') return true;
  const mutation = proposal.mutation;
  return proposal.evidence.every(passage => passage.source.canvasId === mutation.canvasId && passage.source.blockId === mutation.blockId);
}

export function broadStartReport(context: JevEvaluationContext, result: JevEvaluation) {
  const exact = result.proposals.every(proposal => guardedProposal(context, proposal));
  const ordered = definitionOrder(context, result);
  if (!exact || !ordered) throw new Error('Broad-start result violated exact evidence or define-before-membership');
  const rows = membershipRows(context, result);
  const projectedGroups = [...new Set(rows.map(row => row.projected))].map(key => ({ key,
    members: rows.filter(row => row.projected === key).map(row => row.document) }));
  return { rows, rawProposals: result.proposals, projectedGroups,
    summary: { documents: rows.length, scoredFamilyKeys: rows.filter(row => row.scored).length,
      refined: rows.filter(row => row.refined).length, retainedEngineering: rows.filter(row => !row.refined).length,
      singletonGroups: projectedGroups.filter(group => group.members.length === 1),
      exactEvidence: exact, definitionsBeforeMembership: ordered,
      manualOrPinned: context.documents.filter(document => !document.block.jevOwnership!.managed.includes('group')
        || document.block.jevOwnership!.pins.includes('group')).map(document => document.block.id),
      projectionOnly: true, canonicalWrites: 0, semanticCorrectness: 'Requires review of raw placements and exact source evidence against frozen family keys' } };
}
