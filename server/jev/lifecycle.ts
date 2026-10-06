import path from 'node:path';
import { readdir, readFile, rm } from 'node:fs/promises';
import type { JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import { validId } from '../storage-shapes.js';
import { JevWorkspaceFiles } from './workspace.js';

async function entries(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
type ScopedJob = JevWorkspaceState['jobs'][number] & { contextSources?: JevSourceSnapshot[] };
async function liveSources(store: CanvasStore, canvases: Array<{ id: string }>): Promise<Set<string>> {
  const live = new Set<string>();
  for (const summary of canvases) for (const block of (await store.getCanvas(summary.id, true)).blocks) live.add(`${summary.id}:${block.id}:${block.incarnation}`);
  return live;
}
function pruneProfiles(state: JevWorkspaceState, live: Set<string>, missing: (source: JevSourceSnapshot) => boolean): void {
  for (const [key, profile] of Object.entries(state.profiles)) {
    if (missingProfile(key, profile, live, missing)) delete state.profiles[key];
  }
}
function missingProfile(key: string, profile: Record<string, unknown>, live: Set<string>, missing: (source: JevSourceSnapshot) => boolean): boolean {
  const source = profile.source as JevSourceSnapshot | undefined;
  const scopes = profile.scopedSources as JevSourceSnapshot[] | undefined;
  const missingDocument = !key.startsWith('workspace:') && ![...live].some(id => id.startsWith(`${key}:`));
  return Boolean((source && missing(source)) || scopes?.some(missing) || missingDocument);
}

function retainedEntries(state: JevWorkspaceState): number {
  return state.jobs.length + state.proposals.length + state.receipts.length + state.prepared.length
    + state.vocabulary.length + Object.keys(state.profiles).length;
}

/** Forget only analyses whose stored inputs disappeared; remaining canonical documents stay authoritative. */
export async function pruneJevWorkspace(store: CanvasStore, workspaceId: string, state: JevWorkspaceState): Promise<boolean> {
  const workspace = (await store.listWorkspaces()).find(item => item.id === workspaceId);
  if (!workspace) return false;
  const live = await liveSources(store, workspace.canvases);
  const missing = (source: JevSourceSnapshot) => !live.has(`${source.canvasId}:${source.blockId}:${source.incarnation}`)
    && !movedSourceIsLive(state, live, source);
  // Pruning only removes entries; counting them avoids reading every historical canvas proof.
  const previous = retainedEntries(state);
  const removedJobs = new Set(state.jobs.filter(job => (job as ScopedJob).contextSources?.some(missing) || job.sources.some(missing)).map(job => job.id));
  // A task with no document attachments remains a real record after the
  // evidence document is removed. Keep its applied receipt for guarded Undo.
  const independentTasks = new Set(state.receipts.filter(receipt => receipt.state === 'applied'
    && receipt.after.kind === 'task_create' && !receipt.after.task.blockIds?.length && !receipt.sourcesAfter.length)
    .map(receipt => receipt.proposalId));
  state.jobs = state.jobs.filter(job => !removedJobs.has(job.id));
  state.proposals = state.proposals.filter(proposal => independentTasks.has(proposal.id)
    || (!removedJobs.has(proposal.jobId) && !proposal.sources.some(missing)));
  const proposals = new Set(state.proposals.map(proposal => proposal.id));
  state.receipts = state.receipts.filter(receipt => proposals.has(receipt.proposalId) && !receipt.sourcesAfter.some(missing));
  state.prepared = state.prepared.filter(record => proposals.has(record.proposal.id));
  state.vocabulary = state.vocabulary.filter(term => term.members.every(member => {
    return [...live].some(key => key.startsWith(`${member.canvasId}:${member.blockId}:`));
  }));
  pruneProfiles(state, live, missing);
  return retainedEntries(state) !== previous;
}

function movedSourceIsLive(state: JevWorkspaceState, live: Set<string>, source: JevSourceSnapshot): boolean {
  return state.receipts.some(receipt => receipt.state === 'applied' && receipt.after.kind === 'move'
    && receipt.after.canvasId === source.canvasId && receipt.after.blockId === source.blockId
    && live.has(`${receipt.after.targetCanvasId}:${source.blockId}:${source.incarnation}`));
}

export async function purgeJevOrphans(store: CanvasStore, files: JevWorkspaceFiles): Promise<void> {
  const workspaces = await store.listWorkspaces();
  const workspaceIds = new Set(workspaces.map(workspace => workspace.id));
  const canvasIds = new Set(workspaces.flatMap(workspace => workspace.canvases.map(canvas => canvas.id)));
  const root = path.join(store.root, 'jev');
  await purgeWorkspaces(root, files, workspaceIds);
  await purgeDrafts(store, root, canvasIds);
  await purgeParentUndo(root, workspaceIds, canvasIds);
}
async function purgeWorkspaces(root: string, files: JevWorkspaceFiles, workspaceIds: Set<string>): Promise<void> {
  for (const id of await entries(path.join(root, 'workspaces'))) if (validId(id) && !workspaceIds.has(id)) {
    await files.serial(id, () => rm(path.join(root, 'workspaces', id), { recursive: true, force: true }));
  }
}
async function purgeDrafts(store: CanvasStore, root: string, canvasIds: Set<string>): Promise<void> {
  for (const id of await entries(path.join(root, 'drafts'))) {
    if (!validId(id)) continue;
    if (!canvasIds.has(id)) { await rm(path.join(root, 'drafts', id), { recursive: true, force: true }); continue; }
    const blocks = new Set((await store.getCanvas(id, true)).blocks.map(block => block.id));
    await purgeDraftFiles(root, id, blocks);
  }
}
async function purgeDraftFiles(root: string, id: string, blocks: Set<string>): Promise<void> {
    for (const name of await entries(path.join(root, 'drafts', id))) {
      if (name.endsWith('.json') && validId(name.slice(0, -5)) && !blocks.has(name.slice(0, -5))) await rm(path.join(root, 'drafts', id, name), { force: true });
    }
}
async function purgeParentUndo(root: string, workspaceIds: Set<string>, canvasIds: Set<string>): Promise<void> {
  for (const name of await entries(path.join(root, 'parent-undo'))) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(root, 'parent-undo', name);
    const journal = JSON.parse(await readFile(file, 'utf8')) as { workspaceId: string; canvasId: string };
    if (!workspaceIds.has(journal.workspaceId) || !canvasIds.has(journal.canvasId)) await rm(file, { force: true });
  }
}
