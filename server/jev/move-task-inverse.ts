import { isDeepStrictEqual } from 'node:util';
import type { CanvasTask } from '../../shared/types.js';
import type { JevArtifact } from '../storage-jev-executor.js';
import { ApiError } from '../errors.js';

type TaskArtifact = Extract<JevArtifact, { kind: 'tasks' }>;
interface TaskChange { id: string; before?: CanvasTask; after?: CanvasTask }

function taskChanges(artifact: TaskArtifact): TaskChange[] {
  const ids = new Set([...artifact.before, ...artifact.after].map(task => task.id));
  return [...ids].map(id => ({ id, before: artifact.before.find(task => task.id === id),
    after: artifact.after.find(task => task.id === id) }))
    .filter(change => !isDeepStrictEqual(change.before, change.after));
}

function checkDependencies(current: CanvasTask[], changes: TaskChange[]): void {
  const removed = new Set(changes.filter(change => !change.before).map(change => change.id));
  if (current.some(task => task.dependsOnTaskIds?.some(id => removed.has(id)))) {
    throw new ApiError(409, 'Other work now depends on a moved task; Undo is unavailable');
  }
}

/** Check only the identities changed by the receipt; unrelated work stays editable. */
export function checkTaskArtifactInverse(current: CanvasTask[], artifact: TaskArtifact): void {
  const changes = taskChanges(artifact);
  for (const change of changes) {
    if (!isDeepStrictEqual(current.find(task => task.id === change.id), change.after)) {
      throw new ApiError(409, 'Work changed after this action; Undo is unavailable');
    }
  }
  checkDependencies(current, changes);
}

function restoredTask(before: CanvasTask, previous: CanvasTask, id: string, actor: string): CanvasTask {
  return { ...before, updatedBy: actor, updatedAt: new Date(Math.max(Date.now(), Date.parse(previous.updatedAt) + 1)).toISOString(),
    revision: (previous.revision ?? 0) + 1, jevMutationId: id };
}

function restoredCurrent(task: CanvasTask, changes: Map<string, TaskChange>, id: string, actor: string): CanvasTask[] {
  const change = changes.get(task.id);
  if (!change) return [task];
  return change.before ? [restoredTask(change.before, task, id, actor)] : [];
}

function taskArtifact(artifacts: JevArtifact[] | undefined, canvasId: string): TaskArtifact {
  const artifact = artifacts?.find((item): item is TaskArtifact => item.kind === 'tasks' && item.id === canvasId);
  if (!artifact) throw new ApiError(409, 'Saved move work is incomplete; Undo is unavailable');
  return artifact;
}

function restoredMissing(current: CanvasTask[], changes: Map<string, TaskChange>, id: string, actor: string): CanvasTask[] {
  const missing: CanvasTask[] = [];
  for (const change of changes.values()) {
    if (change.before && !current.some(task => task.id === change.id)) missing.push(restoredTask(change.before, change.before, id, actor));
  }
  return missing;
}

/** Replay the logical inverse, keeping current audit clocks and unrelated board entries. */
export function restoredMoveTaskArtifact(current: CanvasTask[], artifacts: JevArtifact[] | undefined,
  canvasId: string, id: string, actor: string): TaskArtifact {
  const artifact = taskArtifact(artifacts, canvasId);
  checkTaskArtifactInverse(current, artifact);
  const changes = new Map(taskChanges(artifact).map(change => [change.id, change]));
  const after = current.flatMap(task => restoredCurrent(task, changes, id, actor));
  after.push(...restoredMissing(current, changes, id, actor));
  if (after.length > 500) throw new ApiError(409, 'Task board limit prevents this Undo');
  return { kind: 'tasks', id: canvasId, before: current, after };
}
