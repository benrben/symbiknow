import type { CanvasBlock, CanvasTask } from '../shared/types.js';
import { claimedTask, commentedTask, newTask, patchedTask } from './coordination.js';
import { ApiError } from './errors.js';
import { checkBlockStateHashes } from './storage-state.js';
import { atomicJson } from './storage-files.js';
import type { StorageContext } from './storage-context.js';
import { mkdir, open, readFile, rm, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type TaskAuditEvent = { eventId?: string; kind: string; actor: string; at?: string; taskId?: string;
  before?: CanvasTask; after?: CanvasTask; task?: CanvasTask; deletedAt?: string; undoOf?: string };
type AuditRecord = { type: 'events'; events: TaskAuditEvent[] } | { type: 'void'; eventId: string };
type PendingTaskTransaction = { events: TaskAuditEvent[]; beforeHash: string; afterHash: string } |
  { events: TaskAuditEvent[]; before: CanvasTask[]; after: CanvasTask[] };
type TaskChangeAudit = { kind: 'created' | 'updated' | 'claimed' | 'commented' | 'deleted' | 'undone';
  actor: string; undoOf?: string };

function tasksHash(tasks: CanvasTask[]): string {
  return createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
}

async function appendAudit(file: string, record: AuditRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, 'a', 0o644);
  try {
    const initialSize = (await handle.stat()).size;
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    if (initialSize === 0) {
      const directory = await open(dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await handle.close(); }
}

/** A pending transaction permits discarding an interrupted final record. */
async function repairAuditTail(file: string): Promise<void> {
  let content: string;
  try { content = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!content || content.endsWith('\n')) return;
  const end = content.lastIndexOf('\n') + 1;
  await truncate(file, Buffer.byteLength(content.slice(0, end)));
  const handle = await open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function taskDependencies(task: CanvasTask | undefined): string[] {
  return task?.dependsOnTaskIds ?? [];
}

export function taskDependencyCycle(tasks: CanvasTask[]): boolean {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of taskDependencies(byId.get(id))) if (byId.has(next) && visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some(task => visit(task.id));
}

function checkSourceStates(value: unknown, blocks: CanvasBlock[]): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(409, 'A source document changed since this suggestion was reviewed');
  }
  checkBlockStateHashes(blocks, value as Record<string, unknown>, 'A source document changed since this suggestion was reviewed');
}

function checkReviewedTask(task: CanvasTask, input: Record<string, unknown>, blocks: CanvasBlock[]): void {
  if (input.expectedRevision !== undefined && input.expectedRevision !== (task.revision ?? 0)) {
    throw new ApiError(409, 'The task changed since this suggestion was reviewed');
  }
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== task.updatedAt) {
    throw new ApiError(409, 'The task changed since this suggestion was reviewed');
  }
  checkSourceStates(input.expectedSourceStateHashes, blocks);
}

function legacyAuditEvents(stored: TaskAuditEvent[], canvasId: string): TaskAuditEvent[] {
  if (!Array.isArray(stored)) throw new Error(`Invalid task audit history for ${canvasId}`);
  return stored.map((event, index) => event.eventId ? event : {
    ...event, eventId: `legacy-${index}`, taskId: event.taskId ?? event.task?.id,
    at: event.at ?? event.deletedAt, before: event.before ?? event.task,
  });
}

function auditRecord(line: string, canvasId: string): AuditRecord {
  const record = JSON.parse(line) as AuditRecord;
  if (record.type === 'events' && Array.isArray(record.events)) return record;
  if (record.type === 'void' && typeof record.eventId === 'string') return record;
  throw new Error(`Invalid task audit journal for ${canvasId}`);
}

function replayAuditJournal(journal: string, legacy: TaskAuditEvent[], canvasId: string): TaskAuditEvent[] {
  if (journal && !journal.endsWith('\n')) throw new Error(`Incomplete task audit journal for ${canvasId}`);
  const voided = new Set<string>();
  const events = [...legacy];
  for (const line of journal.split('\n')) {
    if (!line) continue;
    const record = auditRecord(line, canvasId);
    if (record.type === 'events') events.push(...record.events);
    else voided.add(record.eventId);
  }
  return events.filter(event => !event.eventId || !voided.has(event.eventId));
}

function pendingShape(value: unknown): value is PendingTaskTransaction {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as PendingTaskTransaction).events);
}

function pendingHasHashes(value: PendingTaskTransaction): boolean {
  return 'beforeHash' in value && typeof value.beforeHash === 'string' && typeof value.afterHash === 'string';
}

function pendingHasSnapshots(value: PendingTaskTransaction): boolean {
  return 'before' in value && Array.isArray(value.before) && Array.isArray(value.after);
}

function checkedPending(value: PendingTaskTransaction, canvasId: string): PendingTaskTransaction {
  if (!pendingShape(value) || (!pendingHasHashes(value) && !pendingHasSnapshots(value))) {
    throw new Error(`Invalid pending task transaction for ${canvasId}`);
  }
  return value;
}

function pendingTaskHashes(pending: PendingTaskTransaction): { before: string; after: string } {
  return { before: 'beforeHash' in pending ? pending.beforeHash : tasksHash(pending.before),
    after: 'afterHash' in pending ? pending.afterHash : tasksHash(pending.after) };
}

async function voidInterruptedEvents(file: string, pending: PendingTaskTransaction): Promise<void> {
  const ids = new Set(pending.events.map(event => event.eventId));
  for (const eventId of ids) if (eventId) await appendAudit(file, { type: 'void', eventId });
}

async function finishPendingAudit(file: string, canvasId: string, pending: PendingTaskTransaction,
  current: CanvasTask[], history: TaskAuditEvent[]): Promise<void> {
  const currentHash = tasksHash(current);
  const hashes = pendingTaskHashes(pending);
  if (currentHash === hashes.after) {
    const missing = pending.events.filter(event => !history.some(item => item.eventId === event.eventId && item.taskId === event.taskId));
    if (missing.length) await appendAudit(file, { type: 'events', events: missing });
    return;
  }
  if (currentHash !== hashes.before) throw new Error(`Task transaction for ${canvasId} needs manual recovery`);
  const ids = new Set(pending.events.map(event => event.eventId));
  if (history.some(event => ids.has(event.eventId))) await voidInterruptedEvents(file, pending);
}

function undoGroup(history: TaskAuditEvent[], taskId: string, eventId: string): TaskAuditEvent[] {
  const group = history.filter(event => event.eventId === eventId);
  if (!group.some(event => event.taskId === taskId)) throw new ApiError(404, 'Task history event not found');
  return group;
}

function checkUndoSources(group: TaskAuditEvent[], blocks: CanvasBlock[]): void {
  const activeBlockIds = new Set(blocks.filter(block => !block.archived).map(block => block.id));
  if (group.some(event => event.before?.blockIds.some(id => !activeBlockIds.has(id)))) {
    throw new ApiError(409, 'A task document moved or was removed after this history event');
  }
}

function checkUndoFreshness(group: TaskAuditEvent[], history: TaskAuditEvent[], current: Map<string, CanvasTask>,
  taskId: string, eventId: string, expectedRevision: number): void {
  const targetCurrent = current.get(taskId);
  const target = group.find(event => event.taskId === taskId)!;
  if ((targetCurrent?.revision ?? target.before?.revision ?? 0) !== expectedRevision) {
    throw new ApiError(409, 'The task changed since this history event was reviewed');
  }
  for (const event of group) {
    if (!eventStillCurrent(event, history, current, eventId)) {
      throw new ApiError(409, 'A task changed after this history event');
    }
  }
}

function eventStillCurrent(event: TaskAuditEvent, history: TaskAuditEvent[], current: Map<string, CanvasTask>, eventId: string): boolean {
  return Boolean(event.taskId) && [...history].reverse().find(item => item.taskId === event.taskId)?.eventId === eventId
    && JSON.stringify(current.get(event.taskId!)) === JSON.stringify(event.after);
}

function taskAuditKind(oldTask: CanvasTask | undefined, newTask: CanvasTask | undefined, kind: TaskChangeAudit['kind']): string {
  if (!oldTask) return 'created';
  if (!newTask) return 'deleted';
  return kind === 'deleted' ? 'updated' : kind;
}

function taskAuditEvent(id: string, oldTask: CanvasTask | undefined, newTask: CanvasTask | undefined,
  audit: TaskChangeAudit, eventId: string, at: string): TaskAuditEvent {
  const event: TaskAuditEvent = { eventId, kind: taskAuditKind(oldTask, newTask, audit.kind), actor: audit.actor, at, taskId: id };
  if (oldTask) event.before = oldTask;
  if (newTask) event.after = newTask;
  if (audit.undoOf) event.undoOf = audit.undoOf;
  if (!newTask && oldTask) { event.deletedAt = at; event.task = oldTask; }
  return event;
}

function reverseTaskEvents(group: TaskAuditEvent[], current: Map<string, CanvasTask>): Map<string, CanvasTask> {
  const updated = new Map(current);
  const now = new Date().toISOString();
  for (const event of group) {
    // checkUndoFreshness rejects events without task IDs before reaching this reversal.
    const taskId = event.taskId!;
    if (!event.before) { updated.delete(taskId); continue; }
    updated.set(taskId, { ...event.before,
      revision: (current.get(taskId)?.revision ?? event.before.revision ?? 0) + 1,
      updatedAt: now });
  }
  return updated;
}

function undoneTaskSnapshot(tasks: CanvasTask[], blocks: CanvasBlock[], history: TaskAuditEvent[],
  taskId: string, eventId: string, expectedRevision: number): { tasks: CanvasTask[]; result: CanvasTask | null } {
  const group = undoGroup(history, taskId, eventId);
  checkUndoSources(group, blocks);
  const current = new Map(tasks.map(task => [task.id, task]));
  checkUndoFreshness(group, history, current, taskId, eventId, expectedRevision);
  const updated = reverseTaskEvents(group, current);
  return { tasks: [...updated.values()], result: updated.get(taskId) ?? null };
}

export class StorageTasks {
  constructor(private readonly context: StorageContext) {}

  private auditFile(canvasId: string): string { return this.context.files.tasksFile(canvasId).replace(/\.json$/, '.audit.json'); }
  private auditLogFile(canvasId: string): string { return this.context.files.tasksFile(canvasId).replace(/\.json$/, '.audit.jsonl'); }
  private pendingFile(canvasId: string): string { return this.context.files.tasksFile(canvasId).replace(/\.json$/, '.pending.json'); }
  private async history(canvasId: string): Promise<TaskAuditEvent[]> {
    let legacy: TaskAuditEvent[] = [];
    try {
      const stored = await this.context.files.readJson<TaskAuditEvent[]>(this.auditFile(canvasId));
      legacy = legacyAuditEvents(stored, canvasId);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let journal: string;
    try { journal = await readFile(this.auditLogFile(canvasId), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return legacy;
      throw error;
    }
    return replayAuditJournal(journal, legacy, canvasId);
  }

  async listTaskHistory(canvasId: string, taskId?: string, limit = 25, cursor = 0) {
    return this.context.files.serialize(async () => {
      await this.context.getCanvasSummary(canvasId);
      const events = (await this.history(canvasId)).filter(event => !taskId || event.taskId === taskId).reverse();
      return { items: events.slice(cursor, cursor + limit),
        nextCursor: cursor + limit < events.length ? String(cursor + limit) : undefined };
    });
  }

  /** Complete or discard a task/audit pair after process interruption. */
  async recover(): Promise<void> {
    await this.context.files.serialize(async () => {
      for (const workspace of await this.context.listWorkspaces()) for (const canvas of workspace.canvases) {
        await this.recoverCanvas(canvas.id);
      }
    });
  }

  private async recoverCanvas(canvasId: string): Promise<void> {
    let pending: PendingTaskTransaction;
    try { pending = await this.context.files.readJson<PendingTaskTransaction>(this.pendingFile(canvasId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    checkedPending(pending, canvasId);
    await repairAuditTail(this.auditLogFile(canvasId));
    const current = await this.listTasks(canvasId);
    const history = await this.history(canvasId);
    await finishPendingAudit(this.auditLogFile(canvasId), canvasId, pending, current, history);
    await rm(this.pendingFile(canvasId), { force: true });
  }

  async listTasks(canvasId: string): Promise<CanvasTask[]> {
    await this.context.getCanvasSummary(canvasId);
    try { return await this.context.files.readJson<CanvasTask[]>(this.context.files.tasksFile(canvasId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async persistTaskChange(canvasId: string, previous: CanvasTask[], tasks: CanvasTask[],
    audit: TaskChangeAudit, workspaceId: string, notify = true): Promise<void> {
    if (tasks.length > 500) throw new ApiError(400, 'A canvas can hold at most 500 tasks');
    if (taskDependencyCycle(tasks)) throw new ApiError(400, 'Task dependencies cannot form a cycle');
    const before = new Map(previous.map(task => [task.id, task]));
    const after = new Map(tasks.map(task => [task.id, task]));
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(id =>
      JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)));
    const at = new Date().toISOString();
    const eventId = randomUUID();
    const events = changed.map(id => taskAuditEvent(id, before.get(id), after.get(id), audit, eventId, at));
    if (events.length) {
      await atomicJson(this.pendingFile(canvasId), { beforeHash: tasksHash(previous), afterHash: tasksHash(tasks), events });
      await appendAudit(this.auditLogFile(canvasId), { type: 'events', events });
    }
    await atomicJson(this.context.files.tasksFile(canvasId), tasks);
    if (events.length) await rm(this.pendingFile(canvasId), { force: true });
    if (notify) this.context.saved?.({ workspaceId, canvasId, blockIds: [], kind: 'tasks', actor: 'tasks' });
  }

  /** Commit a task snapshot inside an outer document, merge, or Jev transaction. */
  async writeTaskSnapshot(canvasId: string, before: CanvasTask[], after: CanvasTask[], actor: string): Promise<void> {
    await this.context.files.serialize(async () => {
      await this.recoverCanvas(canvasId);
      const current = await this.listTasks(canvasId);
      if (tasksHash(current) === tasksHash(after)) return;
      if (tasksHash(current) !== tasksHash(before)) throw new ApiError(409, 'Tasks changed during the transaction');
      const canvas = await this.context.getCanvasSummary(canvasId);
      try {
        await this.persistTaskChange(canvasId, current, after, { kind: 'updated', actor }, canvas.workspaceId, false);
      } catch (error) {
        try { await this.recoverCanvas(canvasId); }
        catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Task write and recovery both failed'); }
        throw error;
      }
    });
  }

  private async changeTasks<T>(canvasId: string, change: (tasks: CanvasTask[], known: Set<string>, blocks: CanvasBlock[], history: TaskAuditEvent[]) => { tasks: CanvasTask[]; result: T },
    audit: TaskChangeAudit): Promise<T> {
    return this.context.files.serialize(async () => {
      await this.recoverCanvas(canvasId);
      const canvas = await this.context.getCanvas(canvasId, true);
      const previous = await this.context.listTasks(canvasId);
      const history = audit.kind === 'undone' ? await this.history(canvasId) : [];
      const { tasks, result } = change(previous, new Set(canvas.blocks.map(block => block.id)), canvas.blocks, history);
      await this.persistTaskChange(canvasId, previous, tasks, audit, canvas.workspaceId);
      return result;
    });
  }

  private static taskIndex(tasks: CanvasTask[], taskId: string): number {
    const index = tasks.findIndex(task => task.id === taskId);
    if (index < 0) throw new ApiError(404, 'Task not found');
    return index;
  }

  async createTask(canvasId: string, input: Record<string, unknown>, actor: string): Promise<CanvasTask> {
    if (input.findingRef && (input.findingRef as { canvasId?: unknown }).canvasId !== canvasId) {
      throw new ApiError(400, 'findingRef must belong to this canvas');
    }
    return this.changeTasks(canvasId, (tasks, known) => {
      const task = newTask(input, actor, known, new Set(tasks.map(item => item.id)));
      return { tasks: [...tasks, task], result: task };
    }, { kind: 'created', actor });
  }

  private async replaceTask(canvasId: string, taskId: string, update: (task: CanvasTask, known: Set<string>, blocks: CanvasBlock[], knownTasks: Set<string>) => CanvasTask,
    audit: { kind: 'updated' | 'claimed' | 'commented'; actor: string }): Promise<CanvasTask> {
    return this.changeTasks(canvasId, (tasks, known, blocks) => {
      const index = StorageTasks.taskIndex(tasks, taskId);
      const task = update(tasks[index], known, blocks, new Set(tasks.map(item => item.id)));
      return { tasks: tasks.map((item, position) => position === index ? task : item), result: task };
    }, audit);
  }

  async updateTask(canvasId: string, taskId: string, input: Record<string, unknown>, actor: string): Promise<CanvasTask> {
    return this.replaceTask(canvasId, taskId, (task, known, blocks, knownTasks) => {
      checkReviewedTask(task, input, blocks);
      return patchedTask(task, input, actor, known, knownTasks);
    }, { kind: 'updated', actor });
  }

  async claimTask(canvasId: string, taskId: string, actor: string, force: boolean): Promise<CanvasTask> {
    return this.replaceTask(canvasId, taskId, task => claimedTask(task, actor, force), { kind: 'claimed', actor });
  }

  async commentTask(canvasId: string, taskId: string, text: unknown, actor: string): Promise<CanvasTask> {
    return this.replaceTask(canvasId, taskId, task => commentedTask(task, text, actor), { kind: 'commented', actor });
  }

  async deleteTask(canvasId: string, taskId: string, actor = 'api', expectedRevision?: number): Promise<void> {
    await this.changeTasks(canvasId, tasks => {
      const index = StorageTasks.taskIndex(tasks, taskId);
      const task = tasks[index];
      if (expectedRevision !== undefined && expectedRevision !== (task.revision ?? 0)) {
        throw new ApiError(409, 'The task changed since this suggestion was reviewed');
      }
      return { tasks: tasks.filter((_, position) => position !== index).map(task => {
        if (!task.dependsOnTaskIds?.includes(taskId)) return task;
        const updated = { ...task, dependsOnTaskIds: task.dependsOnTaskIds.filter(id => id !== taskId),
          revision: (task.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
        delete updated.jevMutationId;
        return updated;
      }), result: undefined };
    }, { kind: 'deleted', actor });
  }

  async undoTask(canvasId: string, taskId: string, eventId: string, expectedRevision: number, actor: string): Promise<CanvasTask | null> {
    return this.changeTasks(canvasId, (tasks, _known, blocks, history) =>
      undoneTaskSnapshot(tasks, blocks, history, taskId, eventId, expectedRevision),
    { kind: 'undone', actor, undoOf: eventId });
  }
}
