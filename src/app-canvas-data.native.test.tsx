// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { useAppState } from './app-state';
import { useCanvasData } from './app-canvas-data';
import { useCanvasNavigationActions } from './app-navigation';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';
import { createDoc } from './webmcp-documents';

afterEach(async () => { cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function canvasSession() { return renderHook(() => { const state = useAppState(); return { state, actions: useCanvasData(state), navigation: useCanvasNavigationActions(state) }; }); }
it.each([false, true])('keeps a current native reader selection while explicit URL document preference is %s', async explicit => {
  const fixture = await workspaceFixture(); const [current, requested] = fixture.canvas.blocks;
  window.history.replaceState(null, '', `/?canvas=${fixture.canvas.id}${explicit ? `&doc=${requested.id}` : ''}`);
  const delayed = fixture.hold(`/api/canvases/${fixture.canvas.id}?summary=1`, 'GET');
  const hook = canvasSession(); await delayed.response;
  act(() => hook.result.current.state.setReaderId(current.id));
  await act(async () => { await delayed.release(); });
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id));
  expect(hook.result.current.state.readerId).toBe(explicit ? requested.id : current.id);
  expect((await fixture.reload()).blocks.map(block => block.id)).toContain(hook.result.current.state.readerId);
});
it('clears a vanished explicit native source rather than retaining an unrelated reader', async () => {
  const fixture = await workspaceFixture(); const [removed, other] = fixture.canvas.blocks;
  await fixture.store.deleteBlock(fixture.canvas.id, removed.id);
  window.history.replaceState(null, '', `/?canvas=${fixture.canvas.id}&doc=${removed.id}`);
  const delayed = fixture.hold(`/api/canvases/${fixture.canvas.id}?summary=1`, 'GET');
  const hook = canvasSession(); await delayed.response;
  act(() => hook.result.current.state.setReaderId(other.id));
  await act(async () => { await delayed.release(); });
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id));
  expect(hook.result.current.state.readerId).toBe('');
  expect(hook.result.current.state.canvas?.blocks.some(block => block.id === removed.id)).toBe(false);
});
it('ignores an obsolete native canvas response after the current reader choice moves to another canvas', async () => {
  const fixture = await workspaceFixture();
  const target = await fixture.store.createBlock(fixture.secondCanvas.id, { title: 'Foreign checked reader', content: '# Foreign source' });
  window.history.replaceState(null, '', `/?canvas=${fixture.canvas.id}`);
  const hook = canvasSession();
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id));
  const delayed = fixture.hold(`/api/canvases/${fixture.secondCanvas.id}?summary=1`, 'GET');
  act(() => hook.result.current.navigation.navigateFromChat({ kind: 'document', canvasId: fixture.secondCanvas.id, blockId: target.id, title: target.title, excerpt: target.content }));
  await delayed.response;
  const current = fixture.canvas.blocks[0];
  act(() => hook.result.current.navigation.navigateFromChat({ kind: 'document', canvasId: fixture.canvas.id, blockId: current.id, title: current.title, excerpt: current.content }));
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id));
  await act(async () => { await delayed.release(); });
  expect(hook.result.current.state.readerId).toBe(fixture.canvas.blocks[0].id);
  expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id);
});

it('refreshes native workspace navigation while keeping a newer selection and preserving the same current document', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', `/?canvas=${fixture.canvas.id}`);
  const hook = canvasSession();
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id));
  const current = hook.result.current.state.canvas;
  const added = await fixture.store.createCanvas(fixture.secondWorkspace.id, { name: 'New checked workspace canvas' });
  await act(async () => { await hook.result.current.actions.refreshWorkspaces(added.id, () => false); });
  expect(hook.result.current.state.workspaces.flatMap(workspace => workspace.canvases).some(canvas => canvas.id === added.id)).toBe(true);
  expect(hook.result.current.state.canvasId).toBe(fixture.canvas.id);
  expect(hook.result.current.state.canvas).toBe(current);
  await act(async () => { await hook.result.current.actions.refreshWorkspaces(fixture.canvas.id); });
  expect(hook.result.current.state.canvas).toBe(current);
});

it('keeps Reflex reads bodyless and preserves unchanged native canvas and document identities', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', `/?canvas=${fixture.canvas.id}`);
  const hook = canvasSession();
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id));
  const before = hook.result.current.state.canvas!;
  act(() => { hook.result.current.state.setShowChat(true); hook.result.current.state.setAssistantView('reflex'); });
  await act(async () => { await hook.result.current.actions.loadCanvas(); });
  expect(hook.result.current.state.canvas).toBe(before);
  expect(hook.result.current.state.canvas?.blocks).toBe(before.blocks);
  expect(fixture.calls.filter(call => call.route.startsWith(`/api/canvases/${fixture.canvas.id}`))
    .every(call => call.route === `/api/canvases/${fixture.canvas.id}?summary=1`)).toBe(true);
  expect(hook.result.current.state.canvas?.blocks.every(block => block.content === '' && block.contentLoaded === false)).toBe(true);
  await act(async () => { await hook.result.current.actions.refreshAfterVersionChange(); });
  expect(hook.result.current.state.canvas).toBe(before);
});

it('updates changed native source metadata while retaining every unchanged document reference', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', `/?canvas=${fixture.canvas.id}`);
  const hook = canvasSession();
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id));
  const before = hook.result.current.state.canvas!;
  const changed = before.blocks[0];
  await fixture.store.updateBlock(before.id, changed.id, { tags: ['Fresh classification'] }, 'Symbi Reflex');
  await act(async () => { await hook.result.current.actions.loadCanvas(); });
  const classified = hook.result.current.state.canvas!;
  expect(classified).not.toBe(before);
  expect(classified.blocks[0]).not.toBe(changed);
  expect(classified.blocks[0].tags).toEqual(['Fresh classification']);
  expect(classified.blocks[1]).toBe(before.blocks[1]);
  await fixture.store.updateBlock(before.id, changed.id, { content: '# Fresh source body\nA meaningful new release checkpoint.' }, 'Browser');
  await act(async () => { await hook.result.current.actions.loadCanvas(); });
  const edited = hook.result.current.state.canvas!;
  expect(edited.blocks[0].content).toBe('');
  expect(edited.blocks[0].sourceGeneration).toBe(classified.blocks[0].sourceGeneration! + 1);
  expect(edited.blocks[1]).toBe(before.blocks[1]);
  const fresh = await fixture.reload();
  expect(fresh.blocks[0].content).toBe('# Fresh source body\nA meaningful new release checkpoint.');
  await writeFile(path.join(fixture.root, changed.file), '# Outside source edit\nA later change written directly to the source file.');
  await act(async () => { await hook.result.current.actions.loadCanvas(); });
  const outside = hook.result.current.state.canvas!;
  expect(outside.blocks[0]).not.toBe(edited.blocks[0]);
  expect(outside.blocks[1]).toBe(before.blocks[1]);
  expect((await fixture.reload()).blocks[0].content).toBe('# Outside source edit\nA later change written directly to the source file.');
  act(() => {
    hook.result.current.state.setDraftBlock({ id: changed.id, title: changed.title, kind: 'markdown', content: '# Existing editor draft' });
    hook.result.current.state.setDialog('block');
  });
  await act(async () => { await hook.result.current.actions.loadCanvas(); });
  expect(hook.result.current.state.canvas?.blocks[0].content).toBe('# Outside source edit\nA later change written directly to the source file.');
  expect(hook.result.current.state.canvas?.blocks[0].contentLoaded).toBe(true);
  expect(hook.result.current.state.canvas?.blocks[1]).toBe(before.blocks[1]);
  expect(hook.result.current.state.draftBlock.content).toBe('# Existing editor draft');
});

it('refreshes a real WebMCP source write, reports a lost read response, and retains the durable new document', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', `/?canvas=${fixture.canvas.id}`);
  const hook = canvasSession();
  await waitFor(() => expect(hook.result.current.state.canvas?.id).toBe(fixture.canvas.id));
  const before = hook.result.current.state.canvas!;
  const refresh = fixture.hold(`/api/canvases/${fixture.canvas.id}?summary=1`, 'GET');
  await act(async () => { await createDoc({ title: 'Saved through WebMCP', content: '# Native tool source\nA durable source written by the public tool.' }); });
  await refresh.response;
  await act(async () => { refresh.fail('Saved canvas read interrupted'); });
  await waitFor(() => expect(hook.result.current.state.error).toBe('Saved canvas read interrupted'));
  expect(hook.result.current.state.canvas).toBe(before);
  expect((await fixture.reload()).blocks.some(block => block.title === 'Saved through WebMCP')).toBe(true);
  await act(async () => { await hook.result.current.actions.loadCanvas(); });
  const after = hook.result.current.state.canvas!;
  expect(after.blocks).toHaveLength(before.blocks.length + 1);
  expect(after.blocks.slice(0, before.blocks.length)).toEqual(before.blocks);
  for (const [index, block] of before.blocks.entries()) expect(after.blocks[index]).toBe(block);
  expect(after.blocks.at(-1)?.contentLoaded).toBe(false);
});
