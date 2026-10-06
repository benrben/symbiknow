// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAppModel } from './app-model';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';

afterEach(async () => {
  cleanup();
  await closeWorkspaceFixtures();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('opens fresh canvas metadata and loads just the document being edited', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  const { result } = renderHook(useAppModel);
  await waitFor(() => expect(result.current.canvas?.id).toBe(fixture.canvas.id));
  expect(result.current.canvas!.blocks.every(block => block.content === '' && block.contentLoaded === false)).toBe(true);
  expect(fixture.calls.some(call => call.route === `/api/canvases/${fixture.canvas.id}?summary=1`)).toBe(true);
  const block = result.current.canvas!.blocks[0];
  await act(async () => { await result.current.openBlock(block); });
  expect(result.current.draftBlock).toMatchObject({ id: block.id, content: fixture.canvas.blocks[0].content });
  expect(result.current.draftBlock.contentHash).toBeTruthy();
  expect(fixture.calls.filter(call => /\/blocks\/[^/]+$/.test(call.route) && call.method === 'GET')).toHaveLength(1);
  act(() => { result.current.setDialog(null); result.current.selectCanvas(fixture.secondCanvas.id); });
  await waitFor(() => expect(result.current.canvas?.id).toBe(fixture.secondCanvas.id));
  await fixture.store.updateBlock(fixture.canvas.id, block.id, { title: 'Changed while away' });
  act(() => result.current.selectCanvas(fixture.canvas.id));
  expect(result.current.canvas).toBeNull();
  await waitFor(() => expect(result.current.canvas?.blocks[0].title).toBe('Changed while away'));
  expect(fixture.calls.filter(call => call.route === `/api/canvases/${fixture.canvas.id}?summary=1`)).toHaveLength(2);
});

it('keeps a failed document load out of the editor and retries with the saved content', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  const { result } = renderHook(useAppModel);
  await waitFor(() => expect(result.current.canvas?.id).toBe(fixture.canvas.id));
  const block = result.current.canvas!.blocks[0];
  const held = fixture.hold(`/api/canvases/${fixture.canvas.id}/blocks/${block.id}`, 'GET');
  let opening!: Promise<void> | undefined;
  act(() => { opening = result.current.openBlock(block); });
  await held.response;
  await act(async () => { held.fail('Could not read the saved document'); await opening; });
  expect(result.current.dialog).toBeNull();
  expect(result.current.error).toBe('Could not read the saved document');
  await act(async () => { await result.current.openBlock(block); });
  expect(result.current.draftBlock.content).toBe(fixture.canvas.blocks[0].content);
});

it('keeps a late document failure out of the canvas navigated to afterward', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  const { result } = renderHook(useAppModel);
  await waitFor(() => expect(result.current.canvas?.id).toBe(fixture.canvas.id));
  const block = result.current.canvas!.blocks[0];
  const held = fixture.hold(`/api/canvases/${fixture.canvas.id}/blocks/${block.id}`, 'GET');
  let opening!: Promise<void> | undefined;
  act(() => { opening = result.current.openBlock(block); });
  await held.response;
  act(() => result.current.selectCanvas(fixture.secondCanvas.id));
  await waitFor(() => expect(result.current.canvas?.id).toBe(fixture.secondCanvas.id));

  await act(async () => { held.fail('The previous document could not load'); await opening; });

  expect(result.current.canvas?.id).toBe(fixture.secondCanvas.id);
  expect(result.current.error).toBe('');
  expect(result.current.dialog).toBeNull();
  expect(result.current.draftBlock.id).toBeUndefined();
});

it.each(['new document', 'dialog', 'navigation', 'canvas'])('ignores an editor load after a newer %s action', async action => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  const { result } = renderHook(useAppModel);
  await waitFor(() => expect(result.current.canvas?.id).toBe(fixture.canvas.id));
  const block = result.current.canvas!.blocks[0];
  const held = fixture.hold(`/api/canvases/${fixture.canvas.id}/blocks/${block.id}`, 'GET');
  let opening!: Promise<void> | undefined;
  act(() => { opening = result.current.openBlock(block); });
  await held.response;
  act(() => {
    if (action === 'new document') result.current.openNewBlock();
    if (action === 'dialog') result.current.setDialog('settings');
    if (action === 'navigation') result.current.showBlockOnCanvas(fixture.canvas.id, block.id, block.title);
    if (action === 'canvas') result.current.setCanvasId(fixture.secondCanvas.id);
  });
  const currentDialog = result.current.dialog;
  const currentDraft = result.current.draftBlock;
  await act(async () => { await held.release(); await opening; });
  expect(result.current.dialog).toBe(currentDialog);
  expect(result.current.draftBlock).toBe(currentDraft);
});
