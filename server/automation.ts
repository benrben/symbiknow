import type { AutomationKind, InsightAction } from '../shared/insights.js';
import type { GroupBy } from '../shared/types.js';
import { decideWithJev, type JevDecider } from './jev.js';
import { CanvasStore } from './storage.js';
import { applyCanvasRun, previewCanvasRun } from './runs.js';

export async function applyInsightAction(store: CanvasStore, canvasId: string, action: InsightAction, actor: string): Promise<void> {
  if (action.type === 'layout') {
    await store.updateLayout(canvasId, action.positions);
    return;
  }
  if (action.type === 'update') {
    await store.updateBlock(canvasId, action.blockId, action.patch, actor);
    return;
  }
  if (action.type === 'cross_link') {
    const canvas = await store.getCanvas(canvasId);
    const source = canvas.blocks.find(block => block.id === action.fromBlockId);
    if (!source) throw new Error('The source document no longer exists.');
    const crossLinks = [...(source.crossLinks ?? []).filter(link => link.canvasId !== action.to.canvasId || link.blockId !== action.to.blockId), action.to];
    await store.updateBlock(canvasId, source.id, { crossLinks }, actor);
    return;
  }
  if (action.type === 'move') {
    await store.moveBlockToCanvas(canvasId, action.blockId, action.toCanvasId, actor);
    return;
  }
  if (action.type === 'task') {
    await store.updateTask(canvasId, action.taskId, action.patch, actor);
    return;
  }
  if (action.type !== 'link' && action.type !== 'unlink') throw new Error(`Unsupported canvas automation action: ${action.type}`);
  const canvas = await store.getCanvas(canvasId);
  const source = canvas.blocks.find(block => block.id === action.fromBlockId);
  if (!source) throw new Error('The source document no longer exists.');
  const links = action.type === 'unlink' ? source.links.filter(id => id !== action.toBlockId)
    : [...new Set([...source.links, action.toBlockId])];
  const linkTypes = { ...source.linkTypes };
  if (action.type === 'unlink') delete linkTypes[action.toBlockId];
  else if (action.relation) linkTypes[action.toBlockId] = action.relation;
  await store.updateBlock(canvasId, source.id, { links, linkTypes }, actor);
  if (action.type === 'link' && action.relation === 'supersedes') {
    await store.updateBlock(canvasId, action.toBlockId, { stale: true }, actor);
  }
}

export type AutomationResult = { kind: AutomationKind; applied: number; runId: string;
  groupBy?: GroupBy; groups?: Array<{ key: string; count: number }> };

/** Ask Jev only the questions this automation needs, then apply its eligible changes. */
export async function runCanvasAutomation(store: CanvasStore, canvasId: string, kind: AutomationKind,
  decider: JevDecider = decideWithJev, options: { groupBy?: GroupBy; actor?: string } = {}): Promise<AutomationResult> {
  const preview = await previewCanvasRun(store, canvasId, kind, decider, options.groupBy);
  const result = await applyCanvasRun(store, canvasId, preview.runId, preview.changes.map(change => change.id), options.actor);
  const grouped = kind === 'layout' || kind === 'regroup';
  const layout = preview.changes.map(change => change.action).find(action => action.type === 'layout');
  const counts = new Map<string, number>();
  if (layout?.type === 'layout') for (const position of layout.positions) if (position.group) counts.set(position.group, (counts.get(position.group) ?? 0) + 1);
  return { kind, applied: result.applied?.length ?? 0, runId: preview.runId,
    ...(grouped ? { groupBy: preview.groupBy, groups: [...counts].map(([key, count]) => ({ key, count })) } : {}) };
}
