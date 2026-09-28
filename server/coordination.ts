import { randomUUID } from 'node:crypto';
import type { CanvasTask, DocumentLock, TaskStatus } from '../shared/types.js';
import { cleanActor } from './auth.js';
import { ApiError } from './errors.js';

const statuses: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];

function text(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new ApiError(400, `${field} must be ${required ? 'a nonempty' : 'a'} string of at most ${max} characters`);
  }
  return value.trim();
}

function status(value: unknown): TaskStatus {
  if (!statuses.includes(value as TaskStatus)) throw new ApiError(400, 'status must be todo, in_progress, blocked, or done');
  return value as TaskStatus;
}

function blockIds(value: unknown, known: Set<string>): string[] {
  if (!Array.isArray(value) || value.length > 20 || !value.every(id => typeof id === 'string' && known.has(id))) {
    throw new ApiError(400, 'blockIds must list up to 20 documents on this canvas');
  }
  return [...new Set(value as string[])];
}

function assignee(value: unknown): string | undefined {
  if (value === null || value === '') return undefined;
  const name = cleanActor(value);
  if (!name) throw new ApiError(400, 'assignee must be a short name');
  return name;
}

function findingRef(value: unknown, known: Set<string>): CanvasTask['findingRef'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'findingRef must identify a finding');
  const entry = value as Record<string, unknown>;
  const evidence = entry.evidence === undefined ? undefined : findingEvidence(entry.evidence, known);
  const references = entry.references === undefined ? undefined : evidenceReferences(entry.references, known);
  const suggestedOwner = entry.suggestedOwner === undefined ? undefined : assignee(entry.suggestedOwner);
  return { id: text(entry.id, 'findingRef.id', 160, true), title: text(entry.title, 'findingRef.title', 200, true),
    canvasId: text(entry.canvasId, 'findingRef.canvasId', 160, true),
    blockIds: blockIds(entry.blockIds, known),
    ...(entry.detail === undefined ? {} : { detail: text(entry.detail, 'findingRef.detail', 4000) }),
    ...(evidence ? { evidence } : {}), ...(references ? { references } : {}),
    ...(suggestedOwner ? { suggestedOwner } : {}),
    ...(entry.investigationId === undefined ? {} : { investigationId: text(entry.investigationId, 'findingRef.investigationId', 160, true) }),
  };
}

function findingEvidence(value: unknown, known: Set<string>): NonNullable<CanvasTask['findingRef']>['evidence'] {
  if (!Array.isArray(value) || value.length > 12) throw new ApiError(400, 'findingRef.evidence must contain up to 12 evidence items');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError(400, `findingRef.evidence[${index}] must be an object`);
    const entry = item as Record<string, unknown>;
    const sourceIds = entry.sourceIds === undefined ? undefined : blockIds(entry.sourceIds, known);
    let sourceHashes: Record<string, string> | undefined;
    if (entry.sourceHashes !== undefined) {
      if (!entry.sourceHashes || typeof entry.sourceHashes !== 'object' || Array.isArray(entry.sourceHashes)) throw new ApiError(400, 'findingRef evidence sourceHashes must be an object');
      const pairs = Object.entries(entry.sourceHashes as Record<string, unknown>);
      if (pairs.length > 20 || pairs.some(([id, hash]) => !known.has(id) || typeof hash !== 'string' || hash.length > 128)) {
        throw new ApiError(400, 'findingRef evidence sourceHashes must reference documents on this canvas');
      }
      sourceHashes = Object.fromEntries(pairs as [string, string][]);
    }
    return { questionId: text(entry.questionId, `findingRef.evidence[${index}].questionId`, 160, true),
      answer: text(entry.answer, `findingRef.evidence[${index}].answer`, 2000),
      excerpt: text(entry.excerpt, `findingRef.evidence[${index}].excerpt`, 2000),
      ...(sourceIds ? { sourceIds } : {}), ...(sourceHashes ? { sourceHashes } : {}) };
  });
}

function evidenceReferences(value: unknown, known: Set<string>): NonNullable<CanvasTask['findingRef']>['references'] {
  if (!Array.isArray(value) || value.length > 12) throw new ApiError(400, 'findingRef.references must contain up to 12 references');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError(400, `findingRef.references[${index}] must be an object`);
    const entry = item as Record<string, unknown>;
    const navigation = entry.navigation as Record<string, unknown> | null;
    if (!navigation || typeof navigation !== 'object' || navigation.kind !== 'document' || !known.has(String(navigation.blockId ?? ''))) {
      throw new ApiError(400, 'findingRef evidence navigation must target a document on this canvas');
    }
    const canvasId = text(entry.canvasId, `findingRef.references[${index}].canvasId`, 160, true);
    const documentId = text(entry.documentId, `findingRef.references[${index}].documentId`, 160, true);
    if (!known.has(documentId) || navigation.blockId !== documentId || navigation.canvasId !== canvasId) {
      throw new ApiError(400, 'findingRef evidence navigation must match its document');
    }
    const passageKind = entry.passageKind;
    if (passageKind !== 'exact' && passageKind !== 'approximation') throw new ApiError(400, 'findingRef evidence passageKind must be exact or approximation');
    const checkedAt = text(entry.checkedAt, `findingRef.references[${index}].checkedAt`, 64, true);
    if (!Number.isFinite(Date.parse(checkedAt))) throw new ApiError(400, 'findingRef evidence checkedAt must be a date');
    return { claim: text(entry.claim, `findingRef.references[${index}].claim`, 2000, true),
      passage: text(entry.passage, `findingRef.references[${index}].passage`, 4000, true), passageKind,
      ...(entry.passageLabel === undefined ? {} : { passageLabel: text(entry.passageLabel, 'findingRef evidence passageLabel', 200) }),
      canvasId, documentId, ...(entry.documentTitle === undefined ? {} : { documentTitle: text(entry.documentTitle, 'findingRef evidence documentTitle', 200) }),
      ...(entry.contentHash === undefined ? {} : { contentHash: text(entry.contentHash, 'findingRef evidence contentHash', 128) }),
      ...(entry.revision === undefined ? {} : { revision: text(entry.revision, 'findingRef evidence revision', 160) }),
      checkedAt: new Date(checkedAt).toISOString(), navigation: { kind: 'document' as const, canvasId, blockId: documentId } };
  });
}

export function newTask(input: Record<string, unknown>, actor: string, known: Set<string>): CanvasTask {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), title: text(input.title, 'title', 160, true), detail: input.detail === undefined ? '' : text(input.detail, 'detail', 4000),
    status: input.status === undefined ? 'todo' : status(input.status),
    ...(input.assignee === undefined ? {} : { assignee: assignee(input.assignee) }),
    blockIds: input.blockIds === undefined ? [] : blockIds(input.blockIds, known),
    ...(input.findingRef === undefined ? {} : { findingRef: findingRef(input.findingRef, known) }),
    createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now, comments: [],
  };
}

export function patchedTask(task: CanvasTask, input: Record<string, unknown>, actor: string, known: Set<string>): CanvasTask {
  const next: CanvasTask = {
    ...task,
    title: input.title === undefined ? task.title : text(input.title, 'title', 160, true),
    detail: input.detail === undefined ? task.detail : text(input.detail, 'detail', 4000),
    status: input.status === undefined ? task.status : status(input.status),
    blockIds: input.blockIds === undefined ? task.blockIds.filter(id => known.has(id)) : blockIds(input.blockIds, known),
    updatedBy: actor, updatedAt: new Date().toISOString(),
  };
  if (input.assignee !== undefined) {
    const name = assignee(input.assignee);
    if (name) next.assignee = name; else delete next.assignee;
  }
  return next;
}

/** Claiming assigns a task to the caller. Another agent's active claim needs `force`. */
export function claimedTask(task: CanvasTask, actor: string, force: boolean): CanvasTask {
  if (task.assignee && task.assignee !== actor && task.status !== 'done' && !force) {
    throw new ApiError(409, `${task.assignee} already claimed this task. Pass force to take it over.`);
  }
  return { ...task, assignee: actor, status: task.status === 'done' ? 'done' : 'in_progress', updatedBy: actor, updatedAt: new Date().toISOString() };
}

export function commentedTask(task: CanvasTask, value: unknown, actor: string): CanvasTask {
  const now = new Date().toISOString();
  const comments = [...task.comments, { author: actor, text: text(value, 'text', 2000, true), createdAt: now }].slice(-100);
  return { ...task, comments, updatedBy: actor, updatedAt: now };
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
    if (current && current.owner !== owner && input.force !== true) {
      throw new ApiError(409, `${current.owner} is editing this document until ${current.expiresAt}. Pass force to take it over.`);
    }
    const ttl = input.ttlSeconds === undefined ? 600 : Number(input.ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 3600) throw new ApiError(400, 'ttlSeconds must be between 30 and 3600');
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
}
