import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanvasTask } from '../../shared/types.js';
import type { JevAction, JevProposal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { automationPrincipal } from './authorization.js';
import { projectedOrganizationTask } from './followup-task-inputs.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

let native: QueueBoundaryFixture;
let manualTask: CanvasTask;
beforeEach(async () => {
  native = await queueBoundaryFixture();
  manualTask = await native.store.createTask(native.canvasId, { title: 'Release Atlas', detail: 'Ship checked rollout evidence.',
    blockIds: [], acceptanceCriteria: [{ id: 'release', text: 'Ship checked rollout evidence.' }] }, 'Browser');
});
afterEach(async () => { await native.close(); });

async function automaticTaskPatch(patch: Partial<CanvasTask>, action: JevAction = 'attach_doc_to_task') {
  const task = (await native.store.listTasks(native.canvasId)).find(item => item.id === manualTask.id)!;
  const document = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const source = sourceSnapshot(native.workspaceId, native.canvasId, document);
  const proposal: JevProposal = { id: randomUUID(), jobId: `automatic-${randomUUID()}`, action: 'file', title: 'Use declared rollout evidence',
    explanation: 'Exact declared task responsibility and source support.', state: 'pending', confidence: .99,
    createdAt: new Date().toISOString(), sources: [source],
    evidence: [{ source, start: 0, end: 7, quote: '# Atlas' }], mutation: { kind: 'task_update',
      canvasId: native.canvasId, taskId: task.id, expectedRevision: task.revision, expectedUpdatedAt: task.updatedAt, patch } };
  const state = await native.files.read(native.workspaceId); state.proposals.push(proposal);
  await native.files.write(native.workspaceId, state);
  // Reconstruct a durable historical receipt through the canonical writer before marking its retired origin.
  const receipt = await native.files.serial(native.workspaceId, () => native.executor.applyInside(native.workspaceId, proposal.id, automationPrincipal, true));
  const history = await native.files.read(native.workspaceId);
  history.receipts.find(item => item.id === receipt.id)!.action = action;
  history.proposals.find(item => item.id === proposal.id)!.action = action;
  await native.files.write(native.workspaceId, history);
  return { ...receipt, action };
}

async function projectedAfterReload() {
  const store = new CanvasStore(native.root); const files = new JevWorkspaceFiles(native.root);
  const current = (await store.listTasks(native.canvasId)).find(item => item.id === manualTask.id)!;
  const state = await files.read(native.workspaceId);
  const stateBefore = JSON.stringify(state); const taskBefore = JSON.stringify(current);
  return { current, state, stateBefore, taskBefore, projected: projectedOrganizationTask(current, native.canvasId, state) };
}

it('projects actual automatic attachment and owner receipts to the manual task input after durable reload', async () => {
  const manualSource = await native.store.createBlock(native.canvasId, { title: 'Manual prerequisite', content: '# Prerequisite\nA manual source.' });
  manualTask = await native.store.updateTask(native.canvasId, manualTask.id, { blockIds: [manualSource.id] }, 'Browser');
  const second = await native.store.createBlock(native.canvasId, { title: 'Release report', content: '# Release\nOwner: Alice. Ship checked rollout evidence.' });
  await automaticTaskPatch({ blockIds: [manualSource.id, native.primary.id] });
  await automaticTaskPatch({ assignee: 'alice' }, 'assign_owner');
  await automaticTaskPatch({ blockIds: [manualSource.id, native.primary.id, second.id] });
  const { current, state, stateBefore, taskBefore, projected } = await projectedAfterReload();
  expect(current).toMatchObject({ blockIds: [manualSource.id, native.primary.id, second.id], assignee: 'alice', revision: manualTask.revision! + 3 });
  expect(projected).toEqual(manualTask);
  expect(projected).not.toBe(current);
  expect(JSON.stringify(state)).toBe(stateBefore); expect(JSON.stringify(current)).toBe(taskBefore);
  expect((await new CanvasStore(native.root).listTasks(native.canvasId)).find(item => item.id === current.id)).toEqual(current);
});

const manualChanges: Record<string, () => Promise<CanvasTask>> = {
  'planning edit': () => native.store.updateTask(native.canvasId, manualTask.id,
    { title: 'Release revised Atlas scope', status: 'in_progress', priority: 'urgent' }, 'Browser'),
  'task comment': () => native.store.commentTask(native.canvasId, manualTask.id, 'Review rollback before shipping.', 'Browser'),
  'manual claim': () => native.store.claimTask(native.canvasId, manualTask.id, 'release-owner', true),
};

it.each(Object.entries(manualChanges))('keeps a %s as the new manual baseline before subsequent automatic work', async (_name, change) => {
  await automaticTaskPatch({ blockIds: [native.primary.id] });
  await automaticTaskPatch({ assignee: 'alice' }, 'assign_owner');
  const corrected = await change();
  const manualReadback = await projectedAfterReload();
  expect(manualReadback.current.jevMutationId).toBeUndefined(); expect(manualReadback.projected).toBe(manualReadback.current);
  expect(manualReadback.projected).toEqual(corrected);
  await automaticTaskPatch({ reviewer: 'release-reviewer' }, 'assign_owner');
  const checked = await projectedAfterReload();
  expect(checked.current.reviewer).toBe('release-reviewer'); expect(checked.projected).toEqual(corrected);
  expect(checked.projected.blockIds).toEqual([native.primary.id]);
  expect(checked.current.revision).toBe(corrected.revision! + 1);
});

it('preserves the actual checked Undo task snapshot as a manual barrier after restart', async () => {
  const receipt = await automaticTaskPatch({ assignee: 'alice' }, 'assign_owner');
  await native.files.serial(native.workspaceId, () => native.executor.undoInside(native.workspaceId, receipt.id, boundaryOwner));
  const { current, state, projected } = await projectedAfterReload();
  expect(current.assignee).toBeUndefined(); expect(current.revision).toBe(manualTask.revision! + 2);
  expect(state.receipts.find(item => item.id === receipt.id)?.state).toBe('undone');
  expect(projected).toBe(current);
});

it('projects only the exact target task while unrelated board changes stay literal', async () => {
  const unrelated = await native.store.createTask(native.canvasId, { title: 'Operations review', detail: 'Independent manual work.' }, 'Browser');
  await automaticTaskPatch({ blockIds: [native.primary.id] });
  const edited = await native.store.commentTask(native.canvasId, unrelated.id, 'Operations review remains independent.', 'Browser');
  const readback = await projectedAfterReload();
  expect(readback.projected).toEqual(manualTask);
  const board = await new CanvasStore(native.root).listTasks(native.canvasId);
  const currentUnrelated = board.find(item => item.id === unrelated.id)!;
  expect(projectedOrganizationTask(currentUnrelated, native.canvasId, readback.state)).toBe(currentUnrelated);
  expect(currentUnrelated).toEqual(edited);
  expect(board.find(item => item.id === manualTask.id)).toEqual(readback.current);
});
