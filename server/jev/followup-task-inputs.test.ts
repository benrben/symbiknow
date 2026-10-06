import { expect, it } from 'vitest';
import type { CanvasTask } from '../../shared/types.js';
import type { JevProposal } from '../../shared/jev-types.js';
import type { JevArtifact } from '../storage-jev-executor.js';
import { projectedOrganizationTask } from './followup-task-inputs.js';
import type { StoredJevReceipt } from './proposals.js';
import { emptyJevWorkspace } from './workspace.js';

const canvasId = 'delivery-canvas';
function fixture() {
  const before: CanvasTask = { id: 'release-task', title: 'Release Atlas', detail: 'Ship checked rollout evidence.', status: 'todo',
    blockIds: ['manual-block'], revision: 1, createdBy: 'Browser', updatedBy: 'Browser',
    createdAt: '2026-10-04T10:00:00Z', updatedAt: '2026-10-04T10:00:00Z', comments: [] };
  const after: CanvasTask = { ...before, blockIds: ['manual-block', 'source-block'], revision: 2,
    updatedBy: 'jev-workspace-automation', updatedAt: '2026-10-04T10:01:00Z', jevMutationId: 'receipt' };
  const source = { workspaceId: 'workspace', canvasId, blockId: 'source-block', incarnation: 'source-incarnation',
    sourceGeneration: 1, metadataRevision: 1, contentHash: 'abcdef' };
  const proposal: JevProposal = { id: 'proposal', jobId: 'automatic-source', action: 'attach_doc_to_task',
    title: 'Attach rollout evidence', explanation: 'The source supports declared task work.', createdAt: after.updatedAt,
    sources: [source], evidence: [{ source, start: 0, end: 7, quote: '# Atlas' }], state: 'applied', mutation: {
      kind: 'task_update', canvasId, taskId: before.id, expectedRevision: 1, expectedUpdatedAt: before.updatedAt,
      patch: { blockIds: after.blockIds } } };
  const artifact: Extract<JevArtifact, { kind: 'tasks' }> = { kind: 'tasks', id: canvasId,
    before: [structuredClone(before)], after: [structuredClone(after)] };
  const receipt: StoredJevReceipt = { id: 'receipt', proposalId: proposal.id, action: proposal.action,
    actor: 'jev-workspace-automation', createdAt: after.updatedAt, automatic: true, state: 'applied', sourcesAfter: [source],
    before: { kind: 'task_update', canvasId, taskId: before.id, expectedRevision: 2, expectedUpdatedAt: after.updatedAt,
      patch: { blockIds: before.blockIds } }, after: proposal.mutation, preparedArtifacts: [artifact] };
  const state = emptyJevWorkspace(); state.proposals.push(proposal); state.receipts.push(receipt);
  return { before, after, source, proposal, artifact, receipt, state };
}

it('preserves tasks without a current marker and does not use old receipt values as ownership', () => {
  const value = fixture();
  expect(projectedOrganizationTask(value.before, canvasId, value.state)).toBe(value.before);
});

const barriers: Record<string, (value: ReturnType<typeof fixture>) => void> = {
  'missing receipt': value => { value.state.receipts = []; },
  'undone receipt': value => { value.receipt.state = 'undone'; },
  'non-task receipt': value => { value.receipt.after = { kind: 'derived', values: {} }; },
  'new task identity': value => { value.receipt.after = { kind: 'task_create', canvasId, task: value.after }; },
  'other canvas': value => { if (value.receipt.after.kind === 'task_update') value.receipt.after.canvasId = 'other-canvas'; },
  'other task': value => { if (value.receipt.after.kind === 'task_update') value.receipt.after.taskId = 'other-task'; },
  'reviewer edit': value => { value.proposal.reviewerEdited = true; },
  'checked Undo': value => { value.proposal.jobId = 'undo:receipt'; },
  'manual override': value => { value.proposal.jobId = 'override:receipt'; },
  'ordinary manual approval': value => { value.receipt.automatic = false; value.proposal.evidence = []; },
  'missing manual origin': value => { value.receipt.automatic = false; value.state.proposals = []; },
  'missing artifacts': value => { delete value.receipt.preparedArtifacts; },
  'unrelated artifact': value => { value.receipt.preparedArtifacts = [{ kind: 'content', id: 'source', file: 'source.md', before: '# Before', after: '# After' }]; },
  'other board proof': value => { value.artifact.id = 'other-canvas'; },
  'missing after task': value => { value.artifact.after = []; },
  'changed after task': value => { value.artifact.after[0].comments = [{ author: 'Browser', text: 'Review this release.', createdAt: value.after.updatedAt }]; },
  'missing before task': value => { value.artifact.before = []; },
};
it.each(Object.entries(barriers))('keeps current task inputs at a %s barrier', (_name, change) => {
  const value = fixture(); change(value);
  expect(projectedOrganizationTask(value.after, canvasId, value.state)).toBe(value.after);
});

it('accepts a trusted unedited approved origin with exact proof and returns an independent value', () => {
  const value = fixture(); value.receipt.automatic = false;
  const projected = projectedOrganizationTask(value.after, canvasId, value.state);
  expect(projected).toEqual(value.before); expect(projected).not.toBe(value.artifact.before[0]);
  projected.blockIds.push('caller-change'); projected.comments.push({ author: 'Caller', text: 'Local only.', createdAt: projected.updatedAt });
  expect(value.artifact.before[0]).toEqual(value.before);
  expect(value.after.blockIds).toEqual(['manual-block', 'source-block']);
});

it('uses an exact automatic receipt even when its historical proposal has been pruned', () => {
  const value = fixture(); value.state.proposals = [];
  expect(projectedOrganizationTask(value.after, canvasId, value.state)).toEqual(value.before);
});

it('stops at the literal before snapshot if an older lineage marker no longer has proof', () => {
  const value = fixture(); value.artifact.before[0].jevMutationId = 'older-missing';
  expect(projectedOrganizationTask(value.after, canvasId, value.state)).toEqual(value.artifact.before[0]);
});

it('rejects cyclic artifact lineage instead of inventing a task baseline', () => {
  const value = fixture(); const older = { ...value.before, jevMutationId: 'older' };
  value.artifact.before = [older];
  const cyclic: StoredJevReceipt = { ...value.receipt, id: 'older', preparedArtifacts: [{ kind: 'tasks', id: canvasId,
    after: [structuredClone(older)], before: [structuredClone(value.after)] }] };
  value.state.receipts.push(cyclic);
  expect(projectedOrganizationTask(value.after, canvasId, value.state)).toBe(value.after);
});
