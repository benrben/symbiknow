import { useMemo, useRef } from 'react';
import { groupPath, normalizedGroup } from '../shared/groups';
import { drillPosition, type DrillPositions } from './canvas-drill-layout';
import { frameNodes } from './canvas-flow-helpers';
import type { CanvasGraph } from './canvas-graph';
import type { CanvasState } from './canvas-state';
import type { CanvasNode, CanvasNodeData, CanvasProps, FlowNode } from './canvas-types';

const noRelatedLinks: NonNullable<CanvasNodeData['relatedLinks']> = [];

export function useCanvasFlowNodes(props: CanvasProps, state: CanvasState, graph: CanvasGraph, actions: { focusGroup: (group: string) => void; openHierarchyGroup: (group: string) => void; toggleGroup: (group: string) => void }) {
  const { canvas: { id: canvasId }, crossLinkLabels, onFindSimilar, activeSearchId, searchQuery = '' } = props;
  const { highlightedId, collapsed, drillGroup, mapColumns, setHoveredGroup, nodes } = state;
  const { viewBlocks, zoomLevel, searchIds, focusIds, mapFrames, visibleFrames, drillPositions, mapGroupForBlock } = graph;
  const { focusGroup, openHierarchyGroup, toggleGroup } = actions;
  const decoratedNodes = useRef(new Map<string, DecoratedNode>());
  const relatedLinks = useMemo(() => canvasRelatedLinks(viewBlocks), [viewBlocks]);
  const flowNodes = useMemo<FlowNode[]>(() => {
    const framesToShow = visibleFrames.filter(frame => zoomLevel === 'overview' ? frame.depth === 0
      : !groupPath(frame.group).slice(0, -1).some(parent => collapsed.has(parent)));
    const groups = new Map(viewBlocks.map(block => [block.id, normalizedGroup(block.group)]));
    const nextDecorated = new Map<typeof nodes[number]['id'], NonNullable<ReturnType<typeof decoratedNodes.current.get>>>();
    const shownDocuments = zoomLevel === 'overview' ? [] : nodes.filter(node => isDocumentShown(node, canvasId, groups.get(node.id), collapsed, drillGroup)).map(node => {
      const decoration = nodeDecoration(node, { highlightedId, searchIds, activeSearchId, searchQuery, focusIds, zoomLevel, crossLinkLabels, onFindSimilar,
        relatedLinks: relatedLinks.get(node.id) ?? noRelatedLinks });
      const next = decorateNode(node, decoration, decoratedNodes.current.get(node.id));
      nextDecorated.set(node.id, next);
      return packedNode(next.output, drillPositions);
    });
    decoratedNodes.current = nextDecorated;
    const arrangedFrames = zoomLevel === 'overview' ? mapFrames.map((frame, index) => ({
      ...frame, topTitles: frame.topTitles.slice(0, 3), x: (index % mapColumns) * 1100, y: Math.floor(index / mapColumns) * 740, width: 820, height: 550,
    })) : framesToShow;
    const linkCounts = zoomLevel === 'overview' ? visibleLinkCounts(viewBlocks, mapGroupForBlock) : { internal: new Map<string, number>(), external: new Map<string, number>() };
    const groupNodes = frameNodes(arrangedFrames, collapsed, zoomLevel === 'overview', zoomLevel === 'overview' ? openHierarchyGroup : focusGroup, toggleGroup, setHoveredGroup, linkCounts.internal, linkCounts.external);
    // Moving a packed frame would save the packed places of every card in it.
    return [...shownDocuments, ...(drillPositions.size ? groupNodes.map(frame => ({ ...frame, draggable: false })) : groupNodes)];
  }, [canvasId, visibleFrames, mapFrames, mapColumns, collapsed, zoomLevel, nodes, viewBlocks, relatedLinks, crossLinkLabels, onFindSimilar, drillGroup, drillPositions, highlightedId, searchIds, activeSearchId, searchQuery, focusIds, focusGroup, openHierarchyGroup, toggleGroup, mapGroupForBlock]);
  return flowNodes;
}

export function visibleLinkCounts(blocks: CanvasProps['canvas']['blocks'], groupForBlock: (block: CanvasProps['canvas']['blocks'][number]) => string | undefined) {
  const groups = new Map(blocks.map(block => [block.id, groupForBlock(block)]));
  const internal = new Map<string, number>();
  const external = new Map<string, number>();
  for (const block of blocks) {
    const sourceGroup = groups.get(block.id);
    for (const targetId of block.links) {
      if (!groups.has(targetId)) continue;
      countVisibleLink(internal, external, sourceGroup, groups.get(targetId));
    }
  }
  return { internal, external };
}

function countVisibleLink(internal: Map<string, number>, external: Map<string, number>, source: string | undefined, target: string | undefined) {
  if (source && source === target) {
    incrementLinkCount(internal, source);
    return;
  }
  if (source) incrementLinkCount(external, source);
  if (target) incrementLinkCount(external, target);
}

function incrementLinkCount(counts: Map<string, number>, group: string) {
  counts.set(group, (counts.get(group) ?? 0) + 1);
}


/** A packed card shows a reading layout, not its saved place, so dragging it would save a place nobody chose. */
function packedNode(node: CanvasNode, positions: DrillPositions): CanvasNode {
  const position = drillPosition(positions, node);
  return position === node.position ? node : { ...node, position, draggable: false };
}

type Decoration = Pick<CanvasNodeData, 'highlighted' | 'searchMatch' | 'activeSearch' | 'dimmed' | 'detail' | 'relatedLinks'>
  & { crossLinkLabels?: Record<string, string>; onFindSimilar?: (blockId: string) => void };
type DecoratedNode = { source: CanvasNode; decoration: Decoration; output: CanvasNode };
const decorationFields = ['highlighted', 'searchMatch', 'activeSearch', 'dimmed', 'detail', 'crossLinkLabels', 'onFindSimilar', 'relatedLinks'] as const;

function canvasRelatedLinks(blocks: CanvasProps['canvas']['blocks']): Map<string, NonNullable<CanvasNodeData['relatedLinks']>> {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const related = new Map<string, NonNullable<CanvasNodeData['relatedLinks']>>();
  const add = (id: string, link: NonNullable<CanvasNodeData['relatedLinks']>[number]) =>
    related.set(id, [...(related.get(id) ?? []), link]);
  for (const source of blocks) for (const targetId of source.links) {
    const target = byId.get(targetId);
    if (!target) continue;
    const relation = source.linkTypes?.[targetId];
    add(source.id, { block: target, direction: 'out', relation });
    add(target.id, { block: source, direction: 'in', relation });
  }
  return related;
}

function groupMatchesDrill(group: string | undefined, drillGroup: string): boolean {
  if (!drillGroup) return true;
  if (!group) return drillGroup === '__ungrouped';
  return groupPath(group).includes(drillGroup);
}

function groupIsCollapsed(group: string | undefined, collapsed: Set<string>) {
  if (!group) return collapsed.has('__ungrouped');
  return groupPath(group).some(path => collapsed.has(path));
}

function isDocumentShown(node: CanvasNode, canvasId: string, group: string | undefined, collapsed: Set<string>, drillGroup: string) {
  if (node.data.canvasId !== canvasId) return false;
  if (groupIsCollapsed(group, collapsed)) return false;
  return groupMatchesDrill(group, drillGroup);
}

function nodeDecoration(node: CanvasNode, options: {
  highlightedId: string; searchIds: Set<string>; activeSearchId?: string; searchQuery: string;
  focusIds: Set<string> | null; zoomLevel: string; crossLinkLabels?: Record<string, string>; onFindSimilar?: (blockId: string) => void;
  relatedLinks: NonNullable<CanvasNodeData['relatedLinks']>;
}): Decoration {
  const searchMatch = options.searchIds.has(node.id);
  return {
    highlighted: node.id === options.highlightedId, searchMatch, activeSearch: node.id === options.activeSearchId,
    dimmed: options.searchQuery.trim() ? !searchMatch : Boolean(options.focusIds && !options.focusIds.has(node.id)),
    detail: options.zoomLevel === 'titles' ? 'titles' : 'full', crossLinkLabels: options.crossLinkLabels, onFindSimilar: options.onFindSimilar,
    relatedLinks: options.relatedLinks,
  };
}

function sameDecoration(node: CanvasNode, decoration: Decoration, previous: DecoratedNode | undefined): previous is DecoratedNode {
  if (!previous) return false;
  return previous.source.data === node.data && decorationFields.every(field => previous.decoration[field] === decoration[field]);
}

function decorateNode(node: CanvasNode, decoration: Decoration, previous: DecoratedNode | undefined): DecoratedNode {
  const unchanged = sameDecoration(node, decoration, previous);
  const output = unchanged && previous.source === node ? previous.output
    : { ...node, data: unchanged ? previous.output.data : { ...node.data, ...decoration } };
  return { source: node, decoration, output };
}
