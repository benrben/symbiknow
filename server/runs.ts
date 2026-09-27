import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { automationActions, type AutomationKind, type InsightAction, type InsightItem } from '../shared/insights.js';
import { analyzeCanvas, automationFamilies } from './insights.js';
import { applyInsightAction } from './automation.js';
import { findCrossConnections } from './cross-canvas.js';
import { findDuplicates } from './duplicates.js';
import { decideWithJev, type JevDecider } from './jev.js';
import { ApiError, CanvasStore } from './storage.js';
import { effectiveJevPolicy } from '../shared/policy.js';

export type WorkspaceAutomationKind = AutomationKind | 'dedupe' | 'tidy' | 'connect_all';
export type WorkspaceChange = { id: string; canvasId: string; confidence: number; action: InsightAction;
  expectedContentHashes: Record<string, string>; requiresClick?: boolean; dependsOn?: string[];
  postMerge?: { kind: 'connection'; canvasId: string; blockIds: string[] } };
export type WorkspaceSuggestion = { canvasId: string; item: InsightItem };
export type ChangeSet = { runId: string; workspaceId: string; kind: WorkspaceAutomationKind; dryRun: boolean;
  changes: WorkspaceChange[]; groups: { canvasId: string; canvasName: string; count: number }[];
  suggestions?: WorkspaceSuggestion[]; applied?: string[]; skipped?: { id: string; reason: string }[] };
type Snapshot = { blocks: CanvasBlock[]; task?: { id: string; status: string; blockIds: string[] } };
type AppliedStep = { change: WorkspaceChange; before: Snapshot; after: Snapshot };
type Journal = ChangeSet & { createdAt: string; status: 'preview' | 'applied' | 'undone'; steps: AppliedStep[] };

function runFile(store: CanvasStore, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(400, 'Invalid Jev run ID');
  return path.join(store.root, 'jev-runs', `${id}.json`);
}

async function save(store: CanvasStore, journal: Journal): Promise<void> {
  const file = runFile(store, journal.runId);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(journal, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

async function load(store: CanvasStore, runId: string): Promise<Journal> {
  try { return JSON.parse(await readFile(runFile(store, runId), 'utf8')) as Journal; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Jev run not found');
    throw error;
  }
}

function affectedIds(action: InsightAction, canvas: CanvasDocument): string[] {
  if (action.type === 'update') return [action.blockId];
  if (action.type === 'link' || action.type === 'unlink' || action.type === 'cross_link') {
    return action.type === 'link' && action.relation === 'supersedes' ? [action.fromBlockId, action.toBlockId] : [action.fromBlockId];
  }
  if (action.type === 'merge') return canvas.blocks.map(block => block.id);
  if (action.type === 'layout') return action.positions.map(position => position.blockId);
  return [];
}

async function snapshot(store: CanvasStore, change: WorkspaceChange): Promise<Snapshot> {
  const canvas = await store.getCanvas(change.canvasId, true);
  const ids = new Set(affectedIds(change.action, canvas));
  const blocks = canvas.blocks.filter(block => ids.has(block.id)).map(block => structuredClone(block));
  if (change.action.type === 'task') {
    const taskId = change.action.taskId;
    const task = (await store.listTasks(change.canvasId)).find(item => item.id === taskId);
    if (task) return { blocks, task: { id: task.id, status: task.status, blockIds: task.blockIds } };
  }
  return { blocks };
}

function comparable(value: Snapshot): string {
  return JSON.stringify({ blocks: value.blocks.map(block => {
    const copy = { ...block };
    delete copy.contentHash;
    delete copy.lock;
    return copy;
  }), task: value.task });
}

async function restore(store: CanvasStore, change: WorkspaceChange, before: Snapshot, actor: string): Promise<void> {
  const action = change.action;
  if (action.type === 'layout') {
    await store.updateLayout(change.canvasId, before.blocks.map(block => ({ blockId: block.id, x: block.x, y: block.y, group: block.group ?? null })));
    return;
  }
  if (action.type === 'update') {
    const block = before.blocks.find(item => item.id === action.blockId);
    if (!block) return;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(action.patch) as Array<keyof typeof action.patch>) {
      const value = block[key];
      patch[key] = value ?? (['purpose', 'reviewer', 'workArea'].includes(key) ? '' : key === 'tags' ? [] : key === 'linkTypes' ? {} : false);
    }
    await store.updateBlock(change.canvasId, block.id, patch, actor);
    return;
  }
  if (action.type === 'link' || action.type === 'unlink') {
    const source = before.blocks.find(block => block.id === action.fromBlockId);
    if (source) await store.updateBlock(change.canvasId, source.id, { links: source.links, linkTypes: source.linkTypes ?? {} }, actor);
    if (action.type === 'link' && action.relation === 'supersedes') {
      const target = before.blocks.find(block => block.id === action.toBlockId);
      if (target) await store.updateBlock(change.canvasId, target.id, { stale: target.stale ?? false }, actor);
    }
    return;
  }
  if (action.type === 'cross_link') {
    const source = before.blocks.find(block => block.id === action.fromBlockId);
    if (source) await store.updateBlock(change.canvasId, source.id, { crossLinks: source.crossLinks ?? [] }, actor);
    return;
  }
  if (action.type === 'task') {
    if (before.task) await store.updateTask(change.canvasId, before.task.id,
      { status: before.task.status, blockIds: before.task.blockIds }, actor);
    return;
  }
  for (const block of before.blocks) {
    await store.updateBlock(change.canvasId, block.id, {
      title: block.title, content: block.content, kind: block.kind, x: block.x, y: block.y,
      width: block.width, height: block.height, links: block.links, linkTypes: block.linkTypes ?? {},
      crossLinks: block.crossLinks ?? [], tags: block.tags ?? [], purpose: block.purpose ?? '',
      reviewer: block.reviewer ?? '', workArea: block.workArea ?? '', group: block.group ?? null,
      archived: block.archived ?? false, stale: block.stale ?? false,
    }, actor);
  }
}

function changeFromAction(canvas: CanvasDocument, action: InsightAction, confidence: number, suffix: number): WorkspaceChange {
  const ids = affectedIds(action, canvas);
  return { id: `${canvas.id}:${suffix}`, canvasId: canvas.id, confidence, action,
    expectedContentHashes: Object.fromEntries(canvas.blocks.filter(block => ids.includes(block.id))
      .map(block => [block.id, block.contentHash ?? ''])),
    ...(action.type === 'merge' ? { requiresClick: true } : {}) };
}

function itemConfidence(action: InsightAction, items: InsightItem[]): number {
  const exact = items.find(item => item.action && JSON.stringify(item.action) === JSON.stringify(action));
  return exact?.confidence ?? 1;
}

async function canvasChanges(store: CanvasStore, canvas: CanvasDocument, kind: AutomationKind,
  decider: JevDecider): Promise<WorkspaceChange[]> {
  if (kind === 'cross_connect') return [];
  const groupBy = (await store.getSettings()).groupBy ?? 'work_area';
  const report = await analyzeCanvas(store, canvas.id, '', decider,
    { families: automationFamilies(kind, groupBy), reuseLabels: kind === 'layout' || kind === 'regroup', groupBy });
  return automationActions(report, canvas, kind, groupBy).map((action, index) =>
    changeFromAction(canvas, action, itemConfidence(action, report.items), index));
}

function previewStore(store: CanvasStore, canvas: CanvasDocument): CanvasStore {
  return new Proxy(store, { get(target, property) {
    if (property === 'getCanvas') return async (id: string, includeArchived?: boolean) =>
      id === canvas.id ? canvas : target.getCanvas(id, includeArchived);
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function virtualUpdate(canvas: CanvasDocument, action: InsightAction, originalHashes: Map<string, string>): void {
  if (action.type !== 'update') return;
  const block = canvas.blocks.find(item => item.id === action.blockId);
  if (!block) return;
  Object.assign(block, action.patch);
  block.contentHash = createHash('sha256').update(JSON.stringify({ contentHash: originalHashes.get(block.id),
    kind: block.kind, purpose: block.purpose, workArea: block.workArea })).digest('hex');
}

/** Evaluate each tidy stage against an in-memory preview of the preceding stages. */
async function tidyChanges(store: CanvasStore, canvas: CanvasDocument, decider: JevDecider):
  Promise<{ changes: WorkspaceChange[]; suggestions: WorkspaceSuggestion[] }> {
  const virtual = structuredClone(canvas);
  const stagedStore = previewStore(store, virtual);
  const originalHashes = new Map(canvas.blocks.map(block => [block.id, block.contentHash ?? '']));
  const groupBy = (await store.getSettings()).groupBy ?? 'work_area';
  const changes: WorkspaceChange[] = [];
  const suggestions: WorkspaceSuggestion[] = [];
  const feeders = new Map<string, { confidence: number; ids: string[] }>();
  const blocked = new Set<string>();
  const add = (action: InsightAction, confidence: number, blockIds: string[]) => {
    const inputs = blockIds.map(id => feeders.get(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const change = changeFromAction(canvas, action, Math.min(confidence, ...inputs.map(entry => entry.confidence)), changes.length);
    change.id = randomUUID(); // Temporary unique ID, remapped to the public run ID below.
    const dependsOn = [...new Set(inputs.flatMap(entry => entry.ids))];
    if (dependsOn.length) change.dependsOn = dependsOn;
    changes.push(change);
    for (const id of blockIds) {
      const previous = feeders.get(id);
      feeders.set(id, { confidence: Math.min(previous?.confidence ?? 1, confidence), ids: [...(previous?.ids ?? []), change.id] });
    }
    virtualUpdate(virtual, action, originalHashes);
  };

  for (const family of ['loader', 'purpose', 'work_area'] as const) {
    const report = await analyzeCanvas(stagedStore, canvas.id, '', decider, { families: [family] });
    for (const item of report.items.filter(item => item.category === family)) {
      const id = item.blockIds[0];
      if (blocked.has(id)) continue;
      if (item.action?.type === 'update') add(item.action, item.confidence, [id]);
      else { blocked.add(id); suggestions.push({ canvasId: canvas.id, item }); }
    }
  }
  if (blocked.size || canvas.blocks.length < 2) return { changes, suggestions };
  const report = await analyzeCanvas(stagedStore, canvas.id, '', decider,
    { families: automationFamilies('layout', groupBy), reuseLabels: true, groupBy });
  const layout = report.items.find(item => item.category === 'layout');
  if (layout?.action?.type !== 'layout') {
    if (layout) suggestions.push({ canvasId: canvas.id, item: layout });
    return { changes, suggestions };
  }
  const allBlockIds = canvas.blocks.map(block => block.id);
  for (const action of automationActions(report, virtual, 'layout', groupBy)) {
    add(action, layout.confidence, action.type === 'layout' ? allBlockIds : affectedIds(action, canvas));
  }
  return { changes, suggestions };
}

type Feeder = { confidence: number; ids: string[] };

async function crossChanges(store: CanvasStore, canvases: CanvasDocument[], decider: JevDecider,
  feeders: Map<string, Feeder> = new Map()): Promise<WorkspaceChange[]> {
  if (canvases.length < 2) return [];
  const settings = await store.getSettings();
  const applyThreshold = effectiveJevPolicy(settings.jevPolicy).cross_link.apply;
  const apiKey = await store.getJevApiKey();
  if (!apiKey) throw new ApiError(400, 'Set a TypeSafe Jev API key in Settings before using insights');
  const items = await findCrossConnections({ canvases, index: store.similarityIndex(canvases[0].workspaceId),
    apiKey, decider, policy: settings.jevPolicy });
  return items.flatMap((item, index) => {
    if (item.action?.type !== 'cross_link') return [];
    const action = item.action;
    const canvas = canvases.find(entry => entry.blocks.some(block => block.id === action.fromBlockId));
    if (!canvas) return [];
    const inputs = [feeders.get(action.fromBlockId), feeders.get(action.to.blockId)]
      .filter((entry): entry is Feeder => Boolean(entry));
    const confidence = Math.min(item.confidence, ...inputs.map(entry => entry.confidence));
    if (confidence < applyThreshold) return [];
    const change = changeFromAction(canvas, action, confidence, index);
    change.id = randomUUID();
    const dependsOn = [...new Set(inputs.flatMap(entry => entry.ids))];
    if (dependsOn.length) change.dependsOn = dependsOn;
    const target = canvases.find(entry => entry.id === action.to.canvasId)?.blocks.find(block => block.id === action.to.blockId);
    if (target) change.expectedContentHashes[target.id] = target.contentHash ?? '';
    return [change];
  });
}

async function dedupeChanges(store: CanvasStore, canvases: CanvasDocument[], decider: JevDecider): Promise<WorkspaceChange[]> {
  const apiKey = await store.getJevApiKey();
  if (!apiKey) throw new ApiError(400, 'Set a TypeSafe Jev API key in Settings before using insights');
  const settings = await store.getSettings();
  const changes: WorkspaceChange[] = [];
  for (const canvas of canvases) {
    const items = await findDuplicates({ canvasId: canvas.id, blocks: canvas.blocks,
      index: store.similarityIndex(canvas.workspaceId), apiKey, decider, policy: settings.jevPolicy });
    changes.push(...items.map((item, index) => ({ ...changeFromAction(canvas, item.action, item.confidence, index),
      postMerge: { kind: 'connection' as const, canvasId: canvas.id, blockIds: [item.action.keepBlockId] } })));
  }
  return changes;
}

/** Compute changes and save a reviewable, hash-bound preview without applying them. */
export async function previewWorkspaceRun(store: CanvasStore, workspaceId: string, kind: WorkspaceAutomationKind,
  decider: JevDecider = decideWithJev): Promise<ChangeSet> {
  const workspace = (await store.listWorkspaces()).find(item => item.id === workspaceId);
  if (!workspace) throw new ApiError(404, 'Workspace not found');
  const canvases = await Promise.all(workspace.canvases.map(item => store.getCanvas(item.id)));
  let changes: WorkspaceChange[] = [];
  const suggestions: WorkspaceSuggestion[] = [];
  if (kind === 'dedupe') changes = await dedupeChanges(store, canvases, decider);
  else if (kind === 'tidy') {
    for (const canvas of canvases) {
      const stage = await tidyChanges(store, canvas, decider);
      changes.push(...stage.changes);
      suggestions.push(...stage.suggestions);
    }
  }
  else {
    const canvasKinds: AutomationKind[] = kind === 'connect_all' ? ['connection'] : kind === 'cross_connect' ? [] : [kind];
    for (const canvas of canvases) for (const canvasKind of canvasKinds) {
      changes.push(...await canvasChanges(store, canvas, canvasKind, decider));
    }
    if (kind === 'cross_connect' || kind === 'connect_all') {
      const feeders = new Map<string, Feeder>();
      if (kind === 'connect_all') for (const change of changes) {
        const ids = change.action.type === 'link' || change.action.type === 'unlink'
          ? [change.action.fromBlockId, change.action.toBlockId]
          : affectedIds(change.action, canvases.find(canvas => canvas.id === change.canvasId)!);
        for (const id of ids) {
          const prior = feeders.get(id);
          feeders.set(id, { confidence: Math.min(prior?.confidence ?? 1, change.confidence),
            ids: [...(prior?.ids ?? []), change.id] });
        }
      }
      changes.push(...await crossChanges(store, canvases, decider, feeders));
    }
  }
  const ids = new Map(changes.map((change, index) => [change.id, `${workspaceId}:${index}`]));
  changes = changes.map((change, index) => ({ ...change, id: `${workspaceId}:${index}`,
    ...(change.dependsOn ? { dependsOn: change.dependsOn.map(id => ids.get(id) ?? id) } : {}) }));
  const groups = canvases.map(canvas => ({ canvasId: canvas.id, canvasName: canvas.name,
    count: changes.filter(change => change.canvasId === canvas.id).length }));
  const result: ChangeSet = { runId: randomUUID(), workspaceId, kind, dryRun: true, changes, groups,
    ...(suggestions.length ? { suggestions } : {}) };
  await save(store, { ...result, createdAt: new Date().toISOString(), status: 'preview', steps: [] });
  return result;
}

export async function applyWorkspaceRun(store: CanvasStore, runId: string, actionIds: string[], actor = 'Jev', workspaceId?: string): Promise<ChangeSet> {
  const journal = await load(store, runId);
  if (workspaceId && journal.workspaceId !== workspaceId) throw new ApiError(400, 'Jev run belongs to another workspace');
  if (journal.status !== 'preview') throw new ApiError(409, 'This preview was already applied');
  const allowed = new Set(journal.changes.map(change => change.id));
  if (actionIds.some(id => !allowed.has(id))) throw new ApiError(400, 'Unknown workspace action');
  const selected = new Set(actionIds);
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const change of journal.changes.filter(item => selected.has(item.id))) {
    if (change.requiresClick) {
      skipped.push({ id: change.id, reason: 'Merge requires reviewed content; rerun connections after merging' }); continue;
    }
    if (change.dependsOn?.some(id => !applied.includes(id))) {
      skipped.push({ id: change.id, reason: 'Prerequisite action was not applied' }); continue;
    }
    const current = await store.getCanvas(change.canvasId, true);
    const targetCanvas = change.action.type === 'cross_link'
      ? await store.getCanvas(change.action.to.canvasId, true) : undefined;
    const fresh = Object.entries(change.expectedContentHashes).every(([id, hash]) =>
      (current.blocks.find(block => block.id === id)
        ?? targetCanvas?.blocks.find(block => block.id === id))?.contentHash === hash);
    if (!fresh) { skipped.push({ id: change.id, reason: 'Document changed since preview' }); continue; }
    const before = await snapshot(store, change);
    await applyInsightAction(store, change.canvasId, change.action, actor);
    const after = await snapshot(store, change);
    journal.steps.push({ change, before, after });
    await save(store, journal);
    applied.push(change.id);
  }
  journal.status = 'applied';
  await save(store, journal);
  return { ...journal, dryRun: false, applied, skipped };
}

export async function undoWorkspaceRun(store: CanvasStore, runId: string, actor = 'Jev undo'):
  Promise<{ runId: string; reverted: string[]; skipped: { id: string; reason: string }[] }> {
  const journal = await load(store, runId);
  if (journal.status !== 'applied') throw new ApiError(409, 'This run has no applied changes to undo');
  const reverted: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const step of [...journal.steps].reverse()) {
    const current = await snapshot(store, step.change);
    if (comparable(current) !== comparable(step.after)) {
      skipped.push({ id: step.change.id, reason: 'Current state differs from the applied change' });
      continue;
    }
    await restore(store, step.change, step.before, actor);
    reverted.push(step.change.id);
  }
  journal.status = 'undone';
  await save(store, journal);
  return { runId, reverted, skipped };
}
