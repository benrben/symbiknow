import type { NodeChange } from '@xyflow/react';
import { expect, it } from 'vitest';
import type { CanvasNode } from './canvas-types';
import { changedCanvasNodes } from './canvas-node-changes';

const node = { id: 'source', width: 420, height: 320 } as CanvasNode;
const measurement: NodeChange<CanvasNode> = { type: 'dimensions', id: node.id, dimensions: { width: 420, height: 320 } };

it('drops only passive measurements already represented by the controlled dimensions', () => {
  expect(changedCanvasNodes([measurement], [node])).toEqual([]);
  expect(changedCanvasNodes([], [node])).toEqual([]);
  const changes: NodeChange<CanvasNode>[] = [
    { ...measurement, dimensions: { width: 480, height: 320 } },
    { ...measurement, dimensions: { width: 420, height: 360 } },
    { ...measurement, id: 'new-source' },
  ];
  expect(changedCanvasNodes(changes, [node])).toEqual(changes);
  expect(changedCanvasNodes([measurement], [{ ...node, width: undefined }])).toEqual([measurement]);
});

it('retains explicit resize dimensions, starting and ending resizing, and every nonmeasurement action', () => {
  const changes: NodeChange<CanvasNode>[] = [
    { ...measurement, dimensions: undefined },
    { ...measurement, resizing: true },
    { ...measurement, resizing: false },
    { ...measurement, setAttributes: true },
    { ...measurement, setAttributes: 'width' },
    { ...measurement, setAttributes: 'height' },
    { type: 'position', id: node.id, position: { x: 100, y: 220 }, dragging: true },
    { type: 'select', id: node.id, selected: true },
    { type: 'remove', id: node.id },
    { type: 'add', item: node },
    { type: 'replace', id: node.id, item: node },
  ];
  expect(changedCanvasNodes(changes, [node])).toEqual(changes);
  expect(changedCanvasNodes([{ ...measurement, setAttributes: false }], [node])).toEqual([]);
});
