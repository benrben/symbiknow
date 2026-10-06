// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { expect, it } from 'vitest';
import { CanvasStore } from '../server/storage';
import type { CanvasViewFocus } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';
import { CanvasView } from './CanvasView';
import { useCanvasModel } from './canvas-model';
import type { CanvasProps, FlowNode } from './canvas-types';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';

installAssistantBrowser();

function IntrinsicDimensions({ id }: { id: string }) {
  const flow = useReactFlow<FlowNode>();
  // updateNode is the installed renderer's public API. Optional dimensions
  // are valid when an embedding owner delegates measurement to that renderer.
  return <>
    <button onClick={() => flow.updateNode(id, { width: undefined })}>Measure width</button>
    <button onClick={() => flow.updateNode(id, { height: undefined })}>Measure height</button>
  </>;
}

function GraphOwner({ canvasProps }: { canvasProps: CanvasProps }) {
  const model = useCanvasModel(canvasProps);
  return <>
    <output aria-label="Public graph">{JSON.stringify({
      blocks: model.viewBlocks, frames: model.groupFrames, supergroups: model.supergroups,
      nodes: model.nodes.map(node => ({ id: node.id, width: node.width, height: node.height })),
    })}</output>
    <CanvasView model={model} />
    {model.blocks[0] && <IntrinsicDimensions id={model.blocks[0].id} />}
  </>;
}

function graph(): { blocks: CanvasDocument['blocks']; frames: Array<{ group: string; width: number; height: number }>;
  supergroups: Array<{ id: string; rootGroups: string[] }>; nodes: Array<{ id: string; width?: number; height?: number }> } {
  return JSON.parse(screen.getByLabelText('Public graph').textContent ?? '{}');
}

async function fixture(count = 2) {
  const native = await assistantFixture(undefined, false);
  const response = await native.request('/api/workspaces/acme-team/canvases', jsonBody({ name: 'Native graph boundaries' }));
  expect(response.status).toBe(201);
  const created = await response.json() as CanvasDocument;
  for (let index = 0; index < count; index++) {
    const saved = await native.request(`/api/canvases/${created.id}/blocks`, jsonBody({
      title: `Graph evidence ${index}`, content: `# Persisted graph ${index}`, group: `custom:graph${index}`,
      x: 100 + index * 500, y: 200, width: 320, height: 240,
    }));
    expect(saved.status).toBe(201);
  }
  const original = await native.read(created.id);
  native.unmount();
  const focus: CanvasViewFocus[] = [];
  const props: CanvasProps = { canvas: original, onSelectBlock: () => undefined,
    onUpdateBlock: async (id, patch) => {
      expect((await native.request(`/api/canvases/${created.id}/blocks/${id}`, { ...jsonBody(patch), method: 'PUT' })).status).toBe(200);
    },
    onDeleteBlock: async id => {
      expect((await native.request(`/api/canvases/${created.id}/blocks/${id}`, { method: 'DELETE' })).status).toBe(200);
    }, onViewportChange: (_viewport, _visible, current) => { focus.push(current); },
  };
  const view = render(<ReactFlowProvider><GraphOwner canvasProps={props} /></ReactFlowProvider>);
  await waitFor(() => expect(graph().nodes).toHaveLength(count));
  return { native, original, focus, props, view,
    rerender(next: CanvasProps) { view.rerender(<ReactFlowProvider><GraphOwner canvasProps={next} /></ReactFlowProvider>); },
    async unchanged() {
      expect(await native.read(original.id)).toEqual(original);
      const restarted = new CanvasStore(native.root); await restarted.init();
      expect(await restarted.getCanvas(original.id)).toEqual(original);
    },
  };
}

it('uses persisted document dimensions when the public installed ReactFlow API requests intrinsic measurement', async () => {
  const value = await fixture(1);
  const originalFrame = graph().frames[0];
  fireEvent.click(screen.getByRole('button', { name: 'Measure width' }));
  await waitFor(() => expect(graph().nodes[0].width).toBeUndefined());
  expect(graph().frames[0]).toEqual(originalFrame);
  fireEvent.click(screen.getByRole('button', { name: 'Measure height' }));
  await waitFor(() => expect(graph().nodes[0].height).toBeUndefined());
  expect(graph().frames[0]).toEqual(originalFrame);
  await value.unchanged();
});

it('publishes each visible supergroup root once and preserves the persisted map through overview navigation', async () => {
  const value = await fixture(10);
  const supergroups = graph().supergroups;
  expect(supergroups.length).toBeGreaterThan(1);
  const roots = supergroups.flatMap(group => group.rootGroups);
  expect(new Set(roots).size).toBe(10);
  value.rerender({ ...value.props, viewportRequest: { x: 20, y: 30, zoom: .2, sequence: 1 } });
  await waitFor(() => expect(value.focus.at(-1)?.level).toBe('groups'));
  await waitFor(() => expect(value.focus.at(-1)?.visibleGroups).toEqual(roots));
  expect(new Set(value.focus.at(-1)?.visibleGroups).size).toBe(10);
  expect(screen.queryByRole('button', { name: 'Show group list' })).toBeNull();
  expect(screen.getByRole('navigation', { name: 'Mini-map groups' })).toBeTruthy();
  await act(async () => { await value.unchanged(); });
});
