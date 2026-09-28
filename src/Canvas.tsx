import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { workAreaLabel } from '../shared/work-areas';
import { groupLabel, groupPath, groupTone, normalizedGroup } from '../shared/groups';
import type { CanvasViewFocus } from '../shared/answer-canvas';
import { browserActor } from './api';
import { BlockContent } from './Loaders';
import { CanvasInspector } from './canvas-inspector';
import { CanvasDrillBoard, CanvasOverview } from './CanvasOverview';
import { FocusBlock, FocusPoint, ViewRequest } from './CanvasViewRequests';
import { arrangeConnected, focusedEdges, pullNeighbors, relatedIds } from './canvas-interactions';
import { makeSupergroups } from './canvas-hierarchy';
import type { Theme } from './theme';
import './canvas.css';

type CanvasNodeData = Record<string, unknown> & {
  block: CanvasBlock;
  canvasId: string;
  onUpdateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void>;
  onOpenBlock: (block: CanvasBlock) => void;
  onReadBlock: (block: CanvasBlock) => void;
  onHistoryBlock: (block: CanvasBlock) => void;
  onOpenCrossLink: (canvasId: string, blockId: string) => void;
  onFindDuplicates: (blockId: string) => void;
  onAnalyzeBlock: (blockId: string, focus: 'related' | 'conflicts' | 'labels') => void;
  crossLinkLabels?: Record<string, string>;
  onResize: (blockId: string, patch: Partial<CanvasBlock>) => void;
  onError: (message: string) => void;
  highlighted: boolean;
  dimmed?: boolean;
  searchMatch?: boolean;
  activeSearch?: boolean;
  detail?: 'full' | 'titles';
};

type GroupNodeData = Record<string, unknown> & { group: string; title: string; count: number; tone: number; width: number; height: number; depth: number; collapsed: boolean; overview: boolean; kind?: 'super' | 'files'; topTitles: string[]; onDrill: (group: string) => void; onCollapse: (group: string) => void; onHover: (group: string | null) => void };

type CanvasNode = Node<CanvasNodeData, 'document'>;
type GroupNode = Node<GroupNodeData, 'groupFrame'>;
type FlowNode = CanvasNode | GroupNode;

export type BlockPosition = { blockId: string; x: number; y: number; group?: string | null };

const framePadding = 28;
const frameHeader = 65;
const groupPrefix = 'group:';
const maxRememberedViewports = 8;
function rememberViewport(viewports: Map<string, Viewport>, canvasId: string, viewport: Viewport): void {
  viewports.delete(canvasId);
  viewports.set(canvasId, viewport);
  if (viewports.size > maxRememberedViewports) viewports.delete(viewports.keys().next().value!);
}
function labelTone(value: string): number {
  return [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 6;
}

function LockBadge({ block }: { block: CanvasBlock }) {
  if (!block.lock || block.lock.owner === browserActor) return null;
  const until = new Date(block.lock.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return <em className="canvas-card__lock" title={`${block.lock.owner} is editing until ${until}${block.lock.note ? ` — ${block.lock.note}` : ''}`}>● {block.lock.owner} editing</em>;
}

const DocumentNode = memo(function DocumentNode({ data, selected }: NodeProps<CanvasNode>) {
  const { block, canvasId, onUpdateBlock, onOpenBlock, onReadBlock, onHistoryBlock, onOpenCrossLink, onFindDuplicates, onAnalyzeBlock, onResize, onError } = data;
  const [menuOpen, setMenuOpen] = useState(false);
  const quality = block.quality && Number.isFinite(block.quality.score) ? Math.max(0, Math.min(1, block.quality.score)) : undefined;
  const portals = block.crossLinks ?? [];

  return (
    <article className={`canvas-card canvas-card--${block.kind}${selected ? ' is-selected' : ''}${data.highlighted || data.activeSearch ? ' is-highlighted' : ''}${data.searchMatch ? ' is-search-match' : ''}${data.dimmed ? ' is-dimmed' : ''}${data.detail === 'titles' ? ' is-title-only' : ''}${block.lock ? ' is-locked' : ''}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={280}
        minHeight={200}
        color="var(--sk-focus)"
        onResizeEnd={(_, dimensions) => onResize(block.id, dimensions)}
      />
      <Handle type="target" position={Position.Left} className="canvas-handle" />
      <header className="canvas-card__header">
        <span className="canvas-card__grip" aria-hidden="true">⠿</span>
        <div className="canvas-card__identity">
          <strong>{block.title}</strong>
          <small>{block.file}</small>
          {(block.purpose || block.workArea || block.reviewer || block.lock || quality !== undefined) && <span className="canvas-card__metadata">
            <LockBadge block={block}/>
            {block.purpose && <em className="canvas-card__purpose" data-purpose={block.purpose} title={`Purpose: ${block.purpose}`}>{block.purpose}</em>}
            {block.workArea && <em className={`canvas-card__work-area canvas-card__work-area--${labelTone(block.workArea)}`} title={`Work area: ${workAreaLabel(block.workArea)}`}>{workAreaLabel(block.workArea)}</em>}
            {block.reviewer && <em className="canvas-card__reviewer" title={`Reviewer: ${block.reviewer}`}>Review: {block.reviewer}</em>}
            {quality !== undefined && <span className="canvas-card__quality" title={`Document quality: ${Math.round(quality * 100)}%`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap', fontSize: 9, color: 'var(--sk-muted)' }}>
              Quality <meter min={0} max={1} value={quality} aria-label={`Quality for ${block.title}`} style={{ width: 36, height: 7 }}/>{Math.round(quality * 100)}%
            </span>}
          </span>}
        </div>
        {portals.length > 0 && data.detail !== 'titles' && <span className="canvas-card__portal-count" title={`${portals.length} cross-canvas ${portals.length === 1 ? 'link' : 'links'}`} style={{ borderRadius: 8, padding: '2px 5px', background: 'var(--sk-surface-soft)', color: 'var(--sk-link)', fontSize: 10, fontWeight: 700 }}>↗ {portals.length}</span>}
        <span className="canvas-card__kind">{block.kind}</span>
        <button className="canvas-card__edit nodrag" title="Open full page" aria-label={`Read ${block.title} full page`} onClick={() => onReadBlock(block)}>↗</button>
        <button className="canvas-card__edit nodrag" title="File history" aria-label={`History for ${block.title}`} onClick={() => onHistoryBlock(block)}>⑂</button>
        <button className="canvas-card__edit nodrag" title="Edit Markdown file" aria-label={`Edit ${block.title}`} onClick={() => onOpenBlock(block)}>✎</button>
        <span className="nodrag" style={{ position: 'relative' }}>
          <button type="button" className="canvas-card__edit nodrag" title="Document actions" aria-label={`Actions for ${block.title}`}
            aria-expanded={menuOpen} onClick={event => { event.stopPropagation(); setMenuOpen(value => !value); }}>⋯</button>
          {menuOpen && <span role="menu" className="canvas-card__actions-menu" onKeyDown={event => {
            if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); }
          }}>
            {([['related', 'Find related documents'], ['conflicts', 'Check for conflicts'], ['labels', 'Suggest labels']] as const).map(([focus, label]) =>
              <button key={focus} type="button" role="menuitem" className="nodrag"
                onClick={event => { event.stopPropagation(); setMenuOpen(false); onAnalyzeBlock(block.id, focus); }}>{label}</button>)}
            <button type="button" role="menuitem" className="nodrag"
              onClick={event => { event.stopPropagation(); setMenuOpen(false); onFindDuplicates(block.id); }}>Find duplicates of this document</button>
          </span>}
        </span>
      </header>
      {data.detail !== 'titles' && <div className="canvas-card__body nowheel nodrag" onDoubleClick={(event) => event.stopPropagation()}>
        <BlockContent block={block} canvasId={canvasId} onUpdateBlock={onUpdateBlock} onError={onError} />
      </div>}
      {portals.length > 0 && data.detail !== 'titles' && <div className="canvas-card__portals nodrag" aria-label={`Related documents on other canvases for ${block.title}`} style={{ display: 'flex', gap: 4, padding: '5px 8px', overflowX: 'auto', borderTop: '1px solid var(--sk-border)' }}>
        {portals.slice(0, 2).map(link => <button key={`${link.canvasId}:${link.blockId}`} type="button" className="canvas-card__portal nodrag"
          aria-label={`Open related document ${link.blockId} on canvas ${link.canvasId}`}
          title={`Open ${link.blockId} on canvas ${link.canvasId}`}
          style={{ flex: '0 0 auto', border: '1px solid var(--sk-border)', borderRadius: 6, background: 'var(--sk-surface-soft)', color: 'var(--sk-link)', padding: '2px 5px', fontSize: 10, cursor: 'pointer' }}
          onClick={event => { event.stopPropagation(); onOpenCrossLink(link.canvasId, link.blockId); }}>
          ↗ Other canvas: {data.crossLinkLabels?.[`${link.canvasId}:${link.blockId}`] ?? link.canvasId}
        </button>)}
        {portals.length > 2 && <span style={{ whiteSpace: 'nowrap', fontSize: 10, alignSelf: 'center' }}>+{portals.length - 2} more</span>}
      </div>}
      <Handle type="source" position={Position.Right} className="canvas-handle" />
    </article>
  );
}, (previous, next) => previous.selected === next.selected && previous.data === next.data);

/** A group frame behind its cards. Drag the heading to move the whole group. */
const GroupFrameNode = memo(function GroupFrameNode({ data }: NodeProps<GroupNode>) {
  const noun = data.kind === 'super' ? (data.count === 1 ? 'group' : 'groups') : 'documents';
  return <div className={`canvas-group canvas-group--tone-${data.tone}${data.overview ? ' is-overview' : ''}${data.collapsed ? ' is-collapsed' : ''}${data.kind ? ` is-${data.kind}` : ''}`} style={{ width: data.width, height: data.height }}
    data-canvas-group={data.group}
    onClick={() => { if (data.overview) data.onDrill(data.group); }}
    onMouseEnter={() => { if (data.overview) data.onHover(data.group); }}
    onMouseLeave={() => { if (data.overview) data.onHover(null); }}
    aria-label={`${data.title} ${data.kind === 'super' ? 'supergroup' : 'group'}, ${data.count} ${noun}`}>
    <Handle type="target" position={Position.Left} className="canvas-group__handle" isConnectable={false}/>
    <span className="canvas-group__heading" title={data.overview ? `Open ${data.title}` : 'Drag to move this group'} onMouseEnter={() => { if (data.overview) data.onHover(data.group); }} onMouseLeave={() => { if (data.overview) data.onHover(null); }}><span className="canvas-group__dot"/><button type="button" className="nodrag" onClick={event => { event.stopPropagation(); data.onDrill(data.group); }} title={`Open ${data.title}`}>{data.title}</button><small>{data.count} {data.kind === 'super' ? data.count === 1 ? 'group' : 'groups' : data.count === 1 ? 'doc' : 'docs'}</small>{!data.overview && <button type="button" className="nodrag canvas-group__toggle" aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.title}`} onClick={event => { event.stopPropagation(); data.onCollapse(data.group); }}>{data.collapsed ? '+' : '−'}</button>}</span>
    {(data.overview || data.collapsed) && <div className="canvas-group__summary">{data.topTitles.map(title => <span key={title}>{title}</span>)}</div>}
    <Handle type="source" position={Position.Right} className="canvas-group__handle" isConnectable={false}/>
  </div>;
}, (previous, next) => {
  const before = previous.data;
  const after = next.data;
  return before === after || (before.group === after.group && before.title === after.title && before.count === after.count
    && before.tone === after.tone && before.width === after.width && before.height === after.height && before.depth === after.depth
    && before.collapsed === after.collapsed && before.overview === after.overview && before.kind === after.kind && before.onDrill === after.onDrill
    && before.onCollapse === after.onCollapse && before.onHover === after.onHover && before.topTitles.length === after.topTitles.length
    && before.topTitles.every((title, index) => title === after.topTitles[index]));
});

const nodeTypes = { document: DocumentNode, groupFrame: GroupFrameNode };

function makeNodes(
  canvasId: string,
  blocks: CanvasBlock[],
  onUpdateBlock: CanvasNodeData['onUpdateBlock'],
  onOpenBlock: CanvasNodeData['onOpenBlock'],
  onReadBlock: CanvasNodeData['onReadBlock'],
  onHistoryBlock: CanvasNodeData['onHistoryBlock'],
  onOpenCrossLink: CanvasNodeData['onOpenCrossLink'],
  onFindDuplicates: CanvasNodeData['onFindDuplicates'],
  onAnalyzeBlock: CanvasNodeData['onAnalyzeBlock'],
  onResize: CanvasNodeData['onResize'],
  onError: CanvasNodeData['onError'],
  highlightedId?: string,
): CanvasNode[] {
  return blocks.map((block) => ({
    id: block.id,
    type: 'document',
    position: { x: block.x, y: block.y },
    width: block.width,
    height: block.height,
    style: { width: block.width, height: block.height },
    data: { block, canvasId, onUpdateBlock, onOpenBlock, onReadBlock, onHistoryBlock, onOpenCrossLink, onFindDuplicates, onAnalyzeBlock, onResize, onError, highlighted: block.id === highlightedId },
  }));
}

function makeEdges(blocks: CanvasBlock[], theme: Theme): Edge[] {
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

type Frame = { id: string; group: string; title: string; count: number; tone: number; depth: number; x: number; y: number; width: number; height: number; members: string[]; topTitles: string[]; kind?: 'super' | 'files' };

function blockGroup(block: CanvasBlock): string | undefined { return normalizedGroup(block.group); }

/** Frames follow the live card positions, so they move while cards or whole groups are dragged. */
function frames(blocks: CanvasBlock[], positions: Map<string, { x: number; y: number; width: number; height: number }>): Frame[] {
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
    const inset = framePadding * (depth + 1);
    return { id: groupPrefix + group, group, title: group === '__ungrouped' ? 'Ungrouped' : groupLabel(group), count: members.length, tone: group === '__ungrouped' ? 7 : groupTone(group), depth,
      x: left - inset, y: top - frameHeader - depth * 48, width: right - left + inset * 2, height: bottom - top + frameHeader + framePadding + depth * 48, members: members.map(block => block.id), topTitles: members.slice(0, 3).map(block => block.title) };
  });
}

function frameNodes(list: Frame[], collapsed: Set<string>, overview: boolean, onDrill: (group: string) => void, onCollapse: (group: string) => void, onHover: (group: string | null) => void): GroupNode[] {
  return list.map(frame => ({
    id: frame.id, type: 'groupFrame', position: { x: frame.x, y: frame.y }, zIndex: -2 - frame.depth, selectable: false, connectable: false,
    draggable: !overview,
    dragHandle: '.canvas-group__heading', className: `canvas-group-node${overview ? ' is-map-node' : ''}`, width: collapsed.has(frame.group) ? 380 : frame.width, height: collapsed.has(frame.group) ? 190 : frame.height,
    data: { group: frame.group, title: frame.title, count: frame.count, tone: frame.tone, width: collapsed.has(frame.group) ? 380 : frame.width, height: collapsed.has(frame.group) ? 190 : frame.height, depth: frame.depth, collapsed: collapsed.has(frame.group), overview, kind: frame.kind, topTitles: frame.topTitles, onDrill, onCollapse, onHover },
  }));
}

/** One edge per pair of groups with links between them, labeled with how many links it stands for. */
function groupEdges(blocks: CanvasBlock[], theme: Theme, mode: 'full' | 'titles' | 'overview' = 'full', hoveredGroup: string | null = null): Edge[] {
  const rootsOnly = mode !== 'full';
  const groupOf = new Map(blocks.map(block => {
    const group = blockGroup(block) ?? '__ungrouped';
    return [block.id, rootsOnly ? groupPath(group)[0] : group];
  }));
  const counts = new Map<string, number>();
  for (const block of blocks) for (const target of block.links) {
    const from = groupOf.get(block.id);
    const to = groupOf.get(target);
    if (from && to && from !== to) counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    const stroke = theme === 'dark' ? '#7D9E9D' : '#819995';
    const focused = hoveredGroup === from || hoveredGroup === to;
    return { id: `group-edge:${from}->${to}`, source: groupPrefix + from, target: groupPrefix + to, type: 'default', selectable: false, deletable: false,
      zIndex: rootsOnly ? -3 : -1, className: `canvas-group-edge${mode === 'overview' && focused ? ' is-focused' : ''}`, label: mode !== 'overview' || focused ? `${count} ${count === 1 ? 'link' : 'links'}` : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: rootsOnly ? 14 : 18, height: rootsOnly ? 14 : 18 },
      style: { stroke, strokeWidth: mode === 'overview' ? focused ? 7 : 4 : rootsOnly ? 6 : 3, strokeDasharray: mode === 'overview' ? undefined : rootsOnly ? '18 14' : '7 7', opacity: mode === 'overview' ? hoveredGroup ? focused ? .9 : .1 : .55 : 1 },
      labelStyle: { fill: theme === 'dark' ? '#EAF1ED' : '#43595A', fontWeight: 700, fontSize: rootsOnly ? 34 : 11 },
      labelBgStyle: { fill: theme === 'dark' ? '#1C2E34' : '#F7F5EF' }, labelBgPadding: rootsOnly ? [15, 8] as [number, number] : [6, 3] as [number, number], labelBgBorderRadius: 6 };
  });
}

/** Aggregate document links at the currently visible hierarchy level. */
function hierarchyEdges(blocks: CanvasBlock[], theme: Theme, nodeForBlock: (block: CanvasBlock) => string | undefined, hoveredGroup: string | null): Edge[] {
  const byId = new Map(blocks.map(block => [block.id, nodeForBlock(block)]));
  const counts = new Map<string, number>();
  for (const block of blocks) for (const target of block.links) {
    const from = byId.get(block.id);
    const to = byId.get(target);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    const focused = hoveredGroup === from || hoveredGroup === to;
    const stroke = theme === 'dark' ? '#A7C7C0' : '#557B79';
    return { id: `group-edge:${from}->${to}`, source: groupPrefix + from, target: groupPrefix + to,
      type: 'default', selectable: false, deletable: false, zIndex: -3,
      className: `canvas-group-edge${focused ? ' is-focused' : ''}`,
      label: focused ? `${count} ${count === 1 ? 'link' : 'links'}` : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
      style: { stroke, strokeWidth: focused ? 7 : 4, opacity: hoveredGroup ? focused ? .95 : .12 : .58 },
      labelStyle: { fill: theme === 'dark' ? '#EAF1ED' : '#43595A', fontWeight: 700, fontSize: 34 },
      labelBgStyle: { fill: theme === 'dark' ? '#1C2E34' : '#F7F5EF' },
      labelBgPadding: [15, 8] as [number, number], labelBgBorderRadius: 6 };
  });
}

function contains(frame: Frame, x: number, y: number, margin = 0): boolean {
  return x >= frame.x - margin && x <= frame.x + frame.width + margin && y >= frame.y - margin && y <= frame.y + frame.height + margin;
}

/** Labels that follow a document's group, so dragging a card into "Sales" also labels it sales. */
function groupLabelPatch(group: string | null): Partial<CanvasBlock> {
  if (!group) return {};
  const [prefix, value = ''] = group.split(':');
  const rootValue = value.split('/')[0];
  if (prefix === 'area' && rootValue !== 'other') return { workArea: rootValue };
  if (prefix === 'purpose' && rootValue !== 'other') return { purpose: rootValue };
  return {};
}

export interface CanvasProps {
  canvas: CanvasDocument;
  theme?: Theme;
  onUpdateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void>;
  onDeleteBlock: (blockId: string) => Promise<void>;
  onSelectBlock: (block: CanvasBlock) => void;
  onReadBlock?: (block: CanvasBlock) => void;
  onHistoryBlock?: (block: CanvasBlock) => void;
  onOpenCrossLink?: (canvasId: string, blockId: string) => void;
  onFindDuplicates?: (blockId: string) => void;
  onAnalyzeBlock?: (blockId: string, focus: 'related' | 'conflicts' | 'labels') => void;
  crossLinkLabels?: Record<string, string>;
  onMoveBlocks?: (positions: BlockPosition[]) => Promise<void>;
  focusRequest?: { blockId: string; sequence: number };
  groupFocusRequest?: { canvasId: string; group: string; sequence: number };
  searchQuery?: string;
  searchMatchIds?: string[];
  activeSearchId?: string;
  onSummarizeSelection?: (blocks: CanvasBlock[]) => void;
  onSelectionChange?: (blocks: CanvasBlock[]) => void;
  onViewportChange?: (viewport: Viewport, visibleBlockIds: string[], focus: CanvasViewFocus) => void;
  viewportRequest?: Viewport & { sequence: number };
  previewGroups?: Record<string, string>;
  focusZoom?: number;
  focusSelect?: boolean;
}

export function Canvas({ canvas, theme = 'light', onUpdateBlock, onDeleteBlock, onSelectBlock, onReadBlock = onSelectBlock, onHistoryBlock = onSelectBlock, onOpenCrossLink, onFindDuplicates, onAnalyzeBlock, crossLinkLabels, onMoveBlocks, focusRequest, groupFocusRequest, searchQuery = '', searchMatchIds = [], activeSearchId, onSummarizeSelection, onSelectionChange, onViewportChange, viewportRequest, previewGroups, focusZoom, focusSelect = true }: CanvasProps) {
  const { id: canvasId, blocks } = canvas;
  const [message, setMessage] = useState('');
  const [highlightedId, setHighlightedId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [mapPinned, setMapPinned] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [focusHops, setFocusHops] = useState<1 | 2>(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drillGroup, setDrillGroup] = useState('');
  const [activeSupergroup, setActiveSupergroup] = useState('');
  const [mapParent, setMapParent] = useState('');
  const [mapColumns, setMapColumns] = useState(2);
  const [showDrillBoard, setShowDrillBoard] = useState(false);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  const [pointRequest, setPointRequest] = useState<{ x: number; y: number; zoom: number; sequence: number }>();
  const pointSequence = useRef(0);
  const [arrangePreview, setArrangePreview] = useState(false);
  const [pullActive, setPullActive] = useState(false);
  const flowInstance = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);
  const rememberedViewports = useRef(new Map<string, Viewport>());
  const surface = useRef<HTMLElement>(null);
  const zoomBand = useRef<'overview' | 'titles' | 'full'>('full');
  const enteringFiles = useRef(false);
  const focusTransition = useRef(0);
  const appliedFocusSequence = useRef<number | undefined>(undefined);
  const centeredFocusSequence = useRef<number | undefined>(undefined);
  const zoomIntent = useRef<'in' | 'out' | null>(null);
  const zoomTarget = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [nodeSource, setNodeSource] = useState<{ canvasId: string; blocks: CanvasBlock[] } | null>(null);
  const selectionCallback = useRef(onSelectionChange);
  selectionCallback.current = onSelectionChange;
  const viewportCallback = useRef(onViewportChange);
  viewportCallback.current = onViewportChange;
  const lastSelection = useRef('');
  useEffect(() => {
    const element = surface.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const columns = entry.contentRect.width >= 900 ? 3 : entry.contentRect.width >= 520 ? 2 : 1;
      setMapColumns(previous => previous === columns ? previous : columns);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const viewBlocks = useMemo(() => previewGroups ? blocks.map(block => previewGroups[block.id] ? { ...block, group: previewGroups[block.id] } : block) : blocks, [blocks, previewGroups]);
  const zoomLevel = mapPinned || zoom < 0.34 ? 'overview' : zoom < 0.75 ? 'titles' : 'full';
  const searchIds = useMemo(() => new Set(searchMatchIds), [searchMatchIds]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const focusIds = useMemo(() => selectedIds.length === 1 ? relatedIds(blocks, selectedIds[0], focusHops) : null, [blocks, selectedIds, focusHops]);
  const livePositions = useMemo(() => new Map(nodes.filter(node => node.data.canvasId === canvasId).map(node => [node.id, {
    x: node.position.x, y: node.position.y, width: node.width ?? node.data.block.width, height: node.height ?? node.data.block.height,
  }])), [canvasId, nodes]);
  const groupFrames = useMemo(() => frames(viewBlocks, livePositions), [viewBlocks, livePositions]);
  const supergroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const block of viewBlocks) {
      const root = groupPath(normalizedGroup(block.group) ?? '__ungrouped')[0];
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
    return makeSupergroups([...counts].map(([group, count]) => ({ group, count, title: group === '__ungrouped' ? 'Ungrouped' : groupLabel(group), tone: group === '__ungrouped' ? 7 : groupTone(group) })), viewBlocks);
  }, [viewBlocks]);
  const supergroupByRoot = useMemo(() => new Map(supergroups.flatMap(supergroup => supergroup.rootGroups.map(group => [group, supergroup.id] as const))), [supergroups]);
  const activeSuper = supergroups.find(supergroup => supergroup.id === activeSupergroup);
  const mapFrames = useMemo<Frame[]>(() => {
    if (mapParent) {
      const parentPath = groupPath(mapParent);
      const children = groupFrames.filter(frame => {
        const path = groupPath(frame.group);
        return path.length === parentPath.length + 1 && path[parentPath.length - 1] === mapParent;
      });
      const direct = viewBlocks.filter(block => (normalizedGroup(block.group) ?? '__ungrouped') === mapParent);
      const directFrame: Frame[] = direct.length && children.length ? [{ id: groupPrefix + `files:${mapParent}`, group: `files:${mapParent}`, title: 'Files in this group', count: direct.length,
        tone: groupTone(mapParent), depth: 0, x: 0, y: 0, width: 820, height: 550, members: direct.map(block => block.id), topTitles: direct.slice(0, 3).map(block => block.title), kind: 'files' }] : [];
      return [...children, ...directFrame];
    }
    if (activeSuper) return groupFrames.filter(frame => frame.depth === 0 && activeSuper.rootGroups.includes(frame.group));
    if (supergroups.length) return supergroups.map(supergroup => ({ id: groupPrefix + supergroup.id, group: supergroup.id, title: supergroup.title, count: supergroup.rootGroups.length,
      tone: supergroup.tone, depth: 0, x: 0, y: 0, width: 820, height: 550, members: [], topTitles: supergroup.topTitles.slice(0, 3), kind: 'super' }));
    return groupFrames.filter(frame => frame.depth === 0);
  }, [mapParent, groupFrames, viewBlocks, activeSuper, supergroups]);
  const mapGroupForBlock = useCallback((block: CanvasBlock): string | undefined => {
    const group = normalizedGroup(block.group) ?? '__ungrouped';
    const path = groupPath(group);
    if (mapParent) {
      const parentDepth = groupPath(mapParent).length;
      if (path[parentDepth - 1] !== mapParent) return undefined;
      return path[parentDepth] ?? `files:${mapParent}`;
    }
    const root = path[0];
    if (activeSuper) return activeSuper.rootGroups.includes(root) ? root : undefined;
    return supergroups.length ? supergroupByRoot.get(root) : root;
  }, [mapParent, activeSuper, supergroups.length, supergroupByRoot]);
  const edges = useMemo(() => {
    if (zoomLevel === 'overview') return hierarchyEdges(viewBlocks, theme, mapGroupForBlock, hoveredGroup);
    if (zoomLevel === 'titles') return groupEdges(viewBlocks, theme, zoomLevel, hoveredGroup);
    const links = makeEdges(viewBlocks, theme);
    if (focusIds) return links.filter(edge => focusIds.has(edge.source) && focusIds.has(edge.target)).map(edge => ({ ...edge, style: { ...edge.style, strokeWidth: 3, opacity: 1 } }));
    if (searchQuery.trim()) return focusedEdges(links, activeSearchId ? relatedIds(viewBlocks, activeSearchId, 1) : new Set<string>());
    return [...groupEdges(viewBlocks, theme), ...links.map(edge => ({ ...edge, style: { ...edge.style, opacity: 0.14 } }))];
  }, [viewBlocks, theme, zoomLevel, hoveredGroup, focusIds, searchQuery, activeSearchId, mapGroupForBlock]);
  const visibleFrames = useMemo(() => groupFrames.filter(frame => !drillGroup || frame.group === drillGroup || groupPath(frame.group).includes(drillGroup)), [groupFrames, drillGroup]);
  const viewFocus = useMemo<CanvasViewFocus>(() => ({
    level: zoomLevel === 'overview' ? mapParent ? 'subgroups' : 'groups' : zoomLevel === 'titles' ? 'groups' : 'documents',
    activeGroup: drillGroup || mapParent || undefined,
    visibleGroups: (zoomLevel === 'overview' ? mapFrames.flatMap(frame => frame.kind === 'super'
      ? supergroups.find(supergroup => supergroup.id === frame.group)?.rootGroups ?? [] : [frame.group.replace(/^files:/u, '')])
      : visibleFrames.map(frame => frame.group)).filter((group, index, groups) => groups.indexOf(group) === index).slice(0, 16),
  }), [zoomLevel, mapParent, drillGroup, mapFrames, supergroups, visibleFrames]);
  const selectedBlocks = useMemo(() => blocks.filter(block => selectedIdSet.has(block.id)), [blocks, selectedIdSet]);
  const focusGroup = useCallback((group: string) => {
    enteringFiles.current = true;
    const transition = ++focusTransition.current;
    window.setTimeout(() => { if (focusTransition.current === transition) enteringFiles.current = false; }, 650);
    setMapPinned(false);
    setHoveredGroup(null);
    setDrillGroup(group);
    setShowDrillBoard(false);
    setSelectedIds([]);
    setNodes(current => current.map(node => ({ ...node, selected: false })));
    lastSelection.current = '';
    setCollapsed(current => { const next = new Set(current); for (const path of groupPath(group)) next.delete(path); return next; });
    const frame = framesRef.current.find(item => item.group === group);
    if (frame) setPointRequest({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2, zoom: 0.8, sequence: ++pointSequence.current });
  }, []);
  const openHierarchyGroup = useCallback((group: string) => {
    setHoveredGroup(null);
    if (group.startsWith('super:')) {
      setActiveSupergroup(group);
      setMapParent('');
      setDrillGroup('');
      return;
    }
    if (group.startsWith('files:')) {
      focusGroup(group.slice('files:'.length));
      return;
    }
    if (supergroups.length) setActiveSupergroup(supergroupByRoot.get(groupPath(group)[0]) ?? '');
    const depth = groupPath(group).length;
    const hasChildren = groupFrames.some(frame => {
      const path = groupPath(frame.group);
      return path.length === depth + 1 && path[depth - 1] === group;
    });
    if (hasChildren && zoomLevel === 'overview') {
      setMapParent(group);
      setDrillGroup('');
    } else focusGroup(group);
  }, [focusGroup, groupFrames, zoomLevel, supergroups.length, supergroupByRoot]);
  const lastGroupFocus = useRef(0);
  useEffect(() => {
    if (!groupFocusRequest || groupFocusRequest.canvasId !== canvasId || lastGroupFocus.current === groupFocusRequest.sequence) return;
    if (!viewBlocks.some(block => groupPath(normalizedGroup(block.group) ?? '__ungrouped').includes(groupFocusRequest.group))) return;
    lastGroupFocus.current = groupFocusRequest.sequence;
    focusGroup(groupFocusRequest.group);
  }, [groupFocusRequest, canvasId, viewBlocks, focusGroup]);
  const returnOverview = useCallback(() => {
    focusTransition.current++;
    enteringFiles.current = false;
    setMapPinned(true);
    setDrillGroup('');
    setShowDrillBoard(false);
    setMapParent('');
    setActiveSupergroup('');
    setSelectedIds([]);
    setNodes(current => current.map(node => ({ ...node, selected: false })));
    lastSelection.current = '';
    void flowInstance.current?.setViewport({ x: 24, y: 68, zoom: 0.28 }, { duration: 250 });
  }, []);
  const toggleGroup = useCallback((group: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  }), []);
  const decoratedNodes = useRef(new Map<string, { source: CanvasNode; labels?: Record<string, string>; highlighted: boolean; searchMatch: boolean; activeSearch: boolean; dimmed: boolean; detail: 'full' | 'titles'; output: CanvasNode }>());
  const flowNodes = useMemo<FlowNode[]>(() => {
    const framesToShow = visibleFrames.filter(frame => zoomLevel === 'overview' ? frame.depth === 0
      : !groupPath(frame.group).slice(0, -1).some(parent => collapsed.has(parent)));
    const groups = new Map(viewBlocks.map(block => [block.id, normalizedGroup(block.group)]));
    const nextDecorated = new Map<typeof nodes[number]['id'], NonNullable<ReturnType<typeof decoratedNodes.current.get>>>();
    const shownDocuments = zoomLevel === 'overview' ? [] : nodes.filter(node => {
      if (node.data.canvasId !== canvasId) return false;
      const group = groups.get(node.id);
      if (group && groupPath(group).some(path => collapsed.has(path))) return false;
      if (!group && collapsed.has('__ungrouped')) return false;
      return !drillGroup || (group && groupPath(group).includes(drillGroup)) || (!group && drillGroup === '__ungrouped');
    }).map(node => {
      const highlighted = node.id === highlightedId;
      const searchMatch = searchIds.has(node.id);
      const activeSearch = node.id === activeSearchId;
      const dimmed = searchQuery.trim() ? !searchMatch : Boolean(focusIds && !focusIds.has(node.id));
      const detail: 'titles' | 'full' = zoomLevel === 'titles' ? 'titles' : 'full';
      const previous = decoratedNodes.current.get(node.id);
      const sameDecoration = previous?.source.data === node.data && previous.labels === crossLinkLabels && previous.highlighted === highlighted
        && previous.searchMatch === searchMatch && previous.activeSearch === activeSearch && previous.dimmed === dimmed && previous.detail === detail;
      const output = sameDecoration && previous.source === node ? previous.output
        : { ...node, data: sameDecoration ? previous.output.data
          : { ...node.data, crossLinkLabels, highlighted, searchMatch, activeSearch, dimmed, detail } };
      nextDecorated.set(node.id, { source: node, labels: crossLinkLabels, highlighted, searchMatch, activeSearch, dimmed, detail, output });
      return output;
    });
    decoratedNodes.current = nextDecorated;
    const arrangedFrames = zoomLevel === 'overview' ? mapFrames.map((frame, index) => ({
      ...frame, topTitles: frame.topTitles.slice(0, 3), x: (index % mapColumns) * 1100, y: Math.floor(index / mapColumns) * 740, width: 820, height: 550,
    })) : framesToShow;
    return [...shownDocuments, ...frameNodes(arrangedFrames, collapsed, zoomLevel === 'overview', zoomLevel === 'overview' ? openHierarchyGroup : focusGroup, toggleGroup, setHoveredGroup)];
  }, [canvasId, visibleFrames, mapFrames, mapColumns, collapsed, zoomLevel, nodes, viewBlocks, crossLinkLabels, drillGroup, highlightedId, searchIds, activeSearchId, searchQuery, focusIds, focusGroup, openHierarchyGroup, toggleGroup]);
  const framesRef = useRef(groupFrames);
  framesRef.current = groupFrames;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const onSelectBlockRef = useRef(onSelectBlock);
  onSelectBlockRef.current = onSelectBlock;
  const openBlock = useCallback((block: CanvasBlock) => onSelectBlockRef.current(block), []);
  const onReadBlockRef = useRef(onReadBlock);
  onReadBlockRef.current = onReadBlock;
  const readBlock = useCallback((block: CanvasBlock) => onReadBlockRef.current(block), []);
  const onHistoryBlockRef = useRef(onHistoryBlock);
  onHistoryBlockRef.current = onHistoryBlock;
  const historyBlock = useCallback((block: CanvasBlock) => onHistoryBlockRef.current(block), []);
  const onOpenCrossLinkRef = useRef(onOpenCrossLink);
  onOpenCrossLinkRef.current = onOpenCrossLink;
  const openCrossLink = useCallback((targetCanvasId: string, blockId: string) => onOpenCrossLinkRef.current?.(targetCanvasId, blockId), []);
  const onFindDuplicatesRef = useRef(onFindDuplicates);
  onFindDuplicatesRef.current = onFindDuplicates;
  const findDuplicates = useCallback((blockId: string) => onFindDuplicatesRef.current?.(blockId), []);
  const onAnalyzeBlockRef = useRef(onAnalyzeBlock);
  onAnalyzeBlockRef.current = onAnalyzeBlock;
  const analyzeBlock = useCallback((blockId: string, focus: 'related' | 'conflicts' | 'labels') => onAnalyzeBlockRef.current?.(blockId, focus), []);

  const reportError = useCallback((reason: string) => setMessage(reason), []);
  const updateBlockRef = useRef(onUpdateBlock);
  updateBlockRef.current = onUpdateBlock;
  const saveBlock = useCallback(async (blockId: string, patch: Partial<CanvasBlock>) => {
    try {
      setMessage('');
      await updateBlockRef.current(blockId, patch);
    } catch (error) {
      setMessage(error instanceof Error ? `Could not save: ${error.message}` : 'Could not save this change.');
      throw error;
    }
  }, []);

  const resizeBlock = useCallback((blockId: string, patch: Partial<CanvasBlock>) => {
    void saveBlock(blockId, patch).catch(() => undefined);
  }, [saveBlock]);

  useEffect(() => {
    if (!focusRequest) return;
    if (!focusSelect && appliedFocusSequence.current === focusRequest.sequence) return;
    const target = blocks.find(block => block.id === focusRequest.blockId);
    if (!target) return;
    if (!focusSelect) appliedFocusSequence.current = focusRequest.sequence;
    setHighlightedId(focusRequest.blockId);
    setSelectedIds(focusSelect ? [focusRequest.blockId] : []);
    setNodes(current => current.map(node => ({ ...node, selected: focusSelect && node.id === focusRequest.blockId })));
    if (focusSelect && lastSelection.current !== target.id) {
      lastSelection.current = target.id;
      selectionCallback.current?.([target]);
    }
    setCollapsed(current => {
      const next = new Set(current);
      for (const path of groupPath(normalizedGroup(target?.group) ?? '')) next.delete(path);
      return next;
    });
    setDrillGroup('');
    enteringFiles.current = true;
    const transition = ++focusTransition.current;
    window.setTimeout(() => { if (focusTransition.current === transition) enteringFiles.current = false; }, 650);
    setMapPinned(false);
    setShowDrillBoard(false);
    setActiveSupergroup('');
    setMapParent('');
    const timer = window.setTimeout(() => setHighlightedId(''), 2500);
    return () => window.clearTimeout(timer);
  }, [focusRequest?.sequence, blocks, setNodes, focusSelect]);

  useEffect(() => {
    if (focusSelect || !focusRequest) return;
    if (centeredFocusSequence.current === focusRequest.sequence) return;
    const target = blocks.find(block => block.id === focusRequest.blockId);
    if (!target) return;
    const timer = window.setTimeout(() => {
      if (!flowInstance.current) return;
      const stage = surface.current?.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
      const fittingZoom = stage ? Math.min((stage.width - 24) / target.width, (stage.height - 24) / target.height) : 1;
      centeredFocusSequence.current = focusRequest.sequence;
      void flowInstance.current.setCenter(target.x + target.width / 2, target.y + target.height / 2,
        { zoom: Math.max(0.28, Math.min(focusZoom ?? 1, fittingZoom)), duration: 350 });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [focusRequest?.sequence, focusSelect, focusZoom, blocks]);

  const previousCanvasView = useRef({ canvasId, viewportSequence: viewportRequest?.sequence, focusSequence: focusRequest?.sequence });
  useEffect(() => {
    const previous = previousCanvasView.current;
    previousCanvasView.current = { canvasId, viewportSequence: viewportRequest?.sequence, focusSequence: focusRequest?.sequence };
    if (previous.canvasId === canvasId) return;
    const leavingViewport = flowInstance.current?.getViewport();
    if (leavingViewport) rememberViewport(rememberedViewports.current, previous.canvasId, leavingViewport);
    // Bookmarked viewports and focused documents set their own destination after navigation.
    if (previous.viewportSequence !== viewportRequest?.sequence || previous.focusSequence !== focusRequest?.sequence) return;
    const remembered = rememberedViewports.current.get(canvasId);
    const frame = window.requestAnimationFrame(() => {
      if (remembered) void flowInstance.current?.setViewport(remembered, { duration: 0 });
      else void flowInstance.current?.fitView({ padding: 0.12, maxZoom: 1, duration: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasId, viewportRequest?.sequence, focusRequest?.sequence]);

  useEffect(() => {
    if (!mapPinned) return;
    const frame = window.requestAnimationFrame(() => {
      const instance = flowInstance.current;
      if (instance) void instance.setViewport({ x: 24, y: 68, zoom: 0.28 }, { duration: 250 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasId, mapPinned, activeSupergroup, mapParent]);

  const selectNodes = useCallback(({ nodes: chosen }: { nodes: FlowNode[] }) => {
    const ids = chosen.filter(node => node.type === 'document').map(node => node.id);
    const key = [...ids].sort().join('\u0000');
    if (lastSelection.current === key) return;
    lastSelection.current = key;
    setSelectedIds(ids);
    const target = ids.length === 1 ? blocks.find(block => block.id === ids[0]) : undefined;
    if (target) setPointRequest({ x: target.x + target.width / 2, y: target.y + target.height / 2, zoom: Math.max(zoom, 0.85), sequence: ++pointSequence.current });
    selectionCallback.current?.(blocks.filter(block => ids.includes(block.id)));
  }, [blocks, zoom]);

  const selectBlock = useCallback((blockId: string) => {
    const target = blocks.find(block => block.id === blockId);
    if (!target) return;
    if (lastSelection.current === blockId) return;
    setShowDrillBoard(false);
    lastSelection.current = blockId;
    setNodes(current => current.map(node => ({ ...node, selected: node.id === blockId })));
    setSelectedIds([blockId]);
    setPointRequest({ x: target.x + target.width / 2, y: target.y + target.height / 2, zoom: Math.max(zoom, 0.85), sequence: ++pointSequence.current });
    selectionCallback.current?.([target]);
  }, [blocks, zoom, setNodes]);

  const moved = useCallback((_: unknown, viewport: Viewport) => {
    const scale = 1 / Math.max(viewport.zoom, .28);
    surface.current?.style.setProperty('--canvas-label-scale', String(scale));
    surface.current?.style.setProperty('--canvas-map-summary-opacity', String(Math.max(0, Math.min(1, (viewport.zoom - .1) / .12))));
    if (viewport.zoom >= .75) enteringFiles.current = false;
    if (viewport.zoom < .34 && !enteringFiles.current && !mapPinned) {
      zoomIntent.current = null;
      zoomTarget.current = null;
      setMapPinned(true);
      setDrillGroup('');
      setShowDrillBoard(false);
    }
    const nextBand = viewport.zoom < 0.34 ? 'overview' : viewport.zoom < 0.75 ? 'titles' : 'full';
    if (nextBand !== zoomBand.current) {
      zoomBand.current = nextBand;
      setZoom(viewport.zoom);
    }
  }, [mapPinned]);
  const zoomOverview = useCallback((deltaY: number) => {
    const instance = flowInstance.current;
    if (!instance) return;
    zoomIntent.current = deltaY < 0 ? 'in' : 'out';
    const next = Math.max(0.005, Math.min(mapPinned ? .6 : 2.5, instance.getZoom() * Math.exp(-deltaY * 0.001)));
    void instance.zoomTo(next, { duration: 120 });
  }, [mapPinned]);
  const moveEnded = useCallback((_: unknown, viewport: Viewport) => {
    const intent = zoomIntent.current;
    const intendedGroup = zoomTarget.current;
    zoomIntent.current = null;
    zoomTarget.current = null;
    if (viewport.zoom >= .75) enteringFiles.current = false;
    if (viewport.zoom < .34 && !enteringFiles.current && !mapPinned) {
      setMapPinned(true);
      setDrillGroup('');
      setShowDrillBoard(false);
    } else if (mapPinned && intent === 'in' && viewport.zoom >= .5 && mapFrames.length) {
      const groups = flowNodes.filter((node): node is GroupNode => node.type === 'groupFrame');
      const preferred = groups.find(node => node.data.group === intendedGroup) ?? groups.find(node => node.data.group === hoveredGroup);
      const stage = surface.current?.querySelector('.canvas-flow-stage');
      const bounds = stage?.getBoundingClientRect();
      const x = ((bounds?.width ?? 900) / 2 - viewport.x) / viewport.zoom;
      const y = ((bounds?.height ?? 700) / 2 - viewport.y) / viewport.zoom;
      const nearest = preferred ?? groups.reduce<GroupNode | undefined>((best, node) => {
        if (!best) return node;
        const distance = (candidate: GroupNode) => {
          const dx = Math.max(candidate.position.x - x, 0, x - candidate.position.x - (candidate.width ?? 820));
          const dy = Math.max(candidate.position.y - y, 0, y - candidate.position.y - (candidate.height ?? 550));
          return dx * dx + dy * dy;
        };
        return distance(node) < distance(best) ? node : best;
      }, undefined);
      if (nearest) openHierarchyGroup(nearest.data.group);
    } else if (mapPinned && intent === 'out' && viewport.zoom <= .21) {
      if (mapParent) setMapParent(groupPath(mapParent).at(-2) ?? '');
      else if (activeSupergroup) setActiveSupergroup('');
    }
    zoomBand.current = viewport.zoom < 0.34 ? 'overview' : viewport.zoom < 0.75 ? 'titles' : 'full';
    rememberViewport(rememberedViewports.current, canvasId, viewport);
    setZoom(viewport.zoom);
    const bounds = surface.current?.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
    const visibleBlockIds = bounds ? flowNodes.filter(node => node.type === 'document').filter(node => {
      const x = node.position.x * viewport.zoom + viewport.x;
      const y = node.position.y * viewport.zoom + viewport.y;
      const width = (node.measured?.width ?? node.width ?? node.data.block.width) * viewport.zoom;
      const height = (node.measured?.height ?? node.height ?? node.data.block.height) * viewport.zoom;
      return x < bounds.width && x + width > 0 && y < bounds.height && y + height > 0;
    }).map(node => node.id).slice(0, 16) : [];
    const visibleGroupNodes = bounds ? flowNodes.filter((node): node is GroupNode => node.type === 'groupFrame').filter(node => {
      const x = node.position.x * viewport.zoom + viewport.x;
      const y = node.position.y * viewport.zoom + viewport.y;
      return x < bounds.width && x + (node.width ?? 820) * viewport.zoom > 0
        && y < bounds.height && y + (node.height ?? 550) * viewport.zoom > 0;
    }) : [];
    const visibleGroups = visibleGroupNodes.length ? visibleGroupNodes.flatMap(node => node.data.group.startsWith('super:')
      ? supergroups.find(supergroup => supergroup.id === node.data.group)?.rootGroups ?? [] : [node.data.group.replace(/^files:/u, '')]) : viewFocus.visibleGroups;
    viewportCallback.current?.(viewport, visibleBlockIds, { ...viewFocus, visibleGroups: [...new Set(visibleGroups)].slice(0, 16) });
  }, [canvasId, mapPinned, mapFrames.length, flowNodes, hoveredGroup, openHierarchyGroup, mapParent, activeSupergroup, supergroups, viewFocus]);

  const previewArrangement = useCallback(() => {
    const positions = arrangeConnected(viewBlocks);
    setNodes(current => current.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })));
    setArrangePreview(true);
    setPullActive(false);
  }, [viewBlocks, setNodes]);

  const restoreLayout = useCallback(() => {
    setNodes(current => current.map(node => ({ ...node, position: { x: node.data.block.x, y: node.data.block.y } })));
    setArrangePreview(false);
    setPullActive(false);
  }, [setNodes]);

  const applyArrangement = useCallback(async () => {
    const positions = nodesRef.current.map(node => ({ blockId: node.id, x: node.position.x, y: node.position.y }));
    try {
      if (onMoveBlocks) await onMoveBlocks(positions);
      else await Promise.all(positions.map(position => onUpdateBlock(position.blockId, { x: position.x, y: position.y })));
      setArrangePreview(false);
    } catch (error) {
      setMessage(error instanceof Error ? `Could not arrange documents: ${error.message}` : 'Could not arrange documents.');
    }
  }, [onMoveBlocks, onUpdateBlock]);

  const pullRelated = useCallback(() => {
    if (selectedIds.length !== 1) return;
    const positions = pullNeighbors(blocks, selectedIds[0], focusHops);
    setNodes(current => current.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })));
    setPullActive(true);
  }, [blocks, selectedIds, focusHops, setNodes]);

  /** Dragging a frame moves every card in it by the same amount. */
  const changeNodes = useCallback((changes: NodeChange<FlowNode>[]) => {
    const documentChanges: NodeChange<CanvasNode>[] = [];
    for (const change of changes) {
      if (!('id' in change) || !change.id.startsWith(groupPrefix)) { documentChanges.push(change as NodeChange<CanvasNode>); continue; }
      if (change.type !== 'position' || !change.position) continue;
      const frame = framesRef.current.find(item => item.id === change.id);
      if (!frame) continue;
      const dx = change.position.x - frame.x;
      const dy = change.position.y - frame.y;
      for (const id of frame.members) {
        const node = nodesRef.current.find(item => item.id === id);
        if (node) documentChanges.push({ type: 'position', id, position: { x: node.position.x + dx, y: node.position.y + dy }, dragging: change.dragging });
      }
    }
    if (documentChanges.length) onNodesChange(documentChanges);
  }, [onNodesChange]);

  const saveGroupMove = useCallback((frameId: string) => {
    const frame = framesRef.current.find(item => item.id === frameId);
    if (!frame) return;
    const positions = frame.members.flatMap(id => {
      const node = nodesRef.current.find(item => item.id === id);
      return node ? [{ blockId: id, x: node.position.x, y: node.position.y }] : [];
    });
    if (!positions.length) return;
    const save = onMoveBlocks ? onMoveBlocks(positions) : Promise.all(positions.map(position => saveBlock(position.blockId, { x: position.x, y: position.y })));
    void Promise.resolve(save).catch((error: unknown) => setMessage(error instanceof Error ? `Could not move group: ${error.message}` : 'Could not move this group.'));
  }, [onMoveBlocks, saveBlock]);

  /** A card dropped inside another group's frame joins it; a card dropped well outside its own frame leaves it. */
  const dropBlock = useCallback((node: CanvasNode) => {
    const block = node.data.block;
    const current = blockGroup(block) ?? null;
    const width = node.width ?? block.width;
    const height = node.height ?? block.height;
    const centerX = node.position.x + width / 2;
    const centerY = node.position.y + height / 2;
    const others = frames(blocks.filter(item => item.id !== block.id), livePositions);
    const target = others.find(frame => frame.group !== '__ungrouped' && frame.group !== current && contains(frame, centerX, centerY));
    const own = others.find(frame => frame.group === current);
    let group = current;
    if (target) group = target.group;
    else if (current && own && !contains(own, centerX, centerY, 160)) group = null;
    const patch: Partial<CanvasBlock> = { x: node.position.x, y: node.position.y };
    if (group !== current) Object.assign(patch, { group }, groupLabelPatch(group));
    void saveBlock(block.id, patch).catch(() => undefined);
  }, [blocks, livePositions, saveBlock]);

  const connect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    if (connection.source.startsWith(groupPrefix) || connection.target.startsWith(groupPrefix)) return;
    const source = blocks.find((block) => block.id === connection.source);
    if (!source || source.links.includes(connection.target)) return;
    void saveBlock(source.id, { links: [...source.links, connection.target] }).catch(() => undefined);
  }, [blocks, saveBlock]);

  const deleteEdges = useCallback((removed: Edge[]) => {
    const targetsBySource = new Map<string, Set<string>>();
    for (const edge of removed) {
      if (edge.id.startsWith('group-edge:')) continue;
      const targets = targetsBySource.get(edge.source) ?? new Set<string>();
      targets.add(edge.target);
      targetsBySource.set(edge.source, targets);
    }
    for (const [sourceId, targets] of targetsBySource) {
      const source = blocks.find((block) => block.id === sourceId);
      if (source) void saveBlock(sourceId, { links: source.links.filter((link) => !targets.has(link)) }).catch(() => undefined);
    }
  }, [blocks, saveBlock]);

  const beforeDelete = useCallback(async ({ nodes: removed }: { nodes: FlowNode[]; edges: Edge[] }) => {
    const documents = removed.filter(node => node.type === 'document');
    if (!documents.length) return removed.length === 0;
    try {
      for (const node of documents) await onDeleteBlock(node.id);
    } catch (error) {
      setMessage(error instanceof Error ? `Could not delete: ${error.message}` : 'Could not delete this document.');
    }
    // The refreshed canvas props replace the nodes after the server deletes them.
    return false;
  }, [onDeleteBlock]);

  // React discards this render and retries with the new nodes before React Flow commits.
  // An effect here would commit old nodes once and then commit the new canvas a second time.
  if (!nodeSource || nodeSource.canvasId !== canvasId || nodeSource.blocks !== blocks) {
    const canvasChanged = Boolean(nodeSource && nodeSource.canvasId !== canvasId);
    setNodeSource({ canvasId, blocks });
    setNodes(makeNodes(canvasId, blocks, saveBlock, openBlock, readBlock, historyBlock, openCrossLink, findDuplicates, analyzeBlock, resizeBlock, reportError));
    setArrangePreview(false);
    setPullActive(false);
    if (canvasChanged) {
      setSelectedIds([]);
      lastSelection.current = '';
      setCollapsed(new Set());
      setDrillGroup('');
      setMapPinned(false);
      focusTransition.current++;
      enteringFiles.current = false;
      setShowDrillBoard(false);
      setActiveSupergroup('');
      setMapParent('');
      setHoveredGroup(null);
      setHighlightedId('');
      setPointRequest(undefined);
      setFocusHops(1);
      setMessage('');
      const explicitView = previousCanvasView.current.viewportSequence !== viewportRequest?.sequence
        || previousCanvasView.current.focusSequence !== focusRequest?.sequence;
      const nextZoom = (explicitView ? undefined : rememberedViewports.current.get(canvasId))?.zoom ?? 1;
      setZoom(nextZoom);
      zoomBand.current = nextZoom < 0.34 ? 'overview' : nextZoom < 0.75 ? 'titles' : 'full';
    }
  }

  return (
    <section ref={surface} className={`canvas-surface canvas-surface--${zoomLevel}${selectedIds.length ? ' canvas-surface--inspecting' : ''}`} style={{ '--canvas-label-scale': String(1 / Math.max(zoom, .28)), '--canvas-map-summary-opacity': String(Math.max(0, Math.min(1, (zoom - .1) / .12))) } as CSSProperties} aria-label={`${canvas.name} infinite canvas`}>
      <div className="canvas-toolbar" aria-label="Canvas tools">
        <div className="canvas-breadcrumb"><button type="button" aria-label="Return to canvas group overview" onClick={returnOverview}>{canvas.name}</button>{activeSuper && <span>› <button type="button" onClick={() => { setMapParent(''); setDrillGroup(''); void flowInstance.current?.setViewport({ x: 24, y: 68, zoom: .28 }, { duration: 200 }); }}>Supergroup: {activeSuper.title}</button></span>}{mapParent && groupPath(mapParent).map(path => <span key={path}>› <button type="button" onClick={() => { setMapParent(path); setDrillGroup(''); void flowInstance.current?.setViewport({ x: 24, y: 68, zoom: .28 }, { duration: 200 }); }}>{groupLabel(path)}</button></span>)}{drillGroup === '__ungrouped' ? <span>› Ungrouped</span> : drillGroup && groupPath(drillGroup).filter(path => !mapParent || groupPath(path).length > groupPath(mapParent).length).map(path => <span key={path}>› <button type="button" onClick={() => openHierarchyGroup(path)}>{groupLabel(path)}</button></span>)}</div>
        <span className="canvas-zoom-label">{zoomLevel === 'overview' ? mapParent ? 'Subgroups' : activeSuper ? 'Groups' : supergroups.length ? 'Supergroups' : 'Groups' : zoomLevel === 'titles' ? 'Titles' : 'Files'} · {Math.round(zoom * 100)}%</span>
        {drillGroup && zoomLevel === 'full' && selectedIds.length === 0 && <button type="button" aria-pressed={showDrillBoard} onClick={() => setShowDrillBoard(value => !value)}>{showDrillBoard ? 'Show canvas' : 'Browse files'}</button>}
        <button type="button" onClick={previewArrangement} disabled={arrangePreview}>Arrange by connections</button>
        {arrangePreview && <><button type="button" onClick={() => void applyArrangement()}>Apply layout</button><button type="button" onClick={restoreLayout}>Cancel layout</button></>}
        {pullActive && <button type="button" onClick={restoreLayout}>Restore positions</button>}
      </div>
      {previewGroups && <div className="canvas-preview-note" role="status">Previewing suggested groups</div>}
      <div className="canvas-flow-stage" onWheelCapture={event => {
        zoomIntent.current = event.deltaY < 0 ? 'in' : 'out';
        zoomTarget.current = event.target instanceof Element ? event.target.closest('[data-canvas-group]')?.getAttribute('data-canvas-group') ?? null : null;
      }} onClickCapture={event => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.react-flow__controls-zoomin')) { zoomIntent.current = 'in'; zoomTarget.current = null; }
        if (target?.closest('.react-flow__controls-zoomout')) { zoomIntent.current = 'out'; zoomTarget.current = null; }
      }}><ReactFlow<FlowNode, Edge>
        onInit={instance => { flowInstance.current = instance; }}
        nodes={flowNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements
        onNodesChange={changeNodes}
        onNodeDragStop={(_, node) => {
          if (node.id.startsWith(groupPrefix)) saveGroupMove(node.id);
          else dropBlock(node as CanvasNode);
        }}
        onNodeClick={(_, node) => { if (node.type === 'document') selectBlock(node.id); }}
        onSelectionChange={selectNodes}
        onNodeDoubleClick={(_, node) => { if (node.type === 'document') openBlock((node as CanvasNode).data.block); else if (node.type === 'groupFrame') openHierarchyGroup((node as GroupNode).data.group); }}
        onConnect={connect}
        onEdgesDelete={deleteEdges}
        onBeforeDelete={beforeDelete}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.005}
        maxZoom={mapPinned ? .6 : 2.5}
        deleteKeyCode={['Backspace', 'Delete']}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        colorMode={theme}
        onMove={moved}
        onMoveEnd={moveEnded}
        selectionKeyCode="Shift"
      >
        {focusSelect && focusRequest && <FocusBlock block={blocks.find(block => block.id === focusRequest.blockId)} sequence={focusRequest.sequence} minZoom={focusZoom}/>}
        <FocusPoint request={pointRequest}/>
        <ViewRequest request={viewportRequest}/>
        <Background color={theme === 'dark' ? '#2D4649' : '#D6DEDC'} gap={22} size={1.1} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" nodeStrokeWidth={3} pannable zoomable nodeColor={node => node.type === 'groupFrame'
          ? ['#aebcf0', '#e9c48f', '#97d4cf', '#d1afe9', '#efb1c2', '#a9d7a8', '#9fc9ea', '#d8c49a'][Number((node.data as GroupNodeData).tone) || 0]
          : (searchIds.has(node.id) ? theme === 'dark' ? '#AFC0FF' : '#3858B8' : '#BCE7C9')} />
      </ReactFlow></div>
      <CanvasOverview canvasName={canvas.name} groups={groupFrames} blocks={viewBlocks} searchIds={searchIds} searchQuery={searchQuery} matchCount={searchMatchIds.length} overview={zoomLevel === 'overview'} drill={Boolean(drillGroup && !selectedIds.length)} onFocus={openHierarchyGroup} onZoomWheel={zoomOverview}/>
      {showDrillBoard && drillGroup && zoomLevel !== 'overview' && selectedIds.length === 0 && <CanvasDrillBoard group={drillGroup} groups={groupFrames} blocks={viewBlocks} onFocus={focusGroup} onSelect={selectBlock}/>}
      {selectedIds.length === 1 && <div className="canvas-focus-tools" aria-label="Connection focus"><strong>Connections for {selectedBlocks[0]?.title}</strong><button type="button" aria-pressed={focusHops === 1} onClick={() => setFocusHops(1)}>+1 hop</button><button type="button" aria-pressed={focusHops === 2} onClick={() => setFocusHops(2)}>+2 hops</button><button type="button" onClick={pullRelated}>Pull neighbors close</button></div>}
      <CanvasInspector key={selectedIds.join('|')} blocks={blocks} selected={selectedBlocks} canvasId={canvasId} onUpdateBlock={saveBlock} onReadBlock={readBlock} onFocusBlock={selectBlock} onSummarizeSelection={onSummarizeSelection} onError={reportError} onClose={() => { lastSelection.current = ''; setSelectedIds([]); selectionCallback.current?.([]); }} onResize={(axis, size) => surface.current?.style.setProperty(axis === 'width' ? '--canvas-inspector-width' : '--canvas-inspector-height', `${size}px`)}/>
      <div className="canvas-hint">{zoomLevel === 'overview' ? 'Zoom in over a card to open it · zoom out to go up · drag to pan' : 'Scroll to zoom · drag to pan · Shift and drag to select'}</div>
      {message && <div className="canvas-error" role="alert">{message}<button onClick={() => setMessage('')} aria-label="Dismiss error">×</button></div>}
    </section>
  );
}
