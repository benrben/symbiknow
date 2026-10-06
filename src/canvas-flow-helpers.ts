import { MarkerType, type Edge } from '@xyflow/react';
import { groupPath, groupTone, normalizedGroup } from '../shared/groups';
import type { CanvasBlock } from '../shared/types';
import type { CanvasNode, CanvasNodeData, Frame, GroupNode } from './canvas-types';
import type { Theme } from './theme';
import { groupDisplayLabel } from './canvas-group-labels';

export const framePadding = 28;

export const frameHeader = 65;

export const groupPrefix = 'group:';

export function makeNodes(
  canvasId: string,
  blocks: CanvasBlock[],
  onUpdateBlock: CanvasNodeData['onUpdateBlock'],
  onOpenBlock: CanvasNodeData['onOpenBlock'],
  onReadBlock: CanvasNodeData['onReadBlock'],
  onHistoryBlock: CanvasNodeData['onHistoryBlock'],
  onOpenCrossLink: CanvasNodeData['onOpenCrossLink'],
  onResize: CanvasNodeData['onResize'],
  onError: CanvasNodeData['onError'],
  highlightedId?: string,
): CanvasNode[] {
  return blocks.map((block) => ({
    id: block.id,
    type: 'document',
    ariaLabel: `Document: ${block.title}`,
    position: { x: block.x, y: block.y },
    width: block.width,
    height: block.height,
    style: { width: block.width, height: block.height },
    data: { block, canvasId, onUpdateBlock, onOpenBlock, onReadBlock, onHistoryBlock, onOpenCrossLink, onResize, onError, highlighted: block.id === highlightedId },
  }));
}

export function makeEdges(blocks: CanvasBlock[], theme: Theme): Edge[] {
  const ids = new Set(blocks.map((block) => block.id));
  const linkColor = theme === 'dark' ? '#AABFBA' : '#52666A';
  return blocks.flatMap((block) => block.links
    .filter((target) => ids.has(target))
    .map((target) => ({
      id: `${block.id}->${target}`,
      source: block.id,
      target,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color: linkColor },
      style: { stroke: linkColor, strokeWidth: 2 },
      label: block.linkTypes?.[target]?.replaceAll('_', ' '),
      labelStyle: { fill: linkColor, fontWeight: 700, fontSize: 10 },
      labelBgStyle: { fill: theme === 'dark' ? '#1C2E34' : '#FFFFFF' },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 5,
    })));
}

export function blockGroup(block: CanvasBlock): string | undefined { return normalizedGroup(block.group); }

function descendantLevels(group: string, members: CanvasBlock[]): number {
  const depths = members.map(block => groupPath(blockGroup(block) ?? '__ungrouped').length);
  return Math.max(1, ...depths) - groupPath(group).length;
}

export function frames(blocks: CanvasBlock[], positions: Map<string, { x: number; y: number; width: number; height: number }>, groupLabels?: Record<string, string>): Frame[] {
  const byGroup = new Map<string, CanvasBlock[]>();
  for (const block of blocks) {
    const group = blockGroup(block);
    for (const path of group ? groupPath(group) : ['__ungrouped']) {
      const members = byGroup.get(path) ?? [];
      members.push(block);
      byGroup.set(path, members);
    }
  }
  return [...byGroup.entries()].map(([group, members]) => {
    const boxes = members.map(block => positions.get(block.id) ?? { x: block.x, y: block.y, width: block.width, height: block.height });
    const left = Math.min(...boxes.map(box => box.x));
    const top = Math.min(...boxes.map(box => box.y));
    const right = Math.max(...boxes.map(box => box.x + box.width));
    const bottom = Math.max(...boxes.map(box => box.y + box.height));
    const depth = groupPath(group).length - 1;
    const levels = descendantLevels(group, members);
    const inset = framePadding * (levels + 1);
    return {
    id: groupPrefix + group, group, title: group === '__ungrouped' ? 'Ungrouped' : groupDisplayLabel(group, groupLabels),
    count: members.length, tone: group === '__ungrouped' ? 7 : groupTone(group), depth, x: left - inset,
    y: top - frameHeader - levels * 48, width: right - left + inset * 2,
    height: bottom - top + frameHeader + framePadding + levels * (48 + framePadding), members: members.map(block => block.id),
    topTitles: members.slice(0, 3).map(block => block.title),
  };
  });
}

function groupFrameLabel(frame: Frame): string {
  return `Group: ${frame.title}, ${frame.count} ${frame.count === 1 ? 'document' : 'documents'}`;
}

export function frameNodes(list: Frame[], collapsed: Set<string>, overview: boolean, onDrill: (group: string) => void, onCollapse: (group: string) => void, onHover: (group: string | null) => void, internalLinks: Map<string, number> = new Map(), externalLinks: Map<string, number> = new Map()): GroupNode[] {
  const maxDepth = Math.max(0, ...list.map(frame => frame.depth));
  return list.map(frame => ({
    id: frame.id, type: 'groupFrame', ariaLabel: groupFrameLabel(frame),
    position: { x: frame.x, y: frame.y }, zIndex: -2 - maxDepth + frame.depth, selectable: false, connectable: false,
    draggable: !overview,
    dragHandle: '.canvas-group__heading', className: `canvas-group-node${overview ? ' is-map-node' : ''}`, width: collapsed.has(frame.group) ? 380 : frame.width, height: collapsed.has(frame.group) ? 190 : frame.height,
    data: { group: frame.group, title: frame.title, count: frame.count, tone: frame.tone, width: collapsed.has(frame.group) ? 380 : frame.width, height: collapsed.has(frame.group) ? 190 : frame.height, depth: frame.depth, collapsed: collapsed.has(frame.group), overview, kind: frame.kind, topTitles: frame.topTitles, internalLinkCount: internalLinks.get(frame.group) ?? 0, externalLinkCount: externalLinks.get(frame.group) ?? 0, onDrill, onCollapse, onHover },
  }));
}

type GroupEdgeMode = 'full' | 'titles' | 'overview';

function incrementGroupLink(counts: Map<string, number>, from: string | undefined, to: string | undefined) {
  if (!from || !to || from === to) return;
  const key = `${from}\u0000${to}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function groupLinkCounts(blocks: CanvasBlock[], groupOf: Map<string, string | undefined>) {
  const counts = new Map<string, number>();
  for (const block of blocks) for (const target of block.links) {
    incrementGroupLink(counts, groupOf.get(block.id), groupOf.get(target));
  }
  return counts;
}

function linkCountLabel(count: number) { return `${count} ${count === 1 ? 'link' : 'links'}`; }

function edgeFocusClass(focused: boolean) { return `canvas-group-edge${focused ? ' is-focused' : ''}`; }

function overviewOpacity(hovered: string | null, focused: boolean, values: [number, number, number]) {
  if (!hovered) return values[2];
  return focused ? values[0] : values[1];
}

// Aggregate connections remain readable while a group is not hovered.
function groupEdgeStyle(stroke: string, mode: GroupEdgeMode, focused: boolean, hovered: string | null) {
  if (mode === 'overview') return { stroke, strokeWidth: focused ? 8 : 6, strokeDasharray: undefined,
    opacity: overviewOpacity(hovered, focused, [1, .2, .82]) };
  const rootsOnly = mode !== 'full';
  return { stroke, strokeWidth: rootsOnly ? 6 : 3, strokeDasharray: rootsOnly ? '18 14' : '7 7', opacity: overviewOpacity(hovered, focused, [1, .2, .68]) };
}

function edgeLabelStyles(theme: Theme, rootsOnly: boolean) {
  return {
    labelStyle: { fill: theme === 'dark' ? '#EAF1ED' : '#43595A', fontWeight: 700, fontSize: rootsOnly ? 34 : 11 },
    labelBgStyle: { fill: theme === 'dark' ? '#1C2E34' : '#F7F5EF' },
    labelBgPadding: rootsOnly ? [15, 8] as [number, number] : [6, 3] as [number, number], labelBgBorderRadius: 6,
  };
}

function groupEdgeMarker(stroke: string, rootsOnly: boolean) {
  const size = rootsOnly ? 14 : 18;
  return { type: MarkerType.ArrowClosed, color: stroke, width: size, height: size };
}

function groupEdgeLabel(mode: GroupEdgeMode, focused: boolean, count: number) {
  if (mode === 'overview' && !focused) return undefined;
  return linkCountLabel(count);
}

export function groupEdges(blocks: CanvasBlock[], theme: Theme, mode: GroupEdgeMode = 'full', hoveredGroup: string | null = null): Edge[] {
  const rootsOnly = mode !== 'full';
  const groupOf = new Map(blocks.map(block => {
    const group = blockGroup(block) ?? '__ungrouped';
    return [block.id, rootsOnly ? groupPath(group)[0] : group];
  }));
  return [...groupLinkCounts(blocks, groupOf)].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    const stroke = theme === 'dark' ? '#7D9E9D' : '#819995';
    const focused = hoveredGroup === from || hoveredGroup === to;
    return {
    id: `group-edge:${from}->${to}`, source: groupPrefix + from, target: groupPrefix + to, type: 'default',
    selectable: false, deletable: false, zIndex: rootsOnly ? -3 : -1,
    className: edgeFocusClass(mode === 'overview' && focused), label: groupEdgeLabel(mode, focused, count),
    markerEnd: groupEdgeMarker(stroke, rootsOnly), style: groupEdgeStyle(stroke, mode, focused, hoveredGroup),
    ...edgeLabelStyles(theme, rootsOnly),
  };
  });
}

export function hierarchyEdges(blocks: CanvasBlock[], theme: Theme, nodeForBlock: (block: CanvasBlock) => string | undefined, hoveredGroup: string | null): Edge[] {
  const byId = new Map(blocks.map(block => [block.id, nodeForBlock(block)]));
  return [...groupLinkCounts(blocks, byId)].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    const focused = hoveredGroup === from || hoveredGroup === to;
    const stroke = theme === 'dark' ? '#A7C7C0' : '#557B79';
    return {
    id: `group-edge:${from}->${to}`, source: groupPrefix + from, target: groupPrefix + to, type: 'default',
    selectable: false, deletable: false, zIndex: -3, className: edgeFocusClass(focused),
    label: focused ? linkCountLabel(count) : undefined, markerEnd: groupEdgeMarker(stroke, true),
    style: { stroke, strokeWidth: focused ? 8 : 6, opacity: overviewOpacity(hoveredGroup, focused, [1, .2, .82]) },
    ...edgeLabelStyles(theme, true),
  };
  });
}

export function contains(frame: Frame, x: number, y: number, margin = 0): boolean {
  return x >= frame.x - margin && x <= frame.x + frame.width + margin && y >= frame.y - margin && y <= frame.y + frame.height + margin;
}

export function groupLabelPatch(group: string | null): Partial<CanvasBlock> {
  if (!group) return {};
  const [prefix, value = ''] = group.split(':');
  const rootValue = value.split('/')[0];
  if (prefix === 'area' && rootValue !== 'other') return { workArea: rootValue };
  if (prefix === 'purpose' && rootValue !== 'other') return { purpose: rootValue };
  return {};
}
