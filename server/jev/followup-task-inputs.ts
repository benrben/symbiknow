import { isDeepStrictEqual } from 'node:util';
import type { CanvasTask } from '../../shared/types.js';
import type { JevWorkspaceState } from '../../shared/jev-types.js';
import { automaticOrganizationReceipt } from './followup-receipt-origin.js';
import type { StoredJevReceipt } from './proposals.js';

type TaskReceipt = StoredJevReceipt & { after: Extract<StoredJevReceipt['after'], { kind: 'task_update' }> };

function taskReceipt(task: CanvasTask, state: JevWorkspaceState): TaskReceipt | undefined {
  const receipt = state.receipts.find(item => item.id === task.jevMutationId);
  return receipt?.state === 'applied' && receipt.after.kind === 'task_update' ? receipt as TaskReceipt : undefined;
}

function trustedReceipt(receipt: TaskReceipt, state: JevWorkspaceState): boolean {
  const original = state.proposals.find(proposal => proposal.id === receipt.proposalId);
  return automaticOrganizationReceipt(receipt, original);
}

function boundReceipt(receipt: TaskReceipt, task: CanvasTask, canvasId: string, state: JevWorkspaceState): boolean {
  return receipt.after.canvasId === canvasId && receipt.after.taskId === task.id && trustedReceipt(receipt, state);
}

function previousTask(receipt: TaskReceipt, task: CanvasTask, canvasId: string): CanvasTask | undefined {
  const artifact = receipt.preparedArtifacts?.find(item => item.kind === 'tasks' && item.id === canvasId);
  if (artifact?.kind !== 'tasks') return undefined;
  const after = artifact.after.find(item => item.id === task.id);
  if (!isDeepStrictEqual(after, task)) return undefined;
  return artifact.before.find(item => item.id === task.id);
}

function automaticPreviousTask(task: CanvasTask, canvasId: string, state: JevWorkspaceState): CanvasTask | undefined {
  const receipt = taskReceipt(task, state);
  if (!receipt || !boundReceipt(receipt, task, canvasId, state)) return undefined;
  return previousTask(receipt, task, canvasId);
}

/** Automatic audit revisions and assignments are outputs; a manual write ends their exact saved lineage. */
export function projectedOrganizationTask(task: CanvasTask, canvasId: string, state: JevWorkspaceState): CanvasTask {
  let current = task;
  const seen = new Set<string>();
  while (current.jevMutationId) {
    if (seen.has(current.jevMutationId)) return task;
    seen.add(current.jevMutationId);
    const before = automaticPreviousTask(current, canvasId, state);
    if (!before) break;
    current = before;
  }
  return current === task ? task : structuredClone(current);
}
