import type { NodeChange, NodeDimensionChange } from '@xyflow/react';
import type { CanvasNode } from './canvas-types';

function passiveMeasurement(change: NodeChange<CanvasNode>): change is NodeDimensionChange & { dimensions: { width: number; height: number } } {
  return change.type === 'dimensions' && change.dimensions !== undefined
    && change.resizing === undefined && !change.setAttributes;
}

function changesControlledNode(change: NodeChange<CanvasNode>, nodes: Map<string, CanvasNode>): boolean {
  if (!passiveMeasurement(change)) return true;
  const node = nodes.get(change.id);
  return !node || node.width !== change.dimensions.width || node.height !== change.dimensions.height;
}

/** React Flow keeps its own measurements; echoing unchanged sizes into controlled state can restart its observer during delivery. */
export function changedCanvasNodes(changes: NodeChange<CanvasNode>[], nodes: CanvasNode[]): NodeChange<CanvasNode>[] {
  const current = new Map(nodes.map(node => [node.id, node]));
  return changes.filter(change => changesControlledNode(change, current));
}
