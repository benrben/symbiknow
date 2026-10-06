import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevEvaluation, JevJob, JevMutation, JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { passages, type JevEvaluationContext } from './actions/context.js';
import { CanvasStore } from '../storage.js';
import { evaluationContext } from './context.js';
import { checkVocabularyMembers, checkVocabularyReferences, stateMutation } from './proposal-state.js';
import { reconcileHeadlineSuggestions, recordJevCandidates } from './runtime-proposals.js';
import { JevRuntime } from './runtime.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime;
let workspaceId: string; let canvasId: string; let blockId: string; let files: JevWorkspaceFiles;
let headlineSelection: number; let historicalSequence: number;
beforeEach(async () => {
  headlineSelection = 0; historicalSequence = 0;
  root = await mkdtemp(path.join(tmpdir(), 'reflex-workspace-proposals-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Review proposals' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Saved sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Review', content: '# Review\nReview the saved source.' })).id;
  files = new JevWorkspaceFiles(root);
  // Provider-free runtime keeps explicit historic review fixtures isolated from the automatic daemon.
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async context => ({ result: {}, proposals: [headlineCandidate(context, 'file')] }) });
  await runtime.configure(workspaceId, { modes: { file: 'auto' } as never }, owner);
});
afterEach(async () => { runtime.close(); await runtime.idle(); await rm(root, { recursive: true, force: true }); });
function headlineCandidate(context: JevEvaluationContext, action: 'file' | 'set_headline'): JevEvaluation['proposals'][number] {
  const document = context.documents.find(item => item.canvasId === canvasId && item.block.id === blockId)!;
  const passage = passages(document).filter(item => item.quote.length <= 80)[headlineSelection];
  return { action, title: 'Saved extractive headline fixture', explanation: 'Exact saved passage from a historic decision', confidence: 0.99,
    evidence: [passage], sources: [document.snapshot], mutation: { kind: 'document', canvasId, blockId, patch: { headline: passage.quote } } };
}
async function review() {
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId] }, owner); await runtime.idle();
  const state = await files.read(workspaceId); const proposal = state.proposals.find(item => item.jobId === job.id)!;
  return { state, job: state.jobs.find(item => item.id === job.id)!, proposal, context: await evaluationContext(store, workspaceId, state, job.request, owner, new AbortController().signal) };
}
async function historicalReview(previous?: JevWorkspaceState) {
  const state = previous ?? await files.read(workspaceId);
  const context = await evaluationContext(store, workspaceId, state, { action: 'file', canvasId, blockIds: [blockId] }, owner, new AbortController().signal);
  const candidate = headlineCandidate(context, 'set_headline');
  const createdAt = new Date(Date.UTC(2020, 0, 1) + historicalSequence++).toISOString();
  const job: JevJob = { id: randomUUID(), request: { action: 'set_headline', canvasId, blockIds: [blockId] }, state: 'completed',
    createdAt, updatedAt: createdAt, sources: candidate.sources, proposalIds: [] };
  state.jobs.push(job); recordJevCandidates(state, job, { result: {}, proposals: [candidate] }, context);
  return { state, job, proposal: state.proposals.find(item => item.id === job.proposalIds[0])!, context };
}
function evaluation(proposal: JevProposal): JevEvaluation { return { result: {}, proposals: [proposal] }; }
async function proposal(mutation: JevMutation): Promise<JevProposal> {
  const source = sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, blockId));
  return { id: randomUUID(), jobId: `override:${randomUUID()}`, action: 'vocab_lifecycle', title: 'Review vocabulary', explanation: 'Explicit vocabulary request',
    evidence: [], sources: [source], mutation, state: 'pending', createdAt: new Date().toISOString() };
}

it('consolidates legacy repeated pending native decisions and idempotently replays an applied job', async () => {
  const native = await review(); native.state.proposals.push({ ...native.proposal, id: randomUUID() });
  native.job.proposalIds = [];
  recordJevCandidates(native.state, native.job, evaluation(native.proposal), native.context);
  recordJevCandidates(native.state, native.job, evaluation(native.proposal), native.context);
  expect(native.state.proposals.filter(item => item.state === 'pending')).toHaveLength(1);
  expect(native.state.proposals.filter(item => item.state === 'stale')).toHaveLength(1);
  await files.write(workspaceId, native.state); await runtime.apply(workspaceId, native.proposal.id, owner);
  const saved = await files.read(workspaceId); const job = saved.jobs.find(item => item.id === native.job.id)!; job.proposalIds = [];
  recordJevCandidates(saved, job, evaluation(native.proposal), native.context);
  recordJevCandidates(saved, job, evaluation(native.proposal), native.context);
  expect(job.proposalIds).toEqual([native.proposal.id]);
  expect(saved.proposals).toHaveLength(2);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).headline).toBe('# Review');
});

it('keeps dismissed and suppressed native decisions out of review and supersedes changed-source guards', async () => {
  const native = await review(); await runtime.dismiss(workspaceId, native.proposal.id, owner);
  let state = await files.read(workspaceId); recordJevCandidates(state, state.jobs[0], evaluation(native.proposal), native.context);
  expect(state.proposals).toHaveLength(1);
  await store.updateBlock(canvasId, blockId, { title: 'Review again' });
  const next = await review(); await runtime.suppress(workspaceId, next.proposal.id, owner);
  state = await files.read(workspaceId); recordJevCandidates(state, next.job, evaluation(next.proposal), next.context);
  expect(state.proposals.filter(item => item.state === 'pending')).toEqual([]);
  state.settings.modes.file = 'shadow'; recordJevCandidates(state, next.job, evaluation(next.proposal), next.context);
  expect(state.proposals).toHaveLength(2);
});

it('persists a fresh replacement when source guards or legacy aggregate source counts differ', async () => {
  const native = await review(); const extra = await store.createBlock(canvasId, { title: 'Context', content: '# Context' });
  native.state.proposals[0].sources.push(sourceSnapshot(workspaceId, canvasId, extra)); await files.write(workspaceId, native.state);
  await store.updateBlock(canvasId, blockId, { title: 'Fresh review' }); await review();
  const saved = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(saved.proposals.filter(item => item.state === 'stale')).toHaveLength(1);
  expect(saved.proposals.filter(item => item.state === 'pending')).toHaveLength(1);
});

it('persists scoped derived facts and restores their exact prior values through the workspace inverse', async () => {
  const state = await files.read(workspaceId); const source = sourceSnapshot(workspaceId, canvasId, await store.getCanvasBlock(canvasId, blockId));
  const derived = await proposal({ kind: 'derived', blockId, values: { role: 'specification' } });
  const context = await evaluationContext(store, workspaceId, state, { action: 'profile', canvasId }, owner, new AbortController().signal);
  const job = { id: randomUUID(), request: { action: 'profile' as const, canvasId }, state: 'completed' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sources: [source], proposalIds: [] };
  recordJevCandidates(state, job, evaluation(derived), context);
  const savedProposal = state.proposals[0]; const before = stateMutation(state, savedProposal); await files.write(workspaceId, state);
  expect((await files.read(workspaceId)).profiles[`${canvasId}:${blockId}`]).toMatchObject({ role: 'specification', source, scopedCanvasIds: [canvasId] });
  stateMutation(state, { ...savedProposal, jobId: 'undo:derived', mutation: before });
  expect(state.profiles[`${canvasId}:${blockId}`]).toEqual({});
  const workspaceFact = await proposal({ kind: 'derived', values: { summary: 'Current workspace' } });
  stateMutation(state, workspaceFact); expect(state.profiles['workspace:vocab_lifecycle']).toEqual({ summary: 'Current workspace' });
  await expect(proposal({ kind: 'document', canvasId, blockId, patch: {} }).then(item => stateMutation(state, item))).rejects.toMatchObject({ status: 400 });
});

it('persists checked vocabulary revisions and refuses outdated versions, collisions, and unavailable members', async () => {
  const state = await files.read(workspaceId);
  const term = { id: 'label-review', kind: 'label' as const, name: 'Review', definition: 'Sources needing review', aliases: [], members: [{ canvasId, blockId }], version: 1, state: 'active' as const };
  const define = await proposal({ kind: 'vocabulary', operation: 'define', term });
  await checkVocabularyMembers(store, workspaceId, define.mutation);
  const before = stateMutation(state, define); await files.write(workspaceId, state);
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).vocabulary).toEqual([term]);
  expect(() => stateMutation(state, define)).toThrowError(expect.objectContaining({ status: 409 }));
  const renamed = await proposal({ kind: 'vocabulary', operation: 'rename', term: { ...term, name: 'Reviewed', version: 2 } });
  expect(stateMutation(state, renamed)).toMatchObject({ operation: 'restore', term });
  const collision = await proposal({ kind: 'vocabulary', operation: 'define', term: { ...term, id: 'different-review', name: 'Reviewed' } });
  expect(() => stateMutation(state, collision)).toThrowError(expect.objectContaining({ status: 409 }));
  const remove = await proposal({ kind: 'vocabulary', operation: 'remove', term: { ...term, name: 'Reviewed', version: 2 } });
  stateMutation(state, remove); expect(state.vocabulary).toEqual([]); expect(before).toMatchObject({ operation: 'remove' });
  await checkVocabularyMembers(store, workspaceId, { kind: 'document', canvasId, blockId, patch: {} });
  await expect(checkVocabularyMembers(store, workspaceId, { kind: 'vocabulary', operation: 'define', term: { ...term, members: [{ canvasId, blockId: 'missing' }] } })).rejects.toMatchObject({ status: 409 });
  const otherWorkspace = (await store.createWorkspace({ name: 'Outside scope' })).id; const otherCanvas = (await store.createCanvas(otherWorkspace, { name: 'Outside' })).id;
  const otherBlock = await store.createBlock(otherCanvas, { title: 'Outside source', content: '# Outside' });
  await expect(checkVocabularyMembers(store, workspaceId, { kind: 'vocabulary', operation: 'define', term: { ...term, members: [{ canvasId: otherCanvas, blockId: otherBlock.id }] } })).rejects.toMatchObject({ status: 409 });
});

it('requires saved placements to be undone before a group or ancestor definition can be removed', async () => {
  const term = { id: 'group-review', kind: 'group' as const, name: 'Review', definition: 'Review sources', aliases: [], members: [{ canvasId, blockId }], version: 1, state: 'active' as const, groupKey: 'custom:review' };
  const mutation: JevMutation = { kind: 'vocabulary', operation: 'remove', term };
  await store.updateBlock(canvasId, blockId, { group: 'custom:review' });
  await expect(checkVocabularyReferences(store, mutation)).rejects.toMatchObject({ status: 409 });
  await store.updateBlock(canvasId, blockId, { group: 'custom:review/subgroup' });
  await expect(checkVocabularyReferences(store, mutation)).rejects.toMatchObject({ status: 409 });
  await store.updateBlock(canvasId, blockId, { group: null }); await checkVocabularyReferences(store, mutation);
  await checkVocabularyReferences(store, { ...mutation, term: { ...term, members: [{ canvasId, blockId: 'removed' }] } });
  await checkVocabularyReferences(store, { ...mutation, operation: 'define' });
  await checkVocabularyReferences(store, { ...mutation, term: { ...term, kind: 'label' } });
  await checkVocabularyReferences(store, { ...mutation, term: { ...term, groupKey: undefined } });
  await checkVocabularyReferences(store, { kind: 'document', canvasId, blockId, patch: {} });
});

it('replaces an older legacy overlong headline with the newest checked exact passage and preserves source bytes through Apply and Undo', async () => {
  const long = 'An earlier extractive headline '.repeat(4).trim();
  const content = `# Review\n${long}\nReview the saved source.`;
  await store.updateBlock(canvasId, blockId, { content });
  const old = await historicalReview();
  const start = content.indexOf(long);
  old.proposal.mutation = { kind: 'document', canvasId, blockId, patch: { headline: long } };
  old.proposal.evidence = [{ source: old.proposal.sources[0], quote: long, start, end: start + long.length }];
  old.job.questionVersion = 'symbi-reflex-4';
  expect(reconcileHeadlineSuggestions(old.state)).toBe(true);
  expect(old.proposal.state).toBe('stale');
  await files.write(workspaceId, old.state);
  headlineSelection = 1; const latest = await review();
  expect(latest.state.proposals.find(item => item.id === old.proposal.id)?.state).toBe('stale');
  expect(latest.state.proposals.filter(item => item.state === 'pending')).toHaveLength(1);
  const receipt = await runtime.apply(workspaceId, latest.proposal.id, owner);
  const fresh = await new CanvasStore(root).getCanvasBlock(canvasId, blockId);
  expect(fresh.headline).toBe('Review the saved source.'); expect(fresh.content).toBe(content);
  await runtime.undo(workspaceId, receipt.id, owner);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe(content);
});

it('preserves an explicit reviewer edit while refreshing an independent checked headline', async () => {
  const old = await review();
  await runtime.revise(workspaceId, old.proposal.id, { kind: 'document', canvasId, blockId, patch: { headline: 'Owner reviewed choice' } }, owner);
  headlineSelection = 1; const latest = await review();
  expect(latest.state.proposals.find(item => item.id === old.proposal.id)).toMatchObject({ state: 'pending', reviewerEdited: true,
    mutation: { patch: { headline: 'Owner reviewed choice' } } });
  expect(latest.state.proposals.filter(item => item.state === 'pending')).toHaveLength(2);
  expect((await store.getCanvasBlock(canvasId, blockId)).headline).toBeUndefined();
});

it('does not resurrect an older checked headline when its job is replayed after a newer decision', async () => {
  const old = await historicalReview(); headlineSelection = 1; const latest = await historicalReview(old.state);
  const oldJob = latest.state.jobs.find(job => job.id === old.job.id)!;
  recordJevCandidates(latest.state, oldJob, evaluation(old.proposal), latest.context);
  expect(latest.state.proposals.filter(item => item.state === 'pending').map(item => item.id)).toEqual([latest.proposal.id]);
  expect(latest.state.proposals.find(item => item.id === old.proposal.id)?.state).toBe('stale');
  await files.write(workspaceId, latest.state);
  const reloaded = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(reloaded.proposals.find(item => item.id === latest.proposal.id)?.state).toBe('dismissed');
  expect(reloaded.proposals.find(item => item.id === old.proposal.id)?.state).toBe('stale');
});

it('keeps legacy derived facts and another document separate when old headline job history has been compacted', async () => {
  const native = await historicalReview();
  const extra = await store.createBlock(canvasId, { title: 'Other', content: '# Other' });
  const prior = { ...native.proposal, id: randomUUID(), jobId: 'compacted-headline', createdAt: '2020-01-01T00:00:00.000Z',
    mutation: { kind: 'document' as const, canvasId, blockId, patch: { headline: 'Earlier source' } } };
  const facts = { ...prior, id: randomUUID(), mutation: { kind: 'derived' as const, blockId, values: { note: 'Legacy headline evidence' } } };
  const peer = { ...prior, id: randomUUID(), mutation: { kind: 'document' as const, canvasId, blockId: extra.id, patch: { headline: '# Other' } } };
  const otherCanvas = { ...peer, id: randomUUID(), mutation: { ...peer.mutation, canvasId: 'another-canvas' } };
  native.state.proposals.push(prior, facts, peer, otherCanvas);
  recordJevCandidates(native.state, native.job, evaluation(native.proposal), native.context);
  recordJevCandidates(native.state, native.job, evaluation(facts), native.context);
  expect(reconcileHeadlineSuggestions(native.state)).toBe(false);
  expect(native.state.proposals.find(item => item.id === prior.id)?.state).toBe('stale');
  for (const item of [peer, otherCanvas, facts]) {
    expect(native.state.proposals.find(saved => saved.id === item.id)?.state).toBe('pending');
  }
  await files.write(workspaceId, native.state);
  const fresh = await files.read(workspaceId);
  expect(fresh.proposals.find(item => item.id === prior.id)?.state).toBe('stale');
  for (const item of [peer, otherCanvas, facts]) {
    expect(fresh.proposals.find(saved => saved.id === item.id)).toMatchObject({ state: 'dismissed', mutation: item.mutation });
  }
});

it('retires duplicate historic review ledgers on restart without another provider call or source write', async () => {
  const old = await historicalReview(); headlineSelection = 1; const latest = await historicalReview(old.state);
  expect(latest.state.proposals.find(item => item.id === old.proposal.id)?.state).toBe('stale');
  latest.state.proposals.find(item => item.id === old.proposal.id)!.state = 'pending';
  await files.write(workspaceId, latest.state);
  const previousJobs = latest.state.jobs.map(job => job.id);
  await runtime.shutdown();
  runtime = new JevRuntime(new CanvasStore(root), { startTimer: false });
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.map(job => job.id)).toEqual(previousJobs);
  expect(state.proposals.filter(item => item.state === 'pending')).toEqual([]);
  expect(state.proposals.filter(item => item.state === 'dismissed').map(item => item.id).sort()).toEqual([old.proposal.id, latest.proposal.id].sort());
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).proposals.find(item => item.id === old.proposal.id)?.state).toBe('dismissed');
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Review\nReview the saved source.');
});

it('retires an impossible legacy headline on restart without discarding reviewer choices or changing saved content', async () => {
  const native = await historicalReview();
  const long = 'Legacy source passage '.repeat(5);
  native.proposal.mutation = { kind: 'document', canvasId, blockId, patch: { headline: long } };
  const reviewed = { ...native.proposal, id: randomUUID(), reviewerEdited: true };
  const valid = { ...native.proposal, id: randomUUID(), mutation: { kind: 'document' as const, canvasId, blockId, patch: { headline: 'A'.repeat(80) } } };
  native.state.proposals.push(reviewed, valid);
  expect(reconcileHeadlineSuggestions(native.state)).toBe(true);
  expect(native.proposal.state).toBe('stale');
  expect(native.state.proposals.filter(item => item.state === 'pending').map(item => item.id)).toEqual([reviewed.id, valid.id]);
  await files.write(workspaceId, native.state); await runtime.shutdown();
  runtime = new JevRuntime(new CanvasStore(root), { startTimer: false });
  const state = await runtime.read(workspaceId, owner);
  expect(state.proposals.find(item => item.id === native.proposal.id)?.state).toBe('stale');
  expect(state.proposals.filter(item => item.state === 'pending')).toEqual([]);
  expect(state.proposals.find(item => item.id === reviewed.id)).toMatchObject({ state: 'dismissed', reviewerEdited: true, mutation: reviewed.mutation });
  expect(state.proposals.find(item => item.id === valid.id)).toMatchObject({ state: 'dismissed', mutation: valid.mutation });
  expect(state.jobs.map(job => job.id)).toEqual(native.state.jobs.map(job => job.id));
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Review\nReview the saved source.');
});
