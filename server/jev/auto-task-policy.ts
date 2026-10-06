import type { CanvasTask } from '../../shared/types.js';
import type { JevMutation, JevProposal, JevReceipt, JevWorkspaceState } from '../../shared/jev-types.js';
import type { JevEvaluationContext } from './actions/context.js';
import { trustedManagedOrigin } from './approval-origin.js';

type TaskCreate = Extract<JevMutation, { kind: 'task_create' }>;
type TaskUpdate = Extract<JevMutation, { kind: 'task_update' }>;
function reviewedBlocks(proposal: JevProposal, canvasId: string, blockIds: string[]): boolean {
  return blockIds.every(id => proposal.sources.some(source => source.canvasId === canvasId && source.blockId === id));
}
function managedTaskField(state: JevWorkspaceState, task: CanvasTask, canvasId: string, field: string): boolean {
  const receipt = taskFieldReceipt(state, task);
  if (!receipt) return false;
  const mutation = receipt.after;
  if (mutation.kind !== 'task_create' && mutation.kind !== 'task_update') return false;
  if (!sameTask(mutation, task, canvasId)) return false;
  const fields = mutation.kind === 'task_create' ? mutation.task : mutation.patch;
  return sameField(fields, task, field);
}
function taskFieldReceipt(state: JevWorkspaceState, task: CanvasTask): JevReceipt | undefined {
  const receipt = state.receipts.find(item => item.id === task.jevMutationId && item.state === 'applied');
  if (!receipt) return undefined;
  return trustedTaskReceipt(state, receipt) ? receipt : undefined;
}
function trustedTaskReceipt(state: JevWorkspaceState, receipt: JevReceipt): boolean {
  const source = state.proposals.find(item => item.id === receipt.proposalId);
  if (source?.reviewerEdited) return false;
  return receipt.automatic === true || Boolean(source && trustedManagedOrigin(source));
}
function sameField(fields: Partial<CanvasTask>, task: CanvasTask, field: string): boolean {
  return Object.hasOwn(fields, field) && JSON.stringify(fields[field as keyof CanvasTask]) === JSON.stringify(task[field as keyof CanvasTask]);
}
function sameTask(mutation: TaskCreate | TaskUpdate, task: CanvasTask, canvasId: string): boolean {
  const id = mutation.kind === 'task_create' ? mutation.task.id : mutation.taskId;
  return mutation.canvasId === canvasId && id === task.id;
}
function manualAssignment(state: JevWorkspaceState, task: CanvasTask, mutation: TaskUpdate): boolean {
  return ['assignee', 'reviewer'].some(field => {
    if (!Object.hasOwn(mutation.patch, field)) return false;
    const current = task[field as 'assignee' | 'reviewer'];
    return Boolean(current) && current !== mutation.patch[field as 'assignee' | 'reviewer']
      && !managedTaskField(state, task, mutation.canvasId, field);
  });
}
function attachment(proposal: JevProposal, task: CanvasTask, mutation: TaskUpdate): string | undefined {
  const ids = mutation.patch.blockIds;
  if (!ids || task.blockIds.some(id => !ids.includes(id))) return 'Task attachments must preserve existing source references';
  const added = ids.filter(id => !task.blockIds.includes(id));
  return reviewedBlocks(proposal, mutation.canvasId, added) ? undefined : 'Each new task attachment requires its reviewed source';
}
function assignment(context: JevEvaluationContext, mutation: TaskUpdate): string | undefined {
  if (Object.keys(mutation.patch).length !== 1) return 'Assignment requires one explicitly supported responsibility';
  const person = mutation.patch.assignee ?? mutation.patch.reviewer;
  return context.settings.people.some(item => item.id === person) ? undefined : 'Assignment requires an explicitly supported known person';
}
function updateFields(proposal: JevProposal, task: CanvasTask, mutation: TaskUpdate, context: JevEvaluationContext): string | undefined {
  const fields = Object.keys(mutation.patch);
  const allowed: Record<string, string[]> = { attach_doc_to_task: ['blockIds'], assign_owner: ['assignee', 'reviewer'] };
  if (!allowed[proposal.action] || fields.some(field => !allowed[proposal.action].includes(field))) return 'Task fields do not match the supported action';
  if (proposal.action === 'assign_owner') return assignment(context, mutation);
  return attachment(proposal, task, mutation);
}
function currentRevision(task: CanvasTask, mutation: TaskUpdate): boolean {
  return Number.isSafeInteger(mutation.expectedRevision) && mutation.expectedRevision! > 0
    && mutation.expectedRevision === task.revision && mutation.expectedUpdatedAt === task.updatedAt;
}
export function automaticTaskHold(state: JevWorkspaceState, proposal: JevProposal, context: JevEvaluationContext): string | undefined {
  const mutation = proposal.mutation;
  if (mutation.kind === 'task_create') return 'Automatic task creation has no supported action';
  if (mutation.kind !== 'task_update') return 'Automatic task deletion has no supported removal decision';
  const task = context.tasks.find(item => item.canvasId === mutation.canvasId && item.task.id === mutation.taskId)?.task;
  if (!task || !currentRevision(task, mutation)) return 'A current task revision is required';
  if (manualAssignment(state, task, mutation)) return 'An existing task planning field was set manually';
  return updateFields(proposal, task, mutation, context);
}
