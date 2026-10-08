import { expect, it } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevJob, JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import { documentReview } from './document-review.js';
import type { DocumentJob } from './runtime-document.js';
import { sourceSnapshot } from './stamps.js';
import { emptyJevWorkspace } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true };
const canvasId = 'sources';
const workspaceId = 'offline-review';
const at = '2026-10-06T00:00:00.000Z';

function fixture() {
  const block: CanvasBlock = { id: 'atlas', file: 'docs/atlas.md', kind: 'markdown', title: 'Atlas',
    content: '# Atlas\nRelease evidence.', x: 0, y: 0, width: 320, height: 200, links: [],
    incarnation: 'atlas-source', sourceGeneration: 1, metadataRevision: 1 };
  const source = sourceSnapshot(workspaceId, canvasId, block);
  block.contentHash = source.contentHash;
  const state = emptyJevWorkspace();
  function job(action: JevJob['request']['action'] = 'file', id = 'checked-file'): JevJob {
    return { id, request: { action, canvasId, blockIds: [block.id] }, state: 'completed',
      createdAt: at, updatedAt: at, sources: [source], proposalIds: [] };
  }
  function proposal(id = 'group-placement'): JevProposal {
    return { id, jobId: 'checked-file', action: 'file', title: 'Atlas group', explanation: 'Checked release passage',
      confidence: .88, decisionConfidences: [.93], createdAt: at, state: 'pending', sources: [source],
      evidence: [{ source, start: 0, end: 7, quote: '# Atlas' }],
      mutation: { kind: 'document', canvasId, blockId: block.id, patch: { group: 'custom:atlas/release' } } };
  }
  return { block, source, state, job, proposal };
}

it('returns six waiting actions without durable history and no group approval', () => {
  const { block, state } = fixture();
  const review = documentReview(state, owner, canvasId, block);
  expect(review).toMatchObject({ blockId: block.id, contentHash: block.contentHash, currentGroup: null, durable: false });
  expect(review.actions).toHaveLength(6);
  expect(review.actions.every(action => action.state === 'waiting' && action.scores.length === 0)).toBe(true);
  expect(review.grouping).toBeUndefined();
});

it('shows saved role and bounded valid scores while retaining no-change reasons', () => {
  const { block, state, job, source, proposal } = fixture();
  const profile = job('profile', 'profile-result');
  profile.result = { documents: { [block.id]: { role: 'release guide', roleConfidence: .78,
    keyPassageSelectionConfidence: 0, status: 'no_change' } }, status: 'no_change', reason: 'No supported rewrite' };
  const file = job();
  file.result = { documents: { [block.id]: { role: 42, roleConfidence: 1.2,
    keyPassageSelectionConfidence: Number.NaN } }, status: 'no_change', reason: 'Pinned by reviewer' };
  const checked = proposal(); checked.decisionConfidences = [.9, -1, Number.POSITIVE_INFINITY, .6];
  const staleOption = proposal('old-option'); staleOption.sources = [{ ...source, contentHash: 'old-hash' }];
  staleOption.decisionConfidences = [.99];
  file.proposalIds = [checked.id, staleOption.id]; state.jobs.push(profile, file); state.proposals.push(checked, staleOption);
  const review = documentReview(state, owner, canvasId, block);
  expect(review.actions.find(action => action.action === 'profile')).toMatchObject({ state: 'no_change',
    decisionId: profile.id, role: 'release guide', scores: [{ name: 'role', value: .78 }, { name: 'key passage', value: 0 }] });
  expect(review.actions.find(action => action.action === 'file')).toMatchObject({ state: 'no_change',
    decisionId: file.id, scores: [{ name: 'decision 1', value: .9 }, { name: 'decision 4', value: .6 }] });
  block.contentHash = 'new-content-hash';
  const stale = documentReview(state, owner, canvasId, block);
  expect(stale.actions.every(action => action.state === 'waiting' && action.scores.length === 0)).toBe(true);
  expect(stale.grouping).toBeUndefined();
  expect(source.contentHash).not.toBe(block.contentHash);
});

it('ignores malformed saved detail, reports a failed decision, and bounds named multi-option scores', () => {
  const { block, state, job, proposal } = fixture();
  const failed = job('file', 'failed-file');
  failed.state = 'failed'; failed.error = 'Offline model unavailable';
  failed.result = { documents: { [block.id]: [] } } as unknown as JevJob['result'];
  const first = proposal('first-option'); first.jobId = failed.id; first.decisionConfidences = undefined;
  const second = proposal('second-option'); second.jobId = failed.id;
  second.title = 'Second option'; second.decisionConfidences = [.6];
  failed.proposalIds = [first.id, second.id]; state.jobs.push(failed); state.proposals.push(first, second);
  const review = documentReview(state, owner, canvasId, block);
  expect(review.actions.find(action => action.action === 'file')).toMatchObject({ state: 'failed',
    decisionId: failed.id, scores: [{ name: 'Second option · decision 1', value: .6 }] });
  expect(review.actions.find(action => action.action === 'file')).not.toHaveProperty('role');
});

it('requires current local evidence before exposing a group for approval', () => {
  const { block, state, job, proposal } = fixture();
  state.jobs.push(job());
  const missing = proposal(); missing.evidence = []; state.proposals.push(missing);
  expect(documentReview(state, owner, canvasId, block).grouping).toBeUndefined();
  missing.evidence = [{ ...proposal().evidence[0], source: { ...proposal().evidence[0].source, contentHash: 'stale' } }];
  expect(documentReview(state, owner, canvasId, block).grouping).toBeUndefined();
  missing.evidence = proposal().evidence;
  expect(documentReview(state, owner, canvasId, block).grouping).toMatchObject({ canApprove: true,
    evidence: [{ quote: '# Atlas' }] });
  missing.decisionConfidences = undefined;
  expect(documentReview(state, owner, canvasId, block).grouping?.scores).toEqual([]);
});

it('selects pending evidence over newer history, includes only its checked group path, and honors permissions and holds', () => {
  const { block, state, job, proposal } = fixture();
  const placement = proposal(); state.jobs.push(job()); state.proposals.push(placement);
  const parent = { id: 'parent-group', kind: 'group' as const, name: 'Atlas', groupKey: 'custom:atlas',
    definition: 'Atlas documents', state: 'active' as const, version: 1, aliases: [], members: [] };
  state.proposals.push({ ...proposal('parent-definition'), mutation: { kind: 'vocabulary', operation: 'define', term: parent } });
  state.proposals.push({ ...proposal('unrelated-definition'), mutation: { kind: 'vocabulary', operation: 'define',
    term: { ...parent, id: 'other-group', groupKey: 'custom:unrelated' } } });
  state.proposals.push({ ...proposal('newer-applied'), createdAt: '2026-10-07T00:00:00.000Z', state: 'applied' });
  const review = documentReview(state, owner, canvasId, block);
  expect(review.grouping).toMatchObject({ proposalId: placement.id,
    proposalIds: ['parent-definition', placement.id], canApprove: true });
  expect(documentReview(state, { ...owner, kind: 'token' }, canvasId, block).grouping?.canApprove).toBe(true);
  expect(documentReview(state, { ...owner, access: 'read' }, canvasId, block).grouping?.canApprove).toBe(false);
  expect(documentReview(state, { ...owner, canApprove: false }, canvasId, block).grouping?.canApprove).toBe(false);
  placement.automaticHoldReason = 'Reviewer owns this group';
  expect(documentReview(state, owner, canvasId, block).grouping).toMatchObject({ status: 'held',
    reason: 'Reviewer owns this group', canApprove: false });
});

it('uses the current six-action plan and its in-flight saved decision without inventing a change', () => {
  const { block, source, state, job } = fixture();
  const root = job('profile', 'six-action-root') as DocumentJob;
  root.state = 'running';
  root.result = { documents: { [block.id]: { role: 'reference', roleConfidence: .7 } } };
  root.documentPlan = { version: 2, originalSources: [source], completedActions: ['profile'], claimPreparedAt: at,
    queueWaitMs: 0, activeJob: { ...job('file', 'six-action-root:file'), state: 'running',
      principal: owner, authorizationFingerprint: 'offline-owner', settingsKey: 'offline-policy', attempts: 1,
      result: { documents: { [block.id]: { role: 'release guide', roleConfidence: .83 } } } } };
  state.jobs.push(root);
  const review = documentReview(state, owner, canvasId, block);
  expect(review).toMatchObject({ jobId: root.id, durable: false });
  expect(review.actions.find(action => action.action === 'profile')).toMatchObject({ state: 'no_change',
    role: 'reference', scores: [{ name: 'role', value: .7 }] });
  expect(review.actions.find(action => action.action === 'file')).toMatchObject({ state: 'waiting',
    decisionId: 'six-action-root:file', role: 'release guide', scores: [{ name: 'role', value: .83 }] });
});

it('uses the newest matching durable plan and newest current fallback decision', () => {
  const { block, source, state, job } = fixture();
  const oldRoot = job('profile', 'old-plan') as DocumentJob;
  oldRoot.documentPlan = { version: 2, originalSources: [source], completedActions: ['profile'],
    claimPreparedAt: at, queueWaitMs: 0 };
  oldRoot.result = { documents: { [block.id]: { role: 'old role', roleConfidence: .2 } } };
  const newRoot = structuredClone(oldRoot);
  newRoot.id = 'new-plan'; newRoot.updatedAt = '2026-10-07T00:00:00.000Z';
  newRoot.result = { documents: { [block.id]: { role: 'new role', roleConfidence: .8 } } };
  const oldFile = job('file', 'old-file'); oldFile.result = { documents: { [block.id]: { roleConfidence: .3 } } };
  const newFile = job('file', 'new-file'); newFile.updatedAt = '2026-10-07T00:00:00.000Z';
  newFile.result = { documents: { [block.id]: { roleConfidence: .9 } } };
  state.jobs.push(oldRoot, newRoot, oldFile, newFile);
  const review = documentReview(state, owner, canvasId, block);
  expect(review.jobId).toBe('new-plan');
  expect(review.actions.find(action => action.action === 'profile')).toMatchObject({ decisionId: 'new-plan', role: 'new role',
    scores: [{ name: 'role', value: .8 }] });
  expect(review.actions.find(action => action.action === 'file')).toMatchObject({ decisionId: 'new-file',
    scores: [{ name: 'role', value: .9 }] });
});
