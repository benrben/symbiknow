import type { Viewport } from '@xyflow/react';
import type { CanvasGraph } from './canvas-graph';
import type { CanvasNode, FlowNode, GroupNode } from './canvas-types';
import type { ViewportBounds } from './canvas-viewport-types';

function nodeDistance(node: GroupNode, x: number, y: number) {
  const dx = Math.max(node.position.x - x, 0, x - node.position.x - (node.width ?? 820));
  const dy = Math.max(node.position.y - y, 0, y - node.position.y - (node.height ?? 550));
  return dx * dx + dy * dy;
}

export function nearestMapGroup(nodes: FlowNode[], viewport: Viewport, bounds: ViewportBounds, intended: string | null, hovered: string | null) {
  const groups = nodes.filter((node): node is GroupNode => node.type === 'groupFrame');
  const preferred = groups.find(node => node.data.group === intended) ?? groups.find(node => node.data.group === hovered);
  const x = ((bounds?.width ?? 900) / 2 - viewport.x) / viewport.zoom;
  const y = ((bounds?.height ?? 700) / 2 - viewport.y) / viewport.zoom;
  return preferred ?? groups.reduce<GroupNode | undefined>((best, node) => {
    if (!best) return node;
    return nodeDistance(node, x, y) < nodeDistance(best, x, y) ? node : best;
  }, undefined);
}

function intersectsViewport(position: { x: number; y: number }, size: { width: number; height: number }, viewport: Viewport, bounds: NonNullable<ViewportBounds>) {
  const x = position.x * viewport.zoom + viewport.x;
  const y = position.y * viewport.zoom + viewport.y;
  return x < bounds.width && x + size.width * viewport.zoom > 0
    && y < bounds.height && y + size.height * viewport.zoom > 0;
}

function documentSize(node: CanvasNode) {
  return {
    width: node.measured?.width ?? node.width ?? node.data.block.width,
    height: node.measured?.height ?? node.height ?? node.data.block.height
  };
}

export function visibleDocuments(nodes: FlowNode[], viewport: Viewport, bounds: ViewportBounds) {
  if (!bounds) return [];
  return nodes.filter((node): node is CanvasNode => node.type === 'document')
    .filter(node => intersectsViewport(node.position, documentSize(node), viewport, bounds)).map(node => node.id).slice(0, 16);
}

export function visibleGroupNodes(nodes: FlowNode[], viewport: Viewport, bounds: ViewportBounds) {
  if (!bounds) return [];
  return nodes.filter((node): node is GroupNode => node.type === 'groupFrame')
    .filter(node => intersectsViewport(node.position, { width: node.width ?? 820, height: node.height ?? 550 }, viewport, bounds));
}

export function visibleGroups(nodes: GroupNode[], graph: CanvasGraph) {
  if (!nodes.length) return graph.viewFocus.visibleGroups;
  return nodes.flatMap(node => node.data.group.startsWith('super:')
    ? graph.supergroups.find(supergroup => supergroup.id === node.data.group)?.rootGroups ?? []
    : [node.data.group.replace(/^files:/u, '')]);
}
