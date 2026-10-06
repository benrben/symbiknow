// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIElementsChatProps, DisplayTurn } from './chat-types';
import { useChatState } from './chat-state';
import { useChatProposals } from './chat-proposals';
import { useChatInvestigations } from './chat-investigations';
import { useChatModel } from './chat-model';
import { createRunEvents } from './chat-run-events';
import type { CanvasBlock } from '../shared/types';
import type { ResearchCanvasPatch } from '../shared/answer-canvas';
import type { InvestigationRecord } from './SavedInvestigations';

const block: CanvasBlock = { id: 'qa', title: 'QA', content: 'Original', file: 'qa.md', kind: 'markdown', x: 0, y: 0, width: 300, height: 200, links: [] };
const edit = { before: block, after: { ...block, content: 'Updated' } };
const proposal = { id: 'review', status: 'pending' as const, canvasId: 'planning', changes: [{ id: 'change', type: 'edit' as const, blockId: block.id, title: block.title, ...edit, expectedContentHash: null }] };
const patch: ResearchCanvasPatch = { query: 'QA', blocks: [], edges: [] };
const source = { canvasId: 'planning', query: 'QA', selection: 'local' as const, sources: [] };
const target = { kind: 'document' as const, canvasId: 'planning', blockId: block.id, title: block.title };
function props(): AIElementsChatProps {
  return { canvasId: 'planning', canvas: null, answerTurns: [], viewContext: { selectedBlockIds: [] }, hasApiKey: true, model: 'test-model', onOpenSettings: vi.fn(), onCanvasChanged: vi.fn(async () => ({ created: [], updated: [] })), onShowBlock: vi.fn(), onNavigate: vi.fn(), onReturnNavigation: vi.fn(), onUndoCreatedBlock: vi.fn(), onUndoEditedBlock: vi.fn(), onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(), onCanvasAnswer: vi.fn(), onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn() };
}
const initial: DisplayTurn[] = [{ id: 1, role: 'user', content: 'Review QA', activities: [] }, { id: 2, role: 'assistant', content: '', activities: [] }];
beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('stream callback ownership boundary', () => {
  it('drops every callback from a cancelled run without changing state, activity IDs or parent research/navigation', () => {
    const current = props(); const hook = renderHook(useChatState); act(() => hook.result.current.commit(initial));
    const state = hook.result.current; const handlers = createRunEvents(current, state, 2, () => false);
    act(() => {
      handlers.onChunk('Stale'); handlers.onStep!({ type: 'thinking', message: 'Stale thought' }); handlers.onReset!(); handlers.onAnswerCanvas!(source); handlers.onNavigation!(target); handlers.onResearchPatch!(patch); handlers.onProposal!(proposal);
    });
    expect(hook.result.current.turns).toEqual(initial); expect(hook.result.current.status).toBe('ready'); expect(state.nextActivityId.current).toBe(0);
    for (const callback of [current.onCanvasAnswer, current.onCanvasSources, current.onNavigate, current.onCanvasPatch]) expect(callback).not.toHaveBeenCalled();
  });

  it('routes research events to the owning assistant', () => {
    const current = props(); const hook = renderHook(useChatState); act(() => hook.result.current.commit(initial));
    const handlers = createRunEvents(current, hook.result.current, 2, () => true);
    act(() => { handlers.onResearchPatch!(patch); });
    expect(hook.result.current.turns[0]).toEqual(initial[0]); expect(hook.result.current.turns[1]).toMatchObject({ researchPatch: patch });
    expect(current.onCanvasPatch).toHaveBeenCalledWith(2, patch);
  });

  it('handles a transport chunk for a missing assistant without inventing a turn or crashing', () => {
    const current = props(); const hook = renderHook(useChatState); act(() => hook.result.current.commit([initial[0]]));
    act(() => createRunEvents(current, hook.result.current, 999, () => true).onChunk('Orphaned text'));
    expect(hook.result.current.turns).toEqual([initial[0]]); expect(current.onCanvasAnswer).toHaveBeenCalledWith(999, ''); expect(hook.result.current.status).toBe('streaming');
  });
});

describe('proposal action boundary validation', () => {
  it('does not write or invoke undo for unknown turns, missing canvas ownership, empty selections or wrong lifecycle states', async () => {
    const current = props(); const hook = renderHook(() => { const state = useChatState(); return { state, actions: useChatProposals(current, state) }; });
    const plain = { ...initial[1], createdBlocks: [block], editedBlocks: [edit] }; act(() => hook.result.current.state.commit([initial[0], plain]));
    await act(async () => { await hook.result.current.actions.undoCreated(999, block); await hook.result.current.actions.undoCreated(2, block); await hook.result.current.actions.undoEdited(999, edit); await hook.result.current.actions.undoEdited(2, edit); await hook.result.current.actions.applyProposal(999); await hook.result.current.actions.undoProposal(999); });
    act(() => hook.result.current.state.commit([{ ...plain, proposal, proposalState: 'applied', selectedProposalIds: ['change'] }])); await act(async () => hook.result.current.actions.applyProposal(2));
    act(() => hook.result.current.state.commit([{ ...plain, proposal, proposalState: 'pending' }])); await act(async () => { await hook.result.current.actions.applyProposal(2); await hook.result.current.actions.undoProposal(2); });
    expect(fetch).not.toHaveBeenCalled(); expect(current.onUndoCreatedBlock).not.toHaveBeenCalled(); expect(current.onUndoEditedBlock).not.toHaveBeenCalled();
  });

  it('defaults missing selection storage to empty, ignores foreign/blocked changes and never duplicates a selected change', () => {
    const current = props(); const hook = renderHook(() => { const state = useChatState(); return { state, actions: useChatProposals(current, state) }; });
    const staged = { ...initial[1], proposal: { ...proposal, changes: [...proposal.changes, { ...proposal.changes[0], id: 'blocked', canApply: false }] }, proposalState: 'pending' as const };
    act(() => hook.result.current.state.commit([initial[0], staged])); act(() => hook.result.current.actions.selectProposal(2, 'change', false)); expect(hook.result.current.state.turns[1].selectedProposalIds).toEqual([]);
    act(() => hook.result.current.state.commit([initial[0], staged])); act(() => hook.result.current.actions.selectProposal(2, 'change', true)); act(() => hook.result.current.actions.selectProposal(2, 'change', true));
    act(() => { hook.result.current.actions.selectProposal(999, 'change', true); hook.result.current.actions.selectProposal(2, 'unknown', true); hook.result.current.actions.selectProposal(2, 'blocked', true); });
    expect(hook.result.current.state.turns[1].selectedProposalIds).toEqual(['change']); expect(hook.result.current.state.turns[0]).toEqual(initial[0]);
  });

  it('rejects Jev proposal references at the chat proposal boundary without a request or a new turn', async () => {
    const current = props(); const hook = renderHook(() => { const state = useChatState(); return { state, actions: useChatInvestigations(current, state, vi.fn()) }; });
    const record: InvestigationRecord = { id: 'saved', workspaceId: 'team', title: 'Saved', visibility: 'shared', messages: [], sourceRefs: [], proposalRefs: [], revision: 1, createdAt: '', updatedAt: '' };
    await expect(hook.result.current.actions.openInvestigationProposal({ kind: 'jev', id: 'job' }, record)).rejects.toThrow('This saved legacy proposal is no longer available.'); expect(fetch).not.toHaveBeenCalled(); expect(hook.result.current.state.turns).toEqual([]);
  });
});


describe('run completion boundary', () => {

  it('keeps a transport failure recoverable when the direct run boundary receives an empty question', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Disconnected')); const hook = renderHook(() => useChatModel(props())); act(() => hook.result.current.submit(''));
    await waitFor(() => expect(hook.result.current.error).toContain('server is unavailable')); expect(hook.result.current.input).toBe(''); expect(hook.result.current.status).toBe('ready'); expect(hook.result.current.activeRef.current).toBeNull();
  });
});
