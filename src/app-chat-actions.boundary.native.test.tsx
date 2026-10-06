// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../shared/types';
import { CanvasStore } from '../server/storage';
import { api } from './api';
import { useAppModel } from './app-model';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';

afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await closeWorkspaceFixtures(); });

function legacy(block: CanvasBlock): CanvasBlock { return { ...block, incarnation: undefined, sourceGeneration: undefined }; }
async function fixture() {
  const native = await workspaceFixture();
  sessionStorage.clear(); window.history.replaceState(null, '', '/?canvas=' + native.canvas.id);
  const model = renderHook(useAppModel);
  await waitFor(() => expect(model.result.current.canvas?.id).toBe(native.canvas.id));
  const created = await api<CanvasBlock>(`/canvases/${native.canvas.id}/blocks`, { method: 'POST',
    body: JSON.stringify({ title: 'Legacy agent receipt', content: '# Original agent evidence' }) });
  return { ...native, ...model, created };
}

it.each(['already deleted', 'changed content', 'manual metadata', 'incoming reference'])('refuses legacy creation Undo after %s without changing the native canvas', async reason => {
  const native = await fixture(); const route = `/canvases/${native.canvas.id}/blocks/${native.created.id}`;
  if (reason === 'already deleted') await api(route, { method: 'DELETE' });
  if (reason === 'changed content') await api(route, { method: 'PUT', body: JSON.stringify({ content: '# Later human evidence' }) });
  if (reason === 'manual metadata') await api(route, { method: 'PUT', body: JSON.stringify({ tags: ['human-correction'] }) });
  if (reason === 'incoming reference') await api(`/canvases/${native.canvas.id}/blocks/${native.canvas.blocks[0].id}`,
    { method: 'PUT', body: JSON.stringify({ links: [native.created.id] }) });
  const before = await native.reload();
  await act(async () => { await expect(native.result.current.undoAgentCreatedBlock(native.canvas.id, legacy(native.created))).rejects.toThrow(/gone|changed/); });
  expect(await native.reload()).toEqual(before);
  expect(native.calls.filter(call => call.route.endsWith('/jev/undo-parent'))).toEqual([]);
});

it('refuses legacy edited receipts whose quality changed and retains the actual saved quality and source', async () => {
  const native = await fixture();
  const after = await api<CanvasBlock>(`/canvases/${native.canvas.id}/blocks/${native.created.id}`, { method: 'PUT',
    body: JSON.stringify({ content: '# Agent revised evidence', quality: { score: .8, at: '2026-10-03T12:00:00.000Z' } }) });
  const before = await native.reload();
  await act(async () => { await expect(native.result.current.undoAgentEditedBlock(native.canvas.id,
    { before: legacy(native.created), after: legacy(after) })).rejects.toThrow('This quality change needs review in document history.'); });
  expect(await native.reload()).toEqual(before);
  expect((await native.reload()).blocks.find(block => block.id === after.id)?.quality).toEqual(after.quality);
});

it.each([false, true])('deletes an unchanged native document from a legacy receipt without requiring a legacy hash: %s', async omitHash => {
  const native = await fixture(); const snapshot = legacy(native.created);
  if (omitHash) snapshot.contentHash = undefined;
  await act(async () => { await native.result.current.undoAgentCreatedBlock(native.canvas.id, snapshot); });
  expect((await native.reload()).blocks.some(block => block.id === native.created.id)).toBe(false);
  expect((await native.reload()).blocks.map(block => block.id)).toEqual(native.canvas.blocks.map(block => block.id));
  expect(native.calls).toContainEqual(expect.objectContaining({ route: `/api/canvases/${native.canvas.id}/blocks/${native.created.id}`, method: 'DELETE' }));
});

it.each([false, true])('restores checked legacy edits with their actual original labels and native defaults: %s', async rich => {
  const native = await fixture(); const route = `/canvases/${native.canvas.id}/blocks/${native.created.id}`;
  const before = rich ? await api<CanvasBlock>(route, { method: 'PUT', body: JSON.stringify({
    archived: true, stale: true, tags: ['reviewed'], purpose: 'guide', reviewer: 'Owner', workArea: 'Delivery', group: 'custom:delivery',
    links: [native.canvas.blocks[0].id], linkTypes: { [native.canvas.blocks[0].id]: 'related' }, crossLinks: [],
  }) }) : native.created;
  const after = await api<CanvasBlock>(route, { method: 'PUT', body: JSON.stringify({
    title: 'Agent edit', content: '# Agent revised evidence', archived: false, stale: false, tags: ['agent'],
    purpose: 'plan', reviewer: 'Agent', workArea: 'New area', group: 'custom:agent', links: [], linkTypes: {},
  }) });
  await act(async () => { await native.result.current.undoAgentEditedBlock(native.canvas.id, { before: legacy(before), after: legacy(after) }); });
  const restored = (await new CanvasStore(native.root).getCanvas(native.canvas.id, true)).blocks.find(block => block.id === before.id)!;
  expect(restored).toMatchObject({ title: before.title, content: before.content, contentHash: before.contentHash,
    links: before.links, archived: before.archived ?? false, stale: before.stale ?? false, tags: before.tags ?? [] });
  for (const field of ['purpose', 'reviewer', 'group', 'workArea'] as const) expect(restored[field]).toBe(before[field]);
  expect(native.calls).toContainEqual(expect.objectContaining({ route: '/api' + route, method: 'PUT',
    body: expect.objectContaining({ message: `Undo agent edit to ${before.title}` }) }));
});

it.each(['deleted', 'manual metadata', 'unreviewed hash'])('refuses a legacy edit that has %s without reverting its canonical state', async reason => {
  const native = await fixture(); const route = `/canvases/${native.canvas.id}/blocks/${native.created.id}`;
  const after = await api<CanvasBlock>(route, { method: 'PUT', body: JSON.stringify({ content: '# Agent revised evidence' }) });
  if (reason === 'deleted') await api(route, { method: 'DELETE' });
  if (reason === 'manual metadata') await api(route, { method: 'PUT', body: JSON.stringify({ tags: ['human-correction'] }) });
  const reviewed = legacy(after); if (reason === 'unreviewed hash') reviewed.contentHash = undefined;
  const before = await native.reload();
  await act(async () => { await expect(native.result.current.undoAgentEditedBlock(native.canvas.id,
    { before: legacy(native.created), after: reviewed })).rejects.toThrow('This document changed again. Review its history before restoring it.'); });
  expect(await native.reload()).toEqual(before);
});
