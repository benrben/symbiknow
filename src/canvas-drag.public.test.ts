// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import type { Connection, NodeChange } from '@xyflow/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { api } from './api';
import { canvasConnection, documentDragChanges, droppedBlockPatch } from './canvas-drag';
import { frames, makeNodes } from './canvas-flow-helpers';
import type { CanvasNode, FlowNode } from './canvas-types';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';

afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await closeWorkspaceFixtures();
});

async function fixture() {
  const native = await workspaceFixture();
  const created = await api<CanvasDocument>(`/workspaces/${native.workspace.id}/canvases`, {
    method: 'POST', body: JSON.stringify({ name: 'Native drag snapshots' }),
  });
  for (const [index, group] of ['area:engineering', 'area:engineering', 'area:operations'].entries()) {
    const block = await api<CanvasBlock>(`/canvases/${created.id}/blocks`, { method: 'POST',
      body: JSON.stringify({ title: `Drag evidence ${index}`, content: `# Drag source ${index}`, x: index * 500, y: 200 }),
    });
    await api(`/canvases/${created.id}/blocks/${block.id}`, { method: 'PUT',
      body: JSON.stringify({ x: index * 500, y: 200, width: 320, height: 240, group }),
    });
  }
  const original = await api<CanvasDocument>(`/canvases/${created.id}`);
  function nodes(canvas: CanvasDocument): CanvasNode[] {
    return makeNodes(canvas.id, canvas.blocks, async (id, patch) => {
      await api(`/canvases/${canvas.id}/blocks/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
    }, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined,
    () => undefined);
  }
  return { native, original, nodes,
    async verify(expected: CanvasDocument) { expect(await native.reload(created.id)).toEqual(expected); },
  };
}

it('translates a retained group-frame drag only for surviving native documents and safely ignores removed frames', async () => {
  const value = await fixture();
  const beforeNodes = value.nodes(value.original);
  const oldFrames = frames(value.original.blocks, new Map());
  const frame = oldFrames.find(item => item.group === 'area:engineering')!;
  const [a, b] = value.original.blocks;
  await api(`/canvases/${value.original.id}/blocks/${b.id}`, { method: 'DELETE' });
  const current = await api<CanvasDocument>(`/canvases/${value.original.id}`);
  const nodes = value.nodes(current);
  // Exported pure input contract: a retained geometry snapshot may still
  // mention a document removed by the native owner before its final event.
  const change: NodeChange<FlowNode> = { type: 'position', id: frame.id,
    position: { x: frame.x + 64, y: frame.y + 96 }, dragging: false };
  const translated = documentDragChanges([change], oldFrames, nodes);
  expect(translated).toEqual([{ type: 'position', id: a.id, position: { x: a.x + 64, y: a.y + 96 }, dragging: false }]);
  expect(documentDragChanges([change], [], nodes)).toEqual([]);
  expect(documentDragChanges([{ type: 'select', id: frame.id, selected: true }], oldFrames, nodes)).toEqual([]);
  expect(documentDragChanges([{ type: 'position', id: frame.id }], oldFrames, nodes)).toEqual([]);
  const added: NodeChange<FlowNode> = { type: 'add', item: beforeNodes[1] };
  expect(documentDragChanges([added], oldFrames, nodes)).toEqual([added]);
  const selected: NodeChange<FlowNode> = { type: 'select', id: a.id, selected: true };
  expect(documentDragChanges([selected], oldFrames, nodes)).toEqual([selected]);
  await api(`/canvases/${current.id}/layout`, { method: 'PUT', body: JSON.stringify({ positions: [
    { blockId: a.id, x: a.x + 64, y: a.y + 96 },
  ] }) });
  const saved = await api<CanvasDocument>(`/canvases/${current.id}`);
  expect(saved.blocks).toEqual(current.blocks.map(block => block.id === a.id ? { ...block, x: block.x + 64, y: block.y + 96 } : block));
  await value.verify(saved);
});

it('uses document dimensions for valid intrinsic-size nodes when dropping into or leaving a persisted group', async () => {
  const value = await fixture();
  const [source, , target] = value.original.blocks;
  const node = value.nodes(value.original)[0];
  expect(droppedBlockPatch({ ...node, position: { x: 400, y: 200 } }, value.original.blocks, new Map())).toEqual({ x: 400, y: 200 });
  const grouped: CanvasNode = { ...node, width: undefined, height: undefined, position: { x: target.x, y: target.y } };
  const snapshot = structuredClone(value.original);
  const patch = droppedBlockPatch(grouped, value.original.blocks, new Map());
  expect(patch).toMatchObject({ x: target.x, y: target.y, group: 'area:operations', workArea: 'operations' });
  expect(value.original).toEqual(snapshot);
  await api(`/canvases/${value.original.id}/blocks/${source.id}`, { method: 'PUT', body: JSON.stringify(patch) });
  const saved = await api<CanvasDocument>(`/canvases/${value.original.id}`);
  expect(saved.blocks.find(block => block.id === source.id)).toEqual({ ...source, ...patch,
    metadataRevision: source.metadataRevision! + 1,
    jevOwnership: { ...source.jevOwnership!, pins: [...source.jevOwnership!.pins, 'workArea'] } });
  expect(saved.blocks.filter(block => block.id !== source.id)).toEqual(value.original.blocks.filter(block => block.id !== source.id));
  await value.verify(saved);
  const moved = value.nodes(saved).find(item => item.id === source.id)!;
  const outside = droppedBlockPatch({ ...moved, position: { x: -2000, y: -2000 } }, saved.blocks, new Map());
  expect(outside.group).toBeNull();
  await api(`/canvases/${saved.id}/blocks/${source.id}`, { method: 'PUT', body: JSON.stringify(outside) });
  const ungrouped = await api<CanvasDocument>(`/canvases/${saved.id}`);
  expect(ungrouped.blocks.find(block => block.id === source.id)?.group).toBeUndefined();
  const ungroupedNode = value.nodes(ungrouped).find(item => item.id === source.id)!;
  expect(droppedBlockPatch(ungroupedNode, ungrouped.blocks, new Map())).toEqual({ x: -2000, y: -2000 });
  await value.verify(ungrouped);
});

it('rejects group endpoints and cancelled/self connections while accepting only the native source document', async () => {
  const value = await fixture();
  const [a, b] = value.original.blocks;
  const frame = frames(value.original.blocks, new Map())[0];
  const connection = (source: string, target: string): Connection => ({ source, target, sourceHandle: null, targetHandle: null });
  for (const pair of [[frame.id, b.id], [a.id, frame.id], ['', b.id], [a.id, ''], [a.id, a.id]]) {
    expect(canvasConnection(connection(pair[0], pair[1]), value.original.blocks)).toBeUndefined();
  }
  expect(canvasConnection(connection(a.id, b.id), value.original.blocks)).toEqual({ source: a, target: b.id });
  await value.verify(value.original);
});
