import type { JevSourceSnapshot } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';
import type { StoredJevJob } from './runtime-queue.js';
import { sourceSnapshot } from './stamps.js';

const actions = new Set(['profile', 'label']);
const sourceIdentity: Array<keyof JevSourceSnapshot> = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'];

function simpleSourceRequest(job: StoredJevJob): boolean {
  const request = job.request;
  return actions.has(request.action) && request.query === undefined && request.options === undefined && Boolean(request.blockIds?.length);
}

function exactAutomation(job: StoredJevJob): boolean {
  return job.principal?.id === automationPrincipal.id && job.principal.kind === automationPrincipal.kind
    && principalFingerprint(job.principal) === principalFingerprint(automationPrincipal);
}

export function queuedSourceRefreshEligible(job: StoredJevJob): boolean {
  return job.state === 'queued' && simpleSourceRequest(job) && exactAutomation(job);
}

function selectedScope(job: StoredJevJob, workspaceId: string): boolean {
  const selected = new Set(job.request.blockIds);
  const guarded = new Set(job.sources.map(source => source.blockId));
  return guarded.size === job.sources.length && guarded.size === selected.size && job.sources.every(source =>
    source.workspaceId === workspaceId && source.canvasId === job.request.canvasId && selected.has(source.blockId));
}

async function workspaceCanvas(store: CanvasStore, workspaceId: string, canvasId: string): Promise<boolean> {
  const workspace = (await store.listWorkspaces()).find(item => item.id === workspaceId);
  return Boolean(workspace?.canvases.some(canvas => canvas.id === canvasId));
}

async function currentSource(store: CanvasStore, source: JevSourceSnapshot): Promise<JevSourceSnapshot | undefined> {
  try { return sourceSnapshot(source.workspaceId, source.canvasId, await store.getCanvasBlock(source.canvasId, source.blockId)); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

function unchangedSource(current: JevSourceSnapshot | undefined, original: JevSourceSnapshot): boolean {
  return Boolean(current && sourceIdentity.every(field => current[field] === original[field]));
}

/** Only untouched source bytes/identity may take a fresh metadata guard before automatic evaluation starts. */
export async function currentQueuedSources(store: CanvasStore, workspaceId: string, job: StoredJevJob): Promise<JevSourceSnapshot[]> {
  if (!queuedSourceRefreshEligible(job) || !selectedScope(job, workspaceId)) return job.sources;
  if (!await workspaceCanvas(store, workspaceId, job.request.canvasId)) return job.sources;
  const current = await Promise.all(job.sources.map(source => currentSource(store, source)));
  if (!current.every((source, index) => unchangedSource(source, job.sources[index]))) return job.sources;
  return current as JevSourceSnapshot[];
}
