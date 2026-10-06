import type { CanvasTask } from '../shared/types.js';
import type { JevMutation } from '../shared/jev-types.js';
import type { StorageContext } from './storage-context.js';
import type { JevCanonicalPreparation } from './storage-jev-executor.js';
import { ApiError } from './errors.js';
import { validId } from './storage-shapes.js';
import { newTask, patchedTask } from './coordination.js';
import { taskDependencyCycle } from './storage-tasks.js';

type TaskMutation = Extract<JevMutation, { kind: 'task_create' | 'task_update' | 'task_delete' }>;
function taskMutation(mutation: JevMutation): mutation is TaskMutation {
  return ['task_create', 'task_update', 'task_delete'].includes(mutation.kind);
}
function taskVersion(task: CanvasTask, mutation: { expectedUpdatedAt: string; expectedRevision?: number }): void {
  if (task.updatedAt !== mutation.expectedUpdatedAt || (mutation.expectedRevision !== undefined && (task.revision ?? 0) !== mutation.expectedRevision)) {
    throw new ApiError(409, 'The task changed since Symbi Reflex reviewed it');
  }
}
function createdTask(mutation: Extract<TaskMutation, {kind: 'task_create'}>, id: string, actor: string,
  known: Set<string>, knownTasks: Set<string>, internalUndo: boolean): CanvasTask {
  const task = { ...newTask(mutation.task, actor, known, knownTasks), jevMutationId: id };
  if (mutation.task.id) {
    if (!validId(mutation.task.id) || knownTasks.has(mutation.task.id)) throw new ApiError(409, 'Task identity already exists');
    task.id = mutation.task.id;
  }
  if (internalUndo) Object.assign(task, { createdBy: mutation.task.createdBy, createdAt: mutation.task.createdAt,
    comments: mutation.task.comments, revision: (mutation.task.revision ?? 0) + 1 });
  return task;
}
function restoredPatch(mutation: Extract<TaskMutation, {kind: 'task_update'}>, internalUndo: boolean): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...mutation.patch };
  if (!internalUndo) return patch;
  if (patch.dependsOnTaskIds === null) patch.dependsOnTaskIds = [];
  if (patch.findingRef === null) delete patch.findingRef;
  return patch;
}
function updatedTask(task: CanvasTask, mutation: Extract<TaskMutation, {kind: 'task_update'}>, id: string,
  actor: string, known: Set<string>, knownTasks: Set<string>, internalUndo: boolean): CanvasTask {
  const updated = { ...patchedTask(task, restoredPatch(mutation, internalUndo), actor, known, knownTasks), jevMutationId: id };
  if (internalUndo && mutation.patch.dependsOnTaskIds === null) delete updated.dependsOnTaskIds;
  if (internalUndo && mutation.patch.findingRef === null) delete updated.findingRef;
  return updated;
}
function preparation(before: CanvasTask[], after: CanvasTask[], result: JevCanonicalPreparation, canvasId: string): JevCanonicalPreparation {
  if (after.length > 500 || taskDependencyCycle(after)) throw new ApiError(400, 'Task board limit or dependency cycle');
  return { ...result, artifacts: [{ kind: 'tasks', id: canvasId, before, after }] };
}
export class StorageJevTasks {
  constructor(private readonly context: StorageContext) {}

  private create(mutation: Extract<TaskMutation, {kind: 'task_create'}>, tasks: CanvasTask[], id: string, actor: string,
    known: Set<string>, knownTasks: Set<string>, internalUndo: boolean): JevCanonicalPreparation {
    const task = createdTask(mutation, id, actor, known, knownTasks, internalUndo);
    return preparation(tasks, [...tasks, task], {
      before: { kind: 'task_delete', canvasId: mutation.canvasId, taskId: task.id, expectedUpdatedAt: task.updatedAt, expectedRevision: task.revision },
      after: { ...mutation, task }, artifacts: [] }, mutation.canvasId);
  }

  private delete(mutation: Extract<TaskMutation, {kind: 'task_delete'}>, task: CanvasTask, tasks: CanvasTask[]): JevCanonicalPreparation {
    if (tasks.some(item => item.dependsOnTaskIds?.includes(task.id))) throw new ApiError(409, 'Other work now depends on this task');
    return preparation(tasks, tasks.filter(item => item.id !== task.id), {
      before: { kind: 'task_create', canvasId: mutation.canvasId, task }, after: mutation, artifacts: [] }, mutation.canvasId);
  }

  private update(mutation: Extract<TaskMutation, {kind: 'task_update'}>, task: CanvasTask, tasks: CanvasTask[], id: string, actor: string,
    known: Set<string>, knownTasks: Set<string>, internalUndo: boolean): JevCanonicalPreparation {
    const updated = updatedTask(task, mutation, id, actor, known, knownTasks, internalUndo);
    const before = { ...mutation, expectedUpdatedAt: updated.updatedAt, expectedRevision: updated.revision,
      patch: Object.fromEntries(Object.keys(mutation.patch).map(key => [key, task[key as keyof CanvasTask] ?? null])) };
    return preparation(tasks, tasks.map(item => item.id === task.id ? updated : item), { before, after: mutation, artifacts: [] }, mutation.canvasId);
  }

  async plan(mutation: JevMutation, id: string, actor: string, internalUndo: boolean): Promise<JevCanonicalPreparation> {
    if (!taskMutation(mutation)) throw new ApiError(400, 'Invalid task operation');
    const canvas = await this.context.getCanvas(mutation.canvasId, true);
    const tasks = await this.context.listTasks(canvas.id);
    const known = new Set(canvas.blocks.map(block => block.id));
    const knownTasks = new Set(tasks.map(task => task.id));
    if (mutation.kind === 'task_create') return this.create(mutation, tasks, id, actor, known, knownTasks, internalUndo);
    const task = tasks.find(item => item.id === mutation.taskId);
    if (!task) throw new ApiError(404, 'Task not found');
    taskVersion(task, mutation);
    if (mutation.kind === 'task_delete') return this.delete(mutation, task, tasks);
    return this.update(mutation, task, tasks, id, actor, known, knownTasks, internalUndo);
  }
}
