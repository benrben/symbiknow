import type { Connection, NodeChange } from '@xyflow/react';
import type { CanvasBlock } from '../shared/types';
import { blockGroup, contains, frames, groupLabelPatch, groupPrefix } from './canvas-flow-helpers';
import type { CanvasNode, FlowNode, Frame } from './canvas-types';

type Positions = Parameters<typeof frames>[1];

function changesForGroup(change: NodeChange<FlowNode>, groupFrames: Frame[], nodes: CanvasNode[]): NodeChange<CanvasNode>[] {
  if (!('id' in change) || !change.id.startsWith(groupPrefix)) return [change as NodeChange<CanvasNode>];
  if (change.type !== 'position' || !change.position) return [];
  const frame = groupFrames.find(item => item.id === change.id);
  if (!frame) return [];
  const dx = change.position.x - frame.x;
  const dy = change.position.y - frame.y;
  return frame.members.flatMap(id => {
    const node = nodes.find(item => item.id === id);
    return node ? [{ type: 'position' as const, id, position: { x: node.position.x + dx, y: node.position.y + dy }, dragging: change.dragging }] : [];
  });
}

export function documentDragChanges(changes: NodeChange<FlowNode>[], groupFrames: Frame[], nodes: CanvasNode[]) {
  return changes.flatMap(change => changesForGroup(change, groupFrames, nodes));
}

function destinationGroup(others: Frame[], current: string | null, x: number, y: number) {
  const target = others.find(frame => frame.group !== '__ungrouped' && frame.group !== current && contains(frame, x, y));
  if (target) return target.group;
  const own = others.find(frame => frame.group === current);
  if (current && own && !contains(own, x, y, 160)) return null;
  return current;
}

export function droppedBlockPatch(node: CanvasNode, blocks: CanvasBlock[], livePositions: Positions): Partial<CanvasBlock> {
  const block = node.data.block;
  const current = blockGroup(block) ?? null;
  const centerX = node.position.x + (node.width ?? block.width) / 2;
  const centerY = node.position.y + (node.height ?? block.height) / 2;
  const others = frames(blocks.filter(item => item.id !== block.id), livePositions);
  const group = destinationGroup(others, current, centerX, centerY);
  const patch: Partial<CanvasBlock> = { x: node.position.x, y: node.position.y };
  if (group !== current) Object.assign(patch, { group }, groupLabelPatch(group));
  return patch;
}

function connectsDocuments(source: string, target: string) {
  return !source.startsWith(groupPrefix) && !target.startsWith(groupPrefix);
}

export function canvasConnection(connection: Connection, blocks: CanvasBlock[]) {
  if (!connection.source || !connection.target || connection.source === connection.target) return undefined;
  if (!connectsDocuments(connection.source, connection.target)) return undefined;
  const source = blocks.find(block => block.id === connection.source);
  return { source, target: connection.target };
}
