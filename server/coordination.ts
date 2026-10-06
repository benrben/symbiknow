import { randomUUID } from 'node:crypto';
import type { CanvasTask, DocumentLock } from '../shared/types.js';
import { ApiError } from './errors.js';
import { assignee, blockIds, status, taskDependencies, taskDueDate, text } from './coordination-values.js';
import { findingRef } from './coordination-evidence.js';
import { taskJevFields } from './storage-jev-fields.js';

function newTaskLabels(input: Record<string, unknown>) {
  return { detail: input.detail === undefined ? '' : text(input.detail, 'detail', 4000),
    status: input.status === undefined ? 'todo' : status(input.status),
    ...(input.boardOrder === undefined ? {} : { boardOrder: boardOrder(input.boardOrder) }),
    ...(input.assignee === undefined ? {} : { assignee: assignee(input.assignee) }) };
}
function boardOrder(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(400, 'boardOrder must be a finite number');
  }
  return value;
}
function newTaskPlanning(input: Record<string, unknown>, dueDate: string | undefined, knownTasks: Set<string>) {
  return { ...(dueDate ? { dueDate } : {}),
    ...(input.dependsOnTaskIds === undefined ? {} : { dependsOnTaskIds: taskDependencies(input.dependsOnTaskIds, knownTasks) }) };
}
function taskPatchFields(task: CanvasTask, input: Record<string, unknown>, known: Set<string>, knownTasks: Set<string>) {
  return {
    title: input.title === undefined ? task.title : text(input.title, 'title', 160, true),
    detail: input.detail === undefined ? task.detail : text(input.detail, 'detail', 4000),
    status: input.status === undefined ? task.status : status(input.status),
    boardOrder: input.boardOrder === undefined ? task.boardOrder : boardOrder(input.boardOrder),
    blockIds: input.blockIds === undefined ? task.blockIds.filter(id => known.has(id)) : blockIds(input.blockIds, known),
    dependsOnTaskIds: input.dependsOnTaskIds === undefined ? task.dependsOnTaskIds
      : taskDependencies(input.dependsOnTaskIds, knownTasks, task.id),
  };
}
function patchAssignee(task: CanvasTask, value: unknown) {
  if (value === undefined) return;
  const name = assignee(value);
  if (name) task.assignee = name; else delete task.assignee;
}
function patchDueDate(task: CanvasTask, value: unknown) {
  if (value === undefined) return;
  const date = taskDueDate(value);
  if (date) task.dueDate = date; else delete task.dueDate;
}
function checkLeaseOwner(current: DocumentLock | undefined, owner: string, force: unknown) {
  if (current && current.owner !== owner && force !== true) {
    throw new ApiError(409, `${current.owner} is editing this document until ${current.expiresAt}. Pass force to take it over.`);
  }
}
function leaseDuration(value: unknown) {
  const ttl = value === undefined ? 600 : Number(value);
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 3600) throw new ApiError(400, 'ttlSeconds must be between 30 and 3600');
  return ttl;
}

export function newTask(input: Record<string, unknown>, actor: string, known: Set<string>, knownTasks: Set<string> = new Set()): CanvasTask {
  const now = new Date().toISOString();
  const dueDate = taskDueDate(input.dueDate);
  return taskJevFields({
    id: randomUUID(), title: text(input.title, 'title', 160, true), ...newTaskLabels(input),
    ...newTaskPlanning(input, dueDate, knownTasks),
    blockIds: input.blockIds === undefined ? [] : blockIds(input.blockIds, known),
    ...(input.findingRef === undefined ? {} : { findingRef: findingRef(input.findingRef, known) }),
    createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now, comments: [], revision: 1,
  }, input);
}

export function patchedTask(task: CanvasTask, input: Record<string, unknown>, actor: string, known: Set<string>, knownTasks: Set<string> = new Set()): CanvasTask {
  const next: CanvasTask = {
    ...task,
    ...taskPatchFields(task, input, known, knownTasks),
    updatedBy: actor, updatedAt: new Date().toISOString(), revision: (task.revision ?? 0) + 1,
  };
  patchAssignee(next, input.assignee);
  patchDueDate(next, input.dueDate);
  if (input.findingRef !== undefined) next.findingRef = findingRef(input.findingRef, known);
  delete next.jevMutationId;
  return taskJevFields(next, input);
}

/** Claiming assigns a task to the caller. Another agent's active claim needs `force`. */
function checkTaskClaim(task: CanvasTask, actor: string, force: boolean): void {
  if (task.assignee && task.assignee !== actor && task.status !== 'done' && !force) {
    throw new ApiError(409, `${task.assignee} already claimed this task. Pass force to take it over.`);
  }
}
export function claimedTask(task: CanvasTask, actor: string, force: boolean): CanvasTask {
  checkTaskClaim(task, actor, force);
  const next = { ...task, assignee: actor, status: task.status === 'done' ? 'done' as const : 'in_progress' as const,
    updatedBy: actor, updatedAt: new Date().toISOString(), revision: (task.revision ?? 0) + 1 };
  delete next.jevMutationId;
  return next;
}

export function commentedTask(task: CanvasTask, value: unknown, actor: string): CanvasTask {
  const now = new Date().toISOString();
  const comments = [...task.comments, { author: actor, text: text(value, 'text', 2000, true), createdAt: now }].slice(-100);
  const next = { ...task, comments, updatedBy: actor, updatedAt: now, revision: (task.revision ?? 0) + 1 };
  delete next.jevMutationId;
  return next;
}

/** In-memory document leases. They expire on their own, so a crashed agent cannot hold a file forever. */
export class DocumentLocks {
  private readonly locks = new Map<string, DocumentLock>();

  private key(canvasId: string, blockId: string): string { return `${canvasId}/${blockId}`; }

  active(canvasId: string, blockId: string): DocumentLock | undefined {
    const key = this.key(canvasId, blockId);
    const lock = this.locks.get(key);
    if (lock && Date.parse(lock.expiresAt) <= Date.now()) {
      this.locks.delete(key);
      return undefined;
    }
    return lock;
  }

  acquire(canvasId: string, blockId: string, owner: string, input: Record<string, unknown>): DocumentLock {
    const current = this.active(canvasId, blockId);
    checkLeaseOwner(current, owner, input.force);
    const ttl = leaseDuration(input.ttlSeconds);
    const lock: DocumentLock = { owner, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      ...(input.note === undefined ? {} : { note: text(input.note, 'note', 200) }) };
    this.locks.set(this.key(canvasId, blockId), lock);
    return lock;
  }

  release(canvasId: string, blockId: string, owner: string, force: boolean): void {
    const current = this.active(canvasId, blockId);
    if (!current) return;
    if (current.owner !== owner && !force) throw new ApiError(409, `${current.owner} holds this document. Pass force to release it.`);
    this.locks.delete(this.key(canvasId, blockId));
  }

  /** Throws when another owner holds the document. */
  check(canvasId: string, blockId: string, actor: string): void {
    const current = this.active(canvasId, blockId);
    if (current && current.owner !== actor) {
      throw new ApiError(423, `${current.owner} is editing this document until ${current.expiresAt}. Wait, or take over the lock first.`);
    }
  }

  forget(canvasId: string, blockId: string): void { this.locks.delete(this.key(canvasId, blockId)); }

  move(fromCanvasId: string, toCanvasId: string, blockId: string): void {
    const lock = this.active(fromCanvasId, blockId);
    this.forget(fromCanvasId, blockId);
    if (lock) this.locks.set(this.key(toCanvasId, blockId), lock);
  }
}
