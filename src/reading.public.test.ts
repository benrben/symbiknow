// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { api } from './api';
import { readingSequence } from './reading';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';

afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await closeWorkspaceFixtures();
});

it('reads native grouped documents by shared row anchors, then document coordinates and stable exact ties', async () => {
  const fixture = await workspaceFixture();
  const canvas = await api<CanvasDocument>(`/workspaces/${fixture.workspace.id}/canvases`, {
    method: 'POST', body: JSON.stringify({ name: 'Native reading order' }),
  });
  const definitions = [
    { title: 'Engineering lower', x: 400, y: 400, group: 'area:engineering' },
    { title: 'Engineering right', x: 800, y: 200, group: 'area:engineering' },
    { title: 'Engineering left', x: 650, y: 200, group: 'area:engineering' },
    { title: 'Operations', x: 100, y: 500, group: 'area:operations' },
    { title: 'Stable first', x: 20, y: 10 },
    { title: 'Stable second', x: 20, y: 10, group: '' },
    { title: 'Ungrouped right', x: 200, y: 100 },
    { title: 'Last row', x: 1, y: 900, group: 'area:research' },
  ];
  for (const definition of definitions) {
    const { group, ...input } = definition;
    const block = await api<CanvasBlock>(`/canvases/${canvas.id}/blocks`, {
      method: 'POST', body: JSON.stringify({ ...input, content: '# ' + input.title + '\nNative reading evidence.' }),
    });
    // Creation finds free space; explicit layout edits may deliberately share
    // coordinates, which is the public contract needed for stable reading ties.
    await api(`/canvases/${canvas.id}/blocks/${block.id}`, {
      method: 'PUT', body: JSON.stringify({ x: input.x, y: input.y, ...(group !== undefined ? { group } : {}) }),
    });
  }
  const before = await api<CanvasDocument>(`/canvases/${canvas.id}`);
  const snapshot = structuredClone(before);
  const order = ['Stable first', 'Stable second', 'Ungrouped right', 'Operations',
    'Engineering left', 'Engineering right', 'Engineering lower', 'Last row'];
  expect(readingSequence(before.blocks).map(block => block.title)).toEqual(order);
  expect(readingSequence([...before.blocks].reverse()).map(block => block.title)).toEqual([
    'Stable second', 'Stable first', ...order.slice(2),
  ]);
  expect(readingSequence([])).toEqual([]);
  expect(before).toEqual(snapshot);
  const restarted = await fixture.reload(canvas.id);
  expect(restarted).toEqual(snapshot);
  expect(readingSequence(restarted.blocks).map(block => block.title)).toEqual(order);
  expect(await fixture.reload()).toEqual(fixture.canvas);
});
