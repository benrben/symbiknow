import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { JevActionRequest, JevEvaluation, JevMutation, JevPassage, JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { evaluationContext } from './context.js';
import type { JevEvaluationContext } from './actions.js';
import { emptyJevWorkspace } from './workspace.js';
import { principalFingerprint } from './authorization.js';
import { checkFinishingPolicy, processingPolicyKey, validateJevEvaluation } from './runtime-guards.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let directory: string;
let context: JevEvaluationContext;
let state: JevWorkspaceState;
let request: JevActionRequest;
let baseline: JevProposal;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'symbi-reflex-runtime-guards-'));
  const store = new CanvasStore(directory); await store.init();
  const workspaceId = (await store.createWorkspace({ name: 'Checked guard sources' })).id;
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Release' })).id;
  const first = await store.createBlock(canvasId, { title: 'Release guidance', content: '# Release\nShip after rollback is checked.' });
  await store.createBlock(canvasId, { title: 'Rollback guidance', content: '# Rollback\nRestore the last checked release.' });
  const other = await store.createCanvas(workspaceId, { name: 'Companion' });
  await store.createBlock(other.id, { title: 'Companion source', content: '# Companion\nThe service requires the rollout guide.' });
  state = emptyJevWorkspace(); state.settings.modes.file = 'auto';
  request = { action: 'file', canvasId, blockIds: [first.id] };
  context = await evaluationContext(store, workspaceId, state, request, owner, new AbortController().signal);
  const source = context.documents.find(document => document.block.id === first.id)!.snapshot;
  baseline = { id: 'checked-proposal', jobId: 'checked-job', action: 'file', title: 'File checked source', explanation: 'Exact source passage',
    mutation: { kind: 'document', canvasId, blockId: first.id, patch: { group: 'custom:release' } },
    sources: [source], evidence: [{ source, start: 0, end: 9, quote: '# Release' }], state: 'pending', createdAt: new Date().toISOString() };
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function evaluation(proposal = baseline): JevEvaluation { return { result: {}, proposals: [proposal] }; }
function changed(change: (proposal: JevProposal) => void): JevProposal {
  const proposal = structuredClone(baseline); change(proposal); return proposal;
}
function expectRejected(proposal: JevProposal, message: string) {
  expect(() => validateJevEvaluation(evaluation(proposal), context, request, owner)).toThrow(message);
}

it('accepts native exact excerpts and source snapshots whose JSON property ordering differs', () => {
  const proposal = structuredClone(baseline);
  proposal.sources[0] = Object.fromEntries(Object.entries(proposal.sources[0]).reverse()) as typeof proposal.sources[0];
  expect(() => validateJevEvaluation(evaluation(proposal), context, request, owner)).not.toThrow();
  expect(() => validateJevEvaluation({ result: {}, proposals: [] }, context, request, owner)).not.toThrow();
});

it('rejects malformed or unbounded evaluator result containers before considering canonical writes', () => {
  for (const invalid of [undefined, { result: {}, proposals: {} }, { result: {}, proposals: Array.from({ length: 101 }, () => baseline) }]) {
    expect(() => validateJevEvaluation(invalid as unknown as JevEvaluation, context, request, owner)).toThrow('Invalid decision result');
  }
});

it('rejects mismatched actions, unknown revisions, and document targets absent from their reviewed sources', () => {
  expectRejected(changed(proposal => { proposal.action = 'label'; }), 'Unexpected decision action');
  expectRejected(changed(proposal => { proposal.sources[0].metadataRevision++; }), 'Unknown decision source');
  const unreviewed = context.documents.find(document => document.snapshot.blockId !== baseline.sources[0].blockId)!;
  for (const mutation of [
    { kind: 'document', canvasId: unreviewed.canvasId, blockId: unreviewed.block.id, patch: { group: 'custom:release' } },
    { kind: 'move', canvasId: unreviewed.canvasId, blockId: unreviewed.block.id, targetCanvasId: request.canvasId },
    { kind: 'content', canvasId: unreviewed.canvasId, blockId: unreviewed.block.id, content: 'Reviewed draft', expectedContentHash: unreviewed.snapshot.contentHash, draftId: 'checked-draft' },
  ] satisfies JevMutation[]) expectRejected(changed(proposal => { proposal.mutation = mutation; }), 'Mutation target is not a reviewed source');
});

it('requires every vocabulary member and every evidence source to be separately reviewed', () => {
  const source = context.documents.find(document => document.snapshot.blockId !== baseline.sources[0].blockId)!;
  const mutation: JevMutation = { kind: 'vocabulary', operation: 'define', term: { id: 'release-term', kind: 'label', name: 'Release',
    definition: 'Checked release guidance', state: 'active', version: 1, aliases: [], members: [{ canvasId: source.canvasId, blockId: source.block.id }] } };
  expectRejected(changed(proposal => { proposal.mutation = mutation; }), 'Vocabulary members are not reviewed sources');
  const accepted = changed(proposal => { proposal.mutation = mutation; proposal.sources.push(source.snapshot); });
  expect(() => validateJevEvaluation(evaluation(accepted), context, request, owner)).not.toThrow();
  expectRejected(changed(proposal => { proposal.evidence[0].source = source.snapshot; }), 'Evidence is not included in the reviewed source guards');
});

it('checks exact integer excerpt boundaries instead of accepting slicing coercion or mismatched quotations', () => {
  const content = context.documents.find(document => document.snapshot.blockId === baseline.sources[0].blockId)!.block.content;
  const invalid: Array<Partial<JevPassage>> = [{ start: 0.5 }, { start: Number.NaN }, { start: -1 }, { end: content.length + 1 },
    { start: 9, end: 9 }, { start: 10, end: 9 }, { quote: 'A fabricated claim' }];
  for (const patch of invalid) expectRejected(changed(proposal => { Object.assign(proposal.evidence[0], patch); }), 'Decision evidence does not match its source');
});

it('rejects a mutation outside the current native canvas grant', () => {
  const other = context.documents.find(document => document.canvasId !== request.canvasId)!;
  const proposal = changed(value => { value.mutation = { kind: 'move', canvasId: request.canvasId,
    blockId: baseline.sources[0].blockId, targetCanvasId: other.canvasId }; });
  expect(() => validateJevEvaluation(evaluation(proposal), context, request, { ...owner, allowedCanvasIds: [request.canvasId] })).toThrow('Document scope not found');
});

it('checks cancellation, settings changes, pause, and grants independently at completion', () => {
  const controller = new AbortController();
  const job = { settingsKey: processingPolicyKey(state), authorizationFingerprint: principalFingerprint(owner) };
  const check = (nextState = state, current = { state: 'running' }, principal = owner, signal = controller.signal) =>
    checkFinishingPolicy(nextState, current, job, principal, signal);
  expect(() => check()).not.toThrow();
  expect(() => check(state, { state: 'cancelled' })).toThrow('The action was cancelled or its policy changed');
  expect(() => check({ ...state, settings: { ...state.settings, paused: true } })).toThrow('The action was cancelled or its policy changed');
  expect(() => check({ ...state, settings: { ...state.settings, externalProcessing: false } })).toThrow('The action was cancelled or its policy changed');
  expect(() => check(state, { state: 'running' }, { ...owner, access: 'read' })).toThrow('The action was cancelled or its policy changed');
  controller.abort(); expect(() => check()).toThrow('The action was cancelled or its policy changed');
});
