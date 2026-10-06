import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { JevJob, JevProposal } from '../../shared/jev-types.js';
import { createApiServer } from '../index.js';
import { CanvasStore } from '../storage.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';
import { JevRuntime } from './runtime.js';

const opened: Array<{ server: Server; root: string }> = [];
interface ReviewResponse {
  contentHash: string;
  actions: Array<{ action: string; state: string; scores: Array<{ name: string; value: number }> }>;
  grouping?: { proposalId: string; groupKey: string; proposalIds: string[]; scores: number[];
    canApprove: boolean; evidence: Array<{ quote: string }> };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('shows bounded chosen scores and source evidence, then approves only the exact current group proposal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-document-review-'));
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
  const url = `http://127.0.0.1:${address.port}/api/workspaces/acme-team/jev/documents/roadmap-overview`;
  const store = new CanvasStore(root); await store.ensureJevStamps('product-roadmap');
  const canvasId = 'product-roadmap'; const blockId = 'roadmap-overview';
  const block = await store.getCanvasBlock(canvasId, blockId);
  const reviewUrl = `${url}/review?canvasId=${canvasId}`;
  const emptyResponse = await fetch(reviewUrl);
  expect(emptyResponse.status).toBe(200);
  const empty = await emptyResponse.json() as ReviewResponse;
  expect(empty.actions).toHaveLength(6);
  expect(empty.actions.every(action => action.state === 'waiting' && action.scores.length === 0)).toBe(true);
  const source = sourceSnapshot('acme-team', canvasId, block);
  const state = await new JevWorkspaceFiles(root).read('acme-team');
  const createdAt = new Date().toISOString();
  const job: JevJob = { id: 'review-job', request: { action: 'file', canvasId, blockIds: [blockId] }, state: 'completed',
    createdAt, updatedAt: createdAt, sources: [source], proposalIds: ['review-group'], result: { documents: { [blockId]: { status: 'proposed' } } } };
  const quote = block.content.slice(0, 12);
  const proposal: JevProposal = { id: 'review-group', jobId: job.id, action: 'file', title: 'File under Overview',
    explanation: 'Checked source passage', confidence: 0.91, decisionConfidences: [0.92, 0.88],
    evidence: [{ source, start: 0, end: quote.length, quote }], sources: [source],
    mutation: { kind: 'document', canvasId, blockId, patch: { group: 'lane:overview' } }, state: 'pending', createdAt };
  state.jobs.push(job); state.proposals.push(proposal);
  proposal.evidence = [];
  await new JevWorkspaceFiles(root).write('acme-team', state);
  expect((await fetch(reviewUrl).then(response => response.json()) as ReviewResponse).grouping).toBeUndefined();
  const evidenceFreeApproval = await fetch(`${url}/approve-group`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ canvasId, contentHash: block.contentHash, proposalId: proposal.id }) });
  expect(evidenceFreeApproval.status).toBe(409);
  proposal.evidence = [{ source, start: 0, end: quote.length, quote }];
  await new JevWorkspaceFiles(root).write('acme-team', state);
  const reviewResponse = await fetch(reviewUrl);
  expect(reviewResponse.status).toBe(200);
  const review = await reviewResponse.json() as ReviewResponse;
  expect(review.contentHash).toBe(block.contentHash);
  expect(review.actions.find(action => action.action === 'file')?.scores).toEqual([
    { name: 'decision 1', value: 0.92 }, { name: 'decision 2', value: 0.88 }]);
  expect(review.grouping).toMatchObject({ proposalId: proposal.id, groupKey: 'lane:overview',
    proposalIds: [proposal.id], scores: [0.92, 0.88], canApprove: true,
    evidence: [{ quote }] });
  const post = (suffix: string, input: unknown) => fetch(`${url}/${suffix}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  expect((await post('approve-group', { canvasId, contentHash: '0'.repeat(16), proposalId: proposal.id })).status).toBe(409);
  expect((await post('approve-group', { canvasId, contentHash: block.contentHash, proposalId: 'other' })).status).toBe(409);
  const approved = await post('approve-group', { canvasId, contentHash: block.contentHash, proposalId: proposal.id });
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBe('lane:overview');
  expect((await fetch(reviewUrl).then(response => response.json()) as ReviewResponse).grouping?.canApprove).toBe(false);
  expect((await post('recheck', { canvasId, contentHash: '0'.repeat(16) })).status).toBe(409);
  vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '1');
  const paused = await post('recheck', { canvasId, contentHash: block.contentHash });
  expect(paused.status).toBe(503);
  expect(await paused.text()).toContain('Jev checks are paused for this app session');
});

it('admits an explicit offline six-action recheck only for an owner and the current source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-document-recheck-'));
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Review fixture' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
  const block = await store.createBlock(canvas.id, { title: 'Atlas', content: '# Atlas\nAtlas source evidence.' });
  let releaseProfile: () => void = () => undefined;
  const profileGate = new Promise<void>(resolve => { releaseProfile = resolve; });
  const runtime = new JevRuntime(store, { startTimer: false, documentExecution: true,
    evaluate: async (_context, request) => {
      if (request.action === 'profile') await profileGate;
      return { result: { status: 'checked' }, proposals: [] };
    } });
  try {
    await runtime.idle();
    runtime.useTransport({ apiKey: 'offline-fixture-key' });
    const source = await store.getCanvasBlock(canvas.id, block.id);
    const owner = { id: 'owner', kind: 'user' as const, access: 'write' as const, canConfigure: true, canApprove: true };
    await expect(runtime.recheckDocument(workspace.id, canvas.id, block.id, '0'.repeat(16), owner))
      .rejects.toMatchObject({ status: 409 });
    await expect(runtime.recheckDocument(workspace.id, canvas.id, block.id, source.contentHash!,
      { ...owner, canConfigure: false })).rejects.toMatchObject({ status: 403 });
    const admitted = await runtime.recheckDocument(workspace.id, canvas.id, block.id, source.contentHash!, owner);
    const coalesced = await runtime.recheckDocument(workspace.id, canvas.id, block.id, source.contentHash!, owner);
    expect(coalesced.jobId).toBe(admitted.jobId);
    releaseProfile();
    await runtime.idle();
    const state = await runtime.read(workspace.id, owner);
    const saved = state.jobs.find(job => job.id === admitted.jobId) as JevJob &
      { documentPlan?: { completedActions: string[] } };
    expect(saved.state).toBe('completed');
    expect(saved.documentPlan?.completedActions).toEqual(['profile', 'label', 'link', 'flag_duplicate', 'file', 'suggest_home_canvas']);
    expect((await store.getCanvasBlock(canvas.id, block.id)).content).toBe(source.content);
  } finally {
    releaseProfile();
    runtime.close(); await runtime.idle(); await rm(root, { recursive: true, force: true });
  }
});
