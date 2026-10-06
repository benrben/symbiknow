import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasTask } from '../../shared/types.js';
import type { JevAction, JevMutation, JevProposal, JevReceipt, JevWorkspaceState } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevWorkspaceFiles } from './workspace.js';
import { sourceSnapshot } from './stamps.js';
import type { JevEvaluationContext } from './actions/context.js';
import { automaticHoldReason } from './eligibility.js';
import { automaticTaskHold } from './auto-task-policy.js';
import { explicitAutomaticCommand, hasCheckedAutomaticOutcome } from './auto-outcomes.js';

let root: string; let state: JevWorkspaceState; let context: JevEvaluationContext; let proposal: JevProposal; let task: CanvasTask;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-auto-policy-'));
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Native policy' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Evidence' });
  const target = await store.createCanvas(workspace.id, { name: 'Authorized destination' });
  const block = await store.createBlock(canvas.id, { title: 'Release', content: '- [ ] Ship Atlas by 2026-10-20.' });
  task = await store.createTask(canvas.id, { title: 'Atlas', detail: 'Ship Atlas',
    acceptanceCriteria: [{ id: 'ship', text: 'Ship Atlas' }] }, 'Browser');
  const snapshot = sourceSnapshot(workspace.id, canvas.id, block);
  state = await new JevWorkspaceFiles(root).read(workspace.id); state.settings.externalProcessing = true;
  for (const action of Object.keys(state.settings.modes) as JevAction[]) state.settings.modes[action] = 'auto';
  context = { workspaceId: workspace.id, documents: [{ canvasId: canvas.id, block, snapshot }], canvases: [canvas, target],
    tasks: [{ canvasId: canvas.id, task }], vocabulary: [], settings: state.settings };
  proposal = { id: 'proposal', jobId: 'job', action: 'create_task_from_line', title: 'Extract source task', explanation: 'Exact source',
    state: 'pending', createdAt: new Date().toISOString(), confidence: 0.83, sources: [snapshot], evidence: [{ source: snapshot,
      start: 0, end: block.content.length, quote: block.content }], mutation: { kind: 'task_create', canvasId: canvas.id,
      task: { title: 'Ship Atlas by 2026-10-20.', detail: block.content, status: 'todo', blockIds: [block.id], dueDate: '2026-10-20' } } };
  state.jobs.push({ id: 'job', request: { action: proposal.action, canvasId: canvas.id }, state: 'completed',
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, sources: proposal.sources, proposalIds: [proposal.id], result: {} });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
/** Reconstruct saved legacy policy only to exercise historical proposal/provenance guards.
 * This in-memory fixture does not pass configuration or action admission. */
function historicalAutomaticPolicy(action: JevAction) { state.settings.modes[action] = 'auto'; }
function update(action: JevAction, patch: Partial<CanvasTask>) {
  proposal.action = action; state.jobs[0].request.action = action;
  proposal.mutation = { kind: 'task_update', canvasId: context.canvases[0].id, taskId: task.id,
    expectedUpdatedAt: task.updatedAt, expectedRevision: task.revision, patch };
  return proposal.mutation;
}
function receipt(after: JevMutation): JevReceipt {
  task.jevMutationId = 'receipt';
  return { id: 'receipt', proposalId: 'earlier', action: 'assign_owner', createdAt: proposal.createdAt,
    actor: 'owner', before: after, after, sourcesAfter: proposal.sources, state: 'applied', automatic: true };
}
it('holds task creation and retired completion or planning actions even when historical evidence is complete', () => {
  expect(automaticTaskHold(state, proposal, context)).toMatch(/task creation has no supported action/);
  update('create_task_from_line', { blockIds: [context.documents[0].block.id] });
  expect(automaticTaskHold(state, proposal, context)).toMatch(/fields do not match/);
  update('suggest_task_done', { status: 'done' });
  state.jobs[0].result = { tasks: [{ taskId: task.id, complete: true, criteria: [{ id: 'ship', text: 'Ship Atlas', status: 'supported' }] }] };
  expect(automaticTaskHold(state, proposal, context)).toMatch(/fields do not match/);
  expect(hasCheckedAutomaticOutcome(state, proposal)).toBe(false);
  update('prioritize', { priority: 'high', dependsOnTaskIds: ['prerequisite'] });
  state.jobs[0].result = { priorities: { [task.id]: 'high' }, dependencyFindings: [{ taskId: task.id, prerequisiteTaskId: 'prerequisite', status: 'supported' }] };
  expect(automaticTaskHold(state, proposal, context)).toMatch(/fields do not match/);
  expect(hasCheckedAutomaticOutcome(state, proposal)).toBe(false);
});
it('holds missing, old or unbound task updates and unsupported deletion', () => {
  const mutation = update('attach_doc_to_task', { blockIds: [context.documents[0].block.id] });
  expect(automaticTaskHold(state, proposal, context)).toBeUndefined();
  mutation.expectedRevision = undefined; expect(automaticTaskHold(state, proposal, context)).toMatch(/current task revision/);
  mutation.expectedRevision = task.revision; mutation.expectedUpdatedAt = 'old'; expect(automaticTaskHold(state, proposal, context)).toMatch(/current task revision/);
  mutation.expectedUpdatedAt = task.updatedAt; mutation.taskId = 'missing'; expect(automaticTaskHold(state, proposal, context)).toMatch(/current task revision/);
  proposal.mutation = { kind: 'task_delete', canvasId: context.canvases[0].id, taskId: task.id, expectedUpdatedAt: task.updatedAt };
  expect(automaticTaskHold(state, proposal, context)).toMatch(/supported removal/);
});
it('keeps additive attachments source bound and rejects unsupported task fields or responsibility assignments', () => {
  update('attach_doc_to_task', {}); expect(automaticTaskHold(state, proposal, context)).toMatch(/preserve existing/);
  task.blockIds = ['existing']; update('attach_doc_to_task', { blockIds: [] }); expect(automaticTaskHold(state, proposal, context)).toMatch(/preserve existing/);
  update('attach_doc_to_task', { blockIds: ['existing', 'other'] }); expect(automaticTaskHold(state, proposal, context)).toMatch(/reviewed source/);
  update('attach_doc_to_task', { title: 'Wrong field' }); expect(automaticTaskHold(state, proposal, context)).toMatch(/do not match/);
  update('file', {}); expect(automaticTaskHold(state, proposal, context)).toMatch(/do not match/);
  update('assign_owner', { assignee: 'unknown' }); expect(automaticTaskHold(state, proposal, context)).toMatch(/known person/);
  context.settings.people.push({ id: 'alice', name: 'Alice', role: 'Owner' });
  update('assign_owner', { reviewer: 'alice' }); expect(automaticTaskHold(state, proposal, context)).toBeUndefined();
  expect(automaticHoldReason(state, proposal, context)).toMatch(/configured for review/);
  historicalAutomaticPolicy('assign_owner');
  expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
  update('assign_owner', { reviewer: 'alice', assignee: 'alice' }); expect(automaticTaskHold(state, proposal, context)).toMatch(/one explicitly/);
});
it('requires exact current provenance before changing existing manual planning values', () => {
  task.assignee = 'alice'; context.settings.people.push({ id: 'bob', name: 'Bob', role: 'Owner' });
  update('assign_owner', { assignee: 'bob' }); expect(automaticTaskHold(state, proposal, context)).toMatch(/manually/);
  state.receipts = [receipt({ kind: 'derived', values: {} })]; expect(automaticTaskHold(state, proposal, context)).toMatch(/manually/);
  const current = receipt({ kind: 'task_create', canvasId: 'other', task: { id: task.id, title: task.title, detail: task.detail, assignee: 'alice' } });
  state.receipts = [current]; expect(automaticTaskHold(state, proposal, context)).toMatch(/manually/);
  if (current.after.kind === 'task_create') current.after.canvasId = context.canvases[0].id;
  expect(automaticTaskHold(state, proposal, context)).toBeUndefined();
  if (current.after.kind === 'task_create') current.after.task.assignee = 'untracked';
  expect(automaticTaskHold(state, proposal, context)).toMatch(/manually/);
  current.after = { kind: 'task_update', canvasId: context.canvases[0].id, taskId: 'other', expectedUpdatedAt: task.updatedAt, patch: { assignee: 'alice' } };
  expect(automaticTaskHold(state, proposal, context)).toMatch(/manually/);
  current.after.taskId = task.id; expect(automaticTaskHold(state, proposal, context)).toBeUndefined();
  current.after.patch = {}; expect(automaticTaskHold(state, proposal, context)).toMatch(/manually/);
  current.after.patch = { assignee: 'alice' }; current.automatic = false;
  expect(automaticTaskHold(state, proposal, context)).toMatch(/manually/);
  state.proposals.push({ ...proposal, id: 'earlier', reviewerEdited: true });
  expect(automaticTaskHold(state, proposal, context)).toMatch(/manually/);
  state.proposals[0].reviewerEdited = false; expect(automaticTaskHold(state, proposal, context)).toBeUndefined();
  update('assign_owner', { assignee: 'alice' }); expect(automaticTaskHold(state, proposal, context)).toMatch(/known person/);
  task.assignee = ''; update('assign_owner', { assignee: 'bob' }); expect(automaticTaskHold(state, proposal, context)).toBeUndefined();
});
function vocabulary(operation = 'define') {
  proposal.action = 'vocab_lifecycle'; delete proposal.confidence;
  proposal.mutation = { kind: 'vocabulary', operation, term: { id: 'atlas', kind: 'group', name: 'Atlas', definition: 'Atlas release',
    aliases: [], state: 'active', version: 1, groupKey: 'custom:atlas', members: [{ canvasId: context.canvases[0].id, blockId: context.documents[0].block.id }] } };
  return proposal.mutation;
}
it('does not activate a historical vocabulary proposal under the current six-action policy', () => {
  vocabulary(); proposal.confidence = 0.83;
  expect(state.settings.modes.vocab_lifecycle).toBeUndefined();
  expect(automaticHoldReason(state, proposal, context)).toMatch(/configured for review/);
});
it('preserves nomination, parent, source and manual-classification guards for historical lifecycle policy', () => {
  historicalAutomaticPolicy('vocab_lifecycle');
  const mutation = vocabulary(); state.jobs[0].result = { confidence: 0.83 };
  expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
  state.jobs[0].result = {}; expect(automaticHoldReason(state, proposal, context)).toMatch(/confidence/);
  proposal.confidence = 0.83; mutation.operation = 'remove'; expect(automaticHoldReason(state, proposal, context)).toMatch(/checked reference removal/);
  mutation.operation = 'rename'; mutation.term.parentId = 'missing'; expect(automaticHoldReason(state, proposal, context)).toMatch(/parent/);
  delete mutation.term.parentId; mutation.term.members = [{ canvasId: context.canvases[0].id, blockId: 'missing' }];
  expect(automaticHoldReason(state, proposal, context)).toMatch(/manual classification/);
  mutation.term.members = [{ canvasId: context.canvases[0].id, blockId: context.documents[0].block.id }];
  context.documents[0].block.jevOwnership!.pins.push('group'); expect(automaticHoldReason(state, proposal, context)).toMatch(/manual classification/);
  mutation.term.kind = 'entity'; delete mutation.term.groupKey; expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
  mutation.term.kind = 'label'; context.documents[0].block.jevOwnership!.pins.push('tags'); expect(automaticHoldReason(state, proposal, context)).toMatch(/manual classification/);
  context.documents[0].block.jevOwnership!.pins = []; expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
});
it('preserves merge support and explicit command checks for historical lifecycle policy', () => {
  historicalAutomaticPolicy('vocab_lifecycle');
  const mutation = vocabulary('merge'); state.jobs[0].request.options = { operation: 'merge' };
  state.jobs[0].result = { synonymySupported: false };
  expect(automaticHoldReason(state, proposal, context)).toMatch(/matching meanings/);
  state.jobs[0].result = { synonymySupported: true }; expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
  mutation.operation = 'retire'; expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
  state.jobs[0].request.options.operation = 'rename'; expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
  state.jobs[0].request.options.operation = 'nominate'; expect(explicitAutomaticCommand(state, proposal)).toBe(false);
  proposal.confidence = 0.83; mutation.operation = 'merge'; state.jobs[0].result = { synonymySupported: false };
  expect(automaticHoldReason(state, proposal, context)).toMatch(/matching meanings/);
});
it('keeps unsupported rechecks for attention, recognizes supported native groups, and restricts moves to an authorized target', () => {
  proposal.action = 'recheck_links'; delete proposal.confidence;
  expect(hasCheckedAutomaticOutcome(state, proposal)).toBe(false);
  state.jobs[0].result = { edges: [] }; expect(hasCheckedAutomaticOutcome(state, proposal)).toBe(true);
  const document = context.documents[0];
  proposal.action = 'file'; proposal.decisionConfidences = [0.67, 0.83];
  state.settings.confidenceThresholds = { file: 0.65, suggest_home_canvas: 0.65 };
  proposal.mutation = { kind: 'document', canvasId: document.canvasId, blockId: document.block.id, patch: { group: 'custom:existing' } };
  document.block.group = 'custom:existing'; expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
  proposal.action = 'suggest_home_canvas'; proposal.mutation = { kind: 'move', canvasId: document.canvasId, blockId: document.block.id, targetCanvasId: 'outside' };
  expect(automaticHoldReason(state, proposal, context)).toMatch(/authorized canvas/);
  proposal.mutation.targetCanvasId = document.canvasId; expect(automaticHoldReason(state, proposal, context)).toMatch(/different supported/);
  proposal.mutation.targetCanvasId = context.canvases[1].id; expect(automaticHoldReason(state, proposal, context)).toBeUndefined();
  proposal.action = 'file'; expect(automaticHoldReason(state, proposal, context)).toMatch(/home-canvas decision/);
});
