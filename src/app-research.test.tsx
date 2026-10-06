// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerCanvasTurn, ResearchCanvasPatch } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';
import { useAppState } from './app-state';
import { researchStorageKey } from './app-state-helpers';
import { chatHistoryKey } from './chat-history';
import { useResearchSession } from './app-research';
import { emptyResearchEdits } from './research-edits';
import type { InvestigationResearchSnapshot } from './SavedInvestigations';

const patch: ResearchCanvasPatch = { query: 'Release readiness', blocks: [
  { id: 'evidence', type: 'text', title: 'Evidence', content: 'Tests pass', sourceIds: [] },
  { id: 'decision', type: 'section', title: 'Decision', content: 'Review before release', sourceIds: [] },
], edges: [{ from: 'evidence', to: 'decision', label: 'supports' }] };
const turn: AnswerCanvasTurn = { id: 1, query: patch.query, answer: 'Original', sources: [], status: 'complete', patch };
function session() {
  return renderHook(() => { const state = useAppState(); return { state, actions: useResearchSession(state) }; });
}
beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('research session actions', () => {
  it('opens the first answer with its layout, updates its sources, and preserves other turns', () => {
    const { result } = session();
    const answer = { query: 'First', canvasId: 'planning', selection: 'local' as const, sources: [], layout: 'roadmap' as const };
    act(() => result.current.actions.addAnswerSources(1, answer));
    expect(result.current.state.answerCanvasOpen).toBe(true);
    expect(result.current.state.researchLayout).toBe('roadmap');
    act(() => result.current.actions.addAnswerSources(2, { ...answer, query: 'Second', layout: 'kanban' }));
    act(() => result.current.actions.addAnswerSources(1, { ...answer, query: 'Updated', selection: 'jev' }));
    act(() => result.current.actions.updateAnswerText(1, 'Updated answer'));
    act(() => result.current.actions.settleAnswerTurn(1, 'complete'));
    expect(result.current.state.answerTurns).toMatchObject([
      { id: 1, query: 'Updated', answer: 'Updated answer', status: 'complete', selection: 'jev' },
      { id: 2, query: 'Second', answer: '', status: 'working' },
    ]);
    expect(result.current.state.researchLayout).toBe('roadmap');
  });

  it('opens a first answer without overriding the chosen layout when no layout is supplied', () => {
    const { result } = session();
    act(() => result.current.state.setResearchLayout('architecture'));
    act(() => result.current.actions.addAnswerSources(1, { query: 'First', canvasId: 'planning', selection: 'local', sources: [] }));
    expect(result.current.state.researchLayout).toBe('architecture');
  });

  it('merges streamed patches by block and edge identity and keeps unrelated turns intact', () => {
    const { result } = session();
    act(() => result.current.actions.applyResearchPatch(1, { ...patch, layout: 'architecture' }));
    expect(result.current.state.answerCanvasOpen).toBe(true);
    expect(result.current.state.researchLayout).toBe('architecture');
    act(() => result.current.actions.addAnswerSources(2, { query: 'Second', canvasId: 'planning', selection: 'local', sources: [] }));
    act(() => result.current.actions.applyResearchPatch(2, { ...patch, layout: 'kanban' }));
    act(() => result.current.actions.applyResearchPatch(1, { query: patch.query,
      blocks: [{ ...patch.blocks[0], content: 'More evidence' }, { id: 'next', type: 'task', title: 'Next', content: 'Ship', sourceIds: [] }],
      edges: [{ from: 'evidence', to: 'decision', label: 'confirms' }, { from: 'decision', to: 'next' }],
    }));
    expect(result.current.state.answerTurns[0].patch?.blocks.map(block => block.id)).toEqual(['evidence', 'decision', 'next']);
    expect(result.current.state.answerTurns[0].patch?.blocks[0].content).toBe('More evidence');
    expect(result.current.state.answerTurns[0].patch?.edges).toEqual([
      { from: 'evidence', to: 'decision', label: 'confirms' }, { from: 'decision', to: 'next' },
    ]);
    expect(result.current.state.answerTurns[1].patch).toEqual({ ...patch, layout: 'kanban' });
    expect(result.current.state.researchLayout).toBe('architecture');
  });

  it('does not invent a layout for a first patch and preserves a later source-only turn', () => {
    const { result } = session();
    act(() => result.current.actions.applyResearchPatch(1, patch));
    act(() => result.current.actions.addAnswerSources(2, { query: 'Other', canvasId: 'planning', selection: 'local', sources: [] }));
    expect(result.current.state.answerTurns[1].patch).toBeUndefined();
    expect(result.current.state.researchLayout).toBe('mindmap');
  });

  it('summarizes selected blocks and then the edited research graph, preserving prompt sequences', () => {
    const { result } = session();
    const selected: CanvasBlock = { id: 'note', title: 'Context', file: 'note.md', kind: 'markdown', content: 'x'.repeat(300), x: 0, y: 0, width: 400, height: 290, links: [] };
    act(() => result.current.actions.summarizeResearchSelection([selected]));
    expect(result.current.state.chatPromptRequest).toEqual({ text: 'Summarize these research blocks and explain how they connect: Context: ' + 'x'.repeat(220), sequence: 1 });
    act(() => result.current.state.setAnswerTurns([turn]));
    act(() => result.current.actions.summarizeCurrentResearch());
    expect(result.current.state.chatPromptRequest?.text).toContain('Evidence: Tests pass | Decision: Review before release');
    expect(result.current.state.chatPromptRequest?.sequence).toBe(2);
    expect(result.current.state.assistantView).toBe('chat');
    expect(result.current.state.showChat).toBe(true);
    act(() => result.current.actions.changeResearchEdits({ ...emptyResearchEdits(), added: [
      { id: 'manual', turnId: 1, type: 'text', title: 'Manual note', content: 'Keep this', markdown: '', sources: [], x: 0, y: 0 },
    ] }));
    act(() => result.current.actions.summarizeCurrentResearch());
    expect(result.current.state.chatPromptRequest?.text).toContain('Manual note: Keep this');
  });

  it('queues actions with files and increments requests even when the same action is repeated', () => {
    const { result } = session();
    const files = [new File(['# Research'], 'notes.md')];
    act(() => result.current.actions.requestResearchAction('upload', files));
    expect(result.current.state.researchActionRequest).toEqual({ kind: 'upload', files, sequence: 1 });
    act(() => result.current.actions.requestResearchAction('search'));
    expect(result.current.state.researchActionRequest).toEqual({ kind: 'search', files: undefined, sequence: 2 });
  });

  it('restores stopped and complete snapshots, then clears a missing snapshot', () => {
    const { result } = session();
    const edits = { ...emptyResearchEdits(), deleted: ['1:decision'] };
    act(() => result.current.actions.restoreResearchSnapshot({ turns: [{ ...turn, status: 'working' }, { ...turn, id: 2 }], edits, layout: 'roadmap' }));
    expect(result.current.state.answerTurns.map(item => item.status)).toEqual(['stopped', 'complete']);
    expect(result.current.state.researchState).toEqual({ edits, history: [] });
    expect(result.current.state.researchLayout).toBe('roadmap');
    expect(result.current.state.answerCanvasOpen).toBe(true);
    act(() => result.current.actions.restoreResearchSnapshot());
    expect(result.current.state.answerTurns).toEqual([]);
    expect(result.current.state.researchState).toEqual({ edits: emptyResearchEdits(), history: [] });
    expect(result.current.state.researchLayout).toBe('mindmap');
    expect(result.current.state.answerCanvasOpen).toBe(false);
    act(() => result.current.actions.restoreResearchSnapshot({ turns: [turn] } as InvestigationResearchSnapshot));
    expect(result.current.state.researchState.edits).toEqual(emptyResearchEdits());
    expect(result.current.state.researchLayout).toBe('mindmap');
  });

  it('rechecks only existing answers, increments prompts, and opens the chat', () => {
    const { result } = session();
    act(() => result.current.actions.recheckAnswer());
    expect(result.current.state.chatPromptRequest).toBeUndefined();
    act(() => result.current.state.setAnswerTurns([turn]));
    act(() => result.current.actions.recheckAnswer());
    act(() => result.current.actions.recheckAnswer());
    expect(result.current.state.chatPromptRequest).toEqual({ text: 'What changed in the sources for this conversation, and which earlier answers need updating?', sequence: 2 });
    expect(result.current.state.showChat).toBe(true);
  });

  it('caps edit undo history at 30, restores previous edits, and tolerates an empty history', () => {
    const { result } = session();
    act(() => result.current.actions.undoResearchEdit());
    expect(result.current.state.researchState.history).toEqual([]);
    for (let index = 0; index < 32; index++) act(() => result.current.actions.changeResearchEdits({ ...emptyResearchEdits(), deleted: [`${index}`] }));
    expect(result.current.state.researchState.history).toHaveLength(30);
    act(() => result.current.actions.undoResearchEdit());
    expect(result.current.state.researchState.edits.deleted).toEqual(['30']);
    expect(JSON.parse(window.localStorage.getItem(researchStorageKey)!)).toMatchObject({ edits: { deleted: ['30'] } });
  });

  it.each([false, true])('clears in-memory conversation and queued prompts despite storage failure=%s', storageFailure => {
    const { result } = session();
    window.localStorage.setItem(chatHistoryKey, 'history');
    act(() => {
      result.current.state.setAnswerTurns([turn]); result.current.state.setChatHasHistory(true);
      result.current.state.setChatPromptRequest({ text: 'Old', sequence: 8 });
      result.current.state.setResearchSaveCount(3); result.current.state.setActiveInvestigation({ id: 'saved', canvasId: 'planning' });
      result.current.state.setInvestigationOpenRequest({ id: 'saved', sequence: 1 });
    });
    if (storageFailure) vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage denied'); });
    act(() => result.current.actions.newChat());
    expect(result.current.state).toMatchObject({ chatSession: 1, chatHasHistory: false, chatPromptRequest: undefined,
      answerTurns: [], activeInvestigation: undefined, investigationOpenRequest: undefined, researchSaveCount: 0,
      answerCanvasOpen: false, researchLayout: 'mindmap', symbiState: 'idle' });
    if (!storageFailure) expect(window.localStorage.getItem(chatHistoryKey)).toBeNull();
  });

  it('keeps an editable session when browser persistence is unavailable', () => {
    const { result } = session();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    act(() => result.current.state.setAnswerTurns([turn]));
    expect(result.current.state.answerTurns).toEqual([turn]);
    act(() => result.current.actions.changeResearchEdits({ ...emptyResearchEdits(), deleted: ['1:decision'] }));
    expect(result.current.state.researchState.edits.deleted).toEqual(['1:decision']);
  });
});
