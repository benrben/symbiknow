// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnswerCanvasTurn, AnswerSource } from '../shared/answer-canvas';
import { useAppModel } from './app-model';
import { useAssistantContext } from './app-assistant-context';
import { emptyResearchEdits } from './research-edits';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';

afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await closeWorkspaceFixtures();
});

function useModelContext() {
  const model = useAppModel();
  return { model, context: useAssistantContext(model) };
}

it('publishes titles context at group and subgroup focus before opening a real persisted reader', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  const { result } = renderHook(useModelContext);
  await waitFor(() => expect(result.current.model.canvas?.id).toBe(fixture.canvas.id));
  act(() => result.current.model.setCanvasViewFocus({ level: 'overview', visibleGroups: [] }));
  expect(result.current.context.viewMode).toBe('overview');
  act(() => result.current.model.setCanvasViewFocus({ level: 'groups', visibleGroups: ['area:engineering'] }));
  expect(result.current.context).toMatchObject({ viewMode: 'titles', visibleGroups: ['area:engineering'] });
  act(() => result.current.model.setCanvasViewFocus({ level: 'subgroups', activeGroup: 'area:engineering', visibleGroups: ['area:engineering/deployment'] }));
  expect(result.current.context).toMatchObject({ viewMode: 'titles', activeGroup: 'area:engineering', visibleGroups: ['area:engineering/deployment'] });
  const block = fixture.canvas.blocks[0];
  act(() => result.current.model.openReader(block.id));
  expect(result.current.context).toMatchObject({ viewMode: 'documents', readerBlockId: block.id, selectedBlockIds: [block.id], visibleBlockIds: [block.id] });
  expect(await fixture.reload()).toEqual(fixture.canvas);
});

it('describes a navigated document only while it is still visible, so Symbi does not keep a stale context', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  const { result } = renderHook(useModelContext);
  await waitFor(() => expect(result.current.model.canvas?.id).toBe(fixture.canvas.id));
  const block = fixture.canvas.blocks[0];
  act(() => result.current.model.showBlockOnCanvas(fixture.canvas.id, block.id, block.title));
  act(() => result.current.model.setVisibleBlockIds([block.id]));
  expect(result.current.context.focusBlockId).toBe(block.id);
  act(() => result.current.model.setVisibleBlockIds([]));
  expect(result.current.context.focusBlockId).toBeUndefined();
});

it('retains the focused research question, block and native source across a durable research save', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  const { result } = renderHook(useModelContext);
  await waitFor(() => expect(result.current.model.canvas?.id).toBe(fixture.canvas.id));
  const block = fixture.canvas.blocks[0];
  const source: AnswerSource = { canvasId: fixture.canvas.id, canvasName: fixture.canvas.name, blockId: block.id,
    title: block.title, contentHash: block.contentHash, excerpt: block.content, relevance: 1 };
  const turn: AnswerCanvasTurn = { id: 1, query: 'Focused research', answer: '# Native answer\nKeep the cited source.', status: 'complete', sources: [source] };
  act(() => result.current.model.restoreResearchSnapshot({ turns: [turn], edits: emptyResearchEdits(), layout: 'mindmap' }));
  expect(result.current.context.viewMode).toBe('answer');
  act(() => result.current.model.setAnswerCanvasViewFocus({ level: 'answers', visibleAnswerIds: [1], visibleBlockIds: ['1:section-1'],
    visibleSourceKeys: [`${source.canvasId}:${source.blockId}`], selectedAnswerId: 1, selectedBlockId: '1:section-1',
    selectedSourceKey: `${source.canvasId}:${source.blockId}` }));
  expect(result.current.context.answerFocus).toEqual({ level: 'answers', visibleQuestions: [turn.query], visibleBlockTitles: ['Native answer'],
    visibleSourceIds: [block.id], focusedQuestion: turn.query, focusedBlockTitle: 'Native answer', focusedSourceId: block.id });
  let saved!: { id: string; name: string };
  await act(async () => { saved = await result.current.model.saveResearchCanvas('mindmap'); });
  expect((await fixture.reload(saved.id)).blocks[0].crossLinks).toEqual([{ canvasId: source.canvasId, blockId: block.id, relation: 'related' }]);
  expect(result.current.context.answerFocus?.focusedBlockTitle).toBe('Native answer');
  expect(await fixture.reload()).toEqual(fixture.canvas);
});

it('retries a lost native search response through the public App action and retains the saved source', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  const { result } = renderHook(useAppModel);
  await waitFor(() => expect(result.current.canvas?.id).toBe(fixture.canvas.id));
  const held = fixture.hold('/api/search?q=Release%20guide', 'GET');
  act(() => { result.current.setSearchOpen(true); result.current.setSearchQuery('Release guide'); });
  const native = await held.response;
  expect(native.status).toBe(200);
  expect(await native.json()).toEqual(expect.arrayContaining([expect.objectContaining({ canvasId: fixture.canvas.id, blockId: fixture.canvas.blocks[0].id })]));
  await act(async () => held.fail('Native search response disconnected'));
  await waitFor(() => expect(result.current.searchError).toBe('Native search response disconnected'));
  expect(result.current.searchHits).toEqual([]);
  act(() => result.current.retrySearch());
  await waitFor(() => expect(result.current.searchHits).toEqual(expect.arrayContaining([expect.objectContaining({ canvasId: fixture.canvas.id, blockId: fixture.canvas.blocks[0].id })])));
  expect(result.current.searchError).toBe(''); expect(result.current.searchResultQuery).toBe('Release guide');
  expect(fixture.calls.filter(call => call.route === '/api/search?q=Release%20guide')).toHaveLength(2);
  expect(await fixture.reload()).toEqual(fixture.canvas);
});
