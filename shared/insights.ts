import type { BlockKind, CanvasBlock, CanvasDocument, CanvasTask, CrossLink, DocumentGroup, DocumentLane, GroupBy, LinkRelation, TaskStatus } from './types.js';
import { defaultJevPolicy, type JevPolicy } from './policy.js';
import type { EvidenceReference } from './evidence.js';

export type CanvasHealth = { orphanRatio: number; duplicateRatio: number; staleRatio: number; meanQuality: number | null; labelCoverage: number };
export type ReadingPath = { id: string; name: string; blockIds: string[] };
import { groupKey, groupLabel, normalizedGroup } from './groups.js';

export type InsightAction =
  | { type: 'update'; blockId: string; patch: { kind?: BlockKind; purpose?: string; reviewer?: string; workArea?: string; tags?: string[]; linkTypes?: Record<string, LinkRelation>; stale?: boolean } }
  | { type: 'link'; fromBlockId: string; toBlockId: string; relation?: LinkRelation }
  | { type: 'unlink'; fromBlockId: string; toBlockId: string }
  | { type: 'merge'; keepBlockId: string; mergeBlockIds: string[]; plan: MergePlan }
  | { type: 'cross_link'; fromBlockId: string; to: CrossLink }
  | { type: 'move'; blockId: string; toCanvasId: string }
  | { type: 'task'; taskId: string; patch: { status?: TaskStatus; blockIds?: CanvasTask['blockIds'] } }
  | { type: 'layout'; positions: { blockId: string; x: number; y: number; group?: DocumentGroup | null }[] };

export type MergePlan = { keep: string; fold: string[]; conflicts: string[]; drop: string[] };

export type InsightCategory = 'connection' | 'layout' | 'loader' | 'purpose' | 'work_area' | 'duplicate'
  | 'conflict' | 'stale' | 'missing_steps' | 'reviewer' | 'merge' | 'cross_connection'
  | 'relation' | 'supersedes' | 'quality' | 'tag' | 'task' | 'move' | 'gap';

export interface InsightItem {
  id: string;
  category: InsightCategory;
  title: string;
  detail: string;
  blockIds: string[];
  confidence: number;
  action?: InsightAction;
  evidence?: { questionId: string; answer: string; excerpt: string; sourceIds?: string[];
    sourceHashes?: Record<string, string>; model?: string }[];
  /** Source references checked during this analysis; checkedAt is the analysis time. */
  references?: EvidenceReference[];
}

export type TaskSuggestion = InsightItem & { proposedAction: Extract<InsightAction, { type: 'task' }> };
/**
 * `priority` is the mean of the expected scores (0..1) for urgency and importance.
 * `effort` is the expected score (0..1) for effort. `blocked` is a Noul probability.
 * `priorityPerEffort` is a ranking key built from the discrete chosen (topScore) levels of
 * urgency, importance, and effort, not from the continuous `priority`/`effort` values, so
 * tasks with the same three levels always sort equally. Sort descending; do not treat it as a rate.
 */
export type TaskScore = { priority: number; effort: number; blocked: number; priorityPerEffort: number };
export type TaskInsightReport = { items: TaskSuggestion[]; scores: Record<string, TaskScore> };

export interface RankedBlock {
  blockId: string;
  title: string;
  score: number;
  confidence: number;
  lane?: DocumentLane;
}

/** Jev's classification of one document. Saved labels are reused with confidence 1 when Jev was not asked. */
export interface DocumentClass {
  blockId: string;
  title: string;
  order?: number;
  lane?: DocumentLane;
  laneConfidence?: number;
  workArea?: string;
  workAreaConfidence?: number;
  purpose?: string;
  purposeConfidence?: number;
}

export interface InsightReport {
  canvasId: string;
  query: string;
  analyzed: number;
  total: number;
  readingOrder: RankedBlock[];
  relevance: RankedBlock[];
  items: InsightItem[];
  classification?: DocumentClass[];
  groupBy?: GroupBy;
  jevPolicy?: Partial<JevPolicy>;
  notice?: string;
  health?: CanvasHealth;
  qualityScores?: Record<string, number>;
  readingPaths?: ReadingPath[];
}

export type AutomationKind = 'layout' | 'connection' | 'regroup' | 'purpose' | 'work_area' | 'reviewer' | 'cross_connect';

const minGroupConfidence = 0.5;
const minLabelConfidence = 0.85;

/** The group a document belongs to for a grouping, from Jev's classification or the document's saved labels. */
export function documentGroup(block: CanvasBlock, entry: DocumentClass | undefined, groupBy: GroupBy): string {
  if (groupBy === 'lane') {
    const saved = normalizedGroup(block.group)?.startsWith('lane:') ? normalizedGroup(block.group)!.slice(5) : undefined;
    return groupKey('lane', entry?.lane ?? saved ?? 'overview');
  }
  const [value, confidence, saved] = groupBy === 'purpose'
    ? [entry?.purpose, entry?.purposeConfidence, block.purpose] : [entry?.workArea, entry?.workAreaConfidence, block.workArea];
  const placed = normalizedGroup(block.group);
  const prefix = groupBy === 'purpose' ? 'purpose:' : 'area:';
  const savedGroup = placed?.startsWith(prefix) ? placed.slice(prefix.length) : undefined;
  const chosen = value && value !== 'other' && (confidence ?? 1) >= minGroupConfidence ? value : saved || savedGroup;
  return groupKey(groupBy, chosen || 'other');
}

export type LayoutGroup = { key: string; label: string; blockIds: string[] };

/** Group every document on the canvas, ordered by reading position. */
export function canvasGrouping(blocks: CanvasBlock[], report: Pick<InsightReport, 'classification' | 'readingOrder'>, groupBy: GroupBy): LayoutGroup[] {
  const classes = new Map((report.classification ?? []).map(entry => [entry.blockId, entry]));
  const order = new Map(report.readingOrder.map((entry, index) => [entry.blockId, entry.score + index / 10_000]));
  const score = (id: string) => order.get(id) ?? classes.get(id)?.order ?? 0.5;
  const groups = new Map<string, CanvasBlock[]>();
  for (const block of blocks) {
    const key = documentGroup(block, classes.get(block.id), groupBy);
    groups.set(key, [...(groups.get(key) ?? []), block]);
  }
  const average = (members: CanvasBlock[]) => members.reduce((sum, block) => sum + score(block.id), 0) / members.length;
  return [...groups.entries()]
    .map(([key, members]) => ({ key, label: groupLabel(key), members: [...members].sort((a, b) => score(a.id) - score(b.id) || a.title.localeCompare(b.title)) }))
    .sort((a, b) => Number(a.key.endsWith(':other')) - Number(b.key.endsWith(':other')) || average(a.members) - average(b.members) || a.label.localeCompare(b.label))
    .map(({ key, label, members }) => ({ key, label, blockIds: members.map(block => block.id) }));
}

const origin = 80;
const groupGapX = 160;
const groupGapY = 200;
const cellGap = 48;
const maxRowWidth = 3200;

/** Place each group as a compact grid, left to right, wrapping into rows with room for group frames and edges. */
export function groupedLayout(blocks: CanvasBlock[], report: Pick<InsightReport, 'classification' | 'readingOrder'>, groupBy: GroupBy): Extract<InsightAction, { type: 'layout' }> {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const positions: Extract<InsightAction, { type: 'layout' }>['positions'] = [];
  let cursorX = origin;
  let cursorY = origin;
  let rowHeight = 0;
  for (const group of canvasGrouping(blocks, report, groupBy)) {
    const members = group.blockIds.map(id => byId.get(id)!);
    const columns = members.length > 8 ? 3 : members.length > 3 ? 2 : 1;
    const cellWidth = Math.max(...members.map(block => block.width)) + cellGap;
    const rows = Array.from({ length: Math.ceil(members.length / columns) }, (_, row) => members.slice(row * columns, row * columns + columns));
    const rowHeights = rows.map(row => Math.max(...row.map(block => block.height)));
    const width = columns * cellWidth - cellGap;
    const height = rowHeights.reduce((sum, value) => sum + value, 0) + (rows.length - 1) * cellGap;
    if (cursorX > origin && cursorX + width > origin + maxRowWidth) {
      cursorX = origin;
      cursorY += rowHeight + groupGapY;
      rowHeight = 0;
    }
    let top = cursorY;
    rows.forEach((row, rowIndex) => {
      row.forEach((block, column) => positions.push({ blockId: block.id, x: cursorX + column * cellWidth, y: top, group: group.key }));
      top += rowHeights[rowIndex] + cellGap;
    });
    cursorX += width + groupGapX;
    rowHeight = Math.max(rowHeight, height);
  }
  return { type: 'layout', positions };
}

/** Save confident Jev labels on unlabeled documents so each card shows the label its group is based on. */
function groupLabelUpdates(blocks: CanvasBlock[], report: InsightReport, groupBy: GroupBy): InsightAction[] {
  if (groupBy === 'lane') return [];
  const byId = new Map(blocks.map(block => [block.id, block]));
  return (report.classification ?? []).flatMap(entry => {
    const block = byId.get(entry.blockId);
    const [value, confidence, saved] = groupBy === 'purpose'
      ? [entry.purpose, entry.purposeConfidence ?? 0, block?.purpose] : [entry.workArea, entry.workAreaConfidence ?? 0, block?.workArea];
    if (!block || saved || !value || value === 'other' || confidence < minLabelConfidence) return [];
    return [{ type: 'update' as const, blockId: block.id, patch: groupBy === 'purpose' ? { purpose: value } : { workArea: value } }];
  });
}

export function automationActions(report: InsightReport, canvas: CanvasDocument, kind: AutomationKind, groupBy: GroupBy = report.groupBy ?? 'work_area'): InsightAction[] {
  if (kind === 'cross_connect') return report.items.flatMap(item => item.category === 'cross_connection' && item.action ? [item.action] : []);
  if (kind === 'regroup') return [...automationActions(report, canvas, 'layout', groupBy), ...automationActions(report, canvas, 'connection', groupBy)];
  if (kind === 'layout') return canvas.blocks.length > 1
    ? [groupedLayout(canvas.blocks, report, groupBy), ...groupLabelUpdates(canvas.blocks, report, groupBy)] : [];
  if (kind === 'connection') return report.items.flatMap(item => item.category === 'connection'
    && item.action && item.confidence >= (item.action.type === 'unlink'
      ? report.jevPolicy?.unlink?.apply ?? defaultJevPolicy.unlink.apply
      : report.jevPolicy?.link?.apply ?? defaultJevPolicy.link.apply)
    ? [item.action] : []);
  return report.items.flatMap(item => item.category === kind && item.action ? [item.action] : []);
}
