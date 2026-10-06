import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, ReactFlowProvider, useNodesState } from '@xyflow/react';
import { expect } from 'vitest';
import type { CanvasBlock } from '../shared/types';
import type { CanvasNodeData, FlowNode, GroupNodeData } from './canvas-types';
import { nodeTypes } from './CanvasNodes';
import { block } from './canvas-model.test.helpers';

type DocumentFields = Pick<CanvasNodeData, 'block' | 'canvasId' | 'highlighted' | 'dimmed' | 'searchMatch' | 'activeSearch' | 'detail' | 'crossLinkLabels'>;
type GroupFields = Pick<GroupNodeData, 'group' | 'title' | 'count' | 'tone' | 'width' | 'height' | 'depth' | 'collapsed' | 'overview' | 'kind' | 'topTitles' | 'internalLinkCount' | 'externalLinkCount'>;
export type NodeSeed = { id: string; type: 'document'; data: DocumentFields; selected?: boolean }
  | { id: string; type: 'groupFrame'; data: GroupFields; selected?: boolean };

export function documentSeed(extra: Partial<DocumentFields> = {}): NodeSeed {
  return { id: 'a', type: 'document', data: { block: block('a'), canvasId: 'planning', highlighted: false, ...extra } };
}
export function groupSeed(extra: Partial<GroupFields> = {}): NodeSeed {
  return { id: 'group:a', type: 'groupFrame', data: { group: 'custom:a', title: 'Alpha', count: 1, tone: 2,
    width: 400, height: 300, depth: 0, collapsed: false, overview: false, topTitles: ['First document'], ...extra } };
}

// This is a supported controlled ReactFlow owner of the exported nodeTypes.
// Its public node-data callbacks update the displayed event log and controlled
// document content/dimensions; the installed renderer and node components are unchanged.
function NodeOwner({ seeds }: { seeds: NodeSeed[] }) {
  const [events, setEvents] = useState<string[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const record = useCallback((event: string) => setEvents(current => [...current, event]), []);
  const update = useCallback(async (id: string, patch: Partial<CanvasBlock>) => {
    setNodes(current => current.map(node => node.type === 'document' && node.id === id
      ? { ...node, data: { ...node.data, block: { ...node.data.block, ...patch } },
        style: { ...node.style, width: patch.width ?? node.data.block.width, height: patch.height ?? node.data.block.height } } : node));
    record(`update:${id}:${JSON.stringify(patch)}`);
  }, [record, setNodes]);
  const callbacks = useMemo(() => ({
    onUpdateBlock: update,
    onOpenBlock: (value: CanvasBlock) => record(`edit:${value.id}`),
    onReadBlock: (value: CanvasBlock) => record(`read:${value.id}`),
    onHistoryBlock: (value: CanvasBlock) => record(`history:${value.id}`),
    onOpenCrossLink: (canvasId: string, id: string) => record(`portal:${canvasId}:${id}`),
    onResize: (id: string, patch: Partial<CanvasBlock>) => { void update(id, patch); },
    onError: (message: string) => record(`error:${message}`),
    onDrill: (group: string) => record(`drill:${group}`),
    onCollapse: (group: string) => record(`collapse:${group}`),
    onHover: (group: string | null) => record(`hover:${group}`),
  }), [record, update]);
  useEffect(() => {
    setNodes(seeds.map((seed, index): FlowNode => seed.type === 'document'
      ? { ...seed, position: { x: index * 450, y: 0 }, data: { ...seed.data, ...callbacks }, style: { width: seed.data.block.width, height: seed.data.block.height } }
      : { ...seed, position: { x: index * 450, y: 0 }, data: { ...seed.data, ...callbacks }, style: { width: seed.data.width, height: seed.data.height } }));
  }, [seeds, callbacks, setNodes]);
  return <>
    <output aria-label="Node callback events">{JSON.stringify(events)}</output>
    <ReactFlow nodes={nodes} onNodesChange={onNodesChange} nodeTypes={nodeTypes} defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      onNodeDoubleClick={(_, node) => record(`double:${node.id}`)}/>
  </>;
}
export function mountNodes(seeds: NodeSeed[]) {
  const ui = render(<ReactFlowProvider><NodeOwner seeds={seeds}/></ReactFlowProvider>);
  return { ...ui, change(next: NodeSeed[]) { ui.rerender(<ReactFlowProvider><NodeOwner seeds={next}/></ReactFlowProvider>); } };
}
export function events(): string[] { return JSON.parse(screen.getByLabelText('Node callback events').textContent ?? '[]'); }
export async function card() {
  await screen.findByRole('button', { name: 'Edit Document a' });
  const element = document.querySelector<HTMLElement>('[data-id="a"] .canvas-card');
  if (!element) throw new Error('Missing native document card');
  return element;
}
export async function group() {
  await waitFor(() => expect(document.querySelector('.canvas-group')).toBeTruthy());
  const element = document.querySelector<HTMLElement>('.canvas-group');
  if (!element) throw new Error('Missing native group');
  return element;
}

export function resizeHandle(handle: Element, dx: number, dy: number) {
  const view = handle.ownerDocument.defaultView;
  if (!view) throw new Error('Missing browser input surface');
  for (const [type, target, x, y, buttons] of [
    ['mousedown', handle, 320, 240, 1], ['mousemove', view, 320 + dx, 240 + dy, 1], ['mouseup', view, 320 + dx, 240 + dy, 0],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons });
    // jsdom 29 rejects its VM Window wrapper in MouseEventInit.view. The
    // installed D3 input handler still receives the normal public event view.
    Object.defineProperty(event, 'view', { value: view });
    fireEvent(target, event);
  }
}
