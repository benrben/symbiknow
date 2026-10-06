// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatModel } from './chat-model';
import type { AIElementsChatProps, DisplayTurn } from './chat-types';

const assistant: DisplayTurn = { id: 2, role: 'assistant', content: 'Prepared changes', activities: [] };
const proposal = { id: 'proposal', canvasId: 'planning', status: 'pending' as const, changes: [] };

function props(): AIElementsChatProps {
  return { canvasId: 'planning', canvas: null, viewContext: { selectedBlockIds: [] }, answerTurns: [],
    hasApiKey: true, model: 'test-model', onOpenSettings: vi.fn(),
    onCanvasChanged: vi.fn(async () => ({ created: [], updated: [] })), onShowBlock: vi.fn(),
    onNavigate: vi.fn(), onReturnNavigation: vi.fn(), onUndoCreatedBlock: vi.fn(),
    onUndoEditedBlock: vi.fn(), onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(), onCanvasAnswer: vi.fn(),
    onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn() };
}

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { body, push(value: string) { controller.enqueue(new TextEncoder().encode(value)); } };
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Symbi real request and review avatar events', () => {
  it('receives a request, evaluates streamed activity, speaks an answer, then celebrates success', async () => {
    const response = stream(); const current = props();
    vi.mocked(fetch).mockResolvedValue(new Response(response.body));
    const hook = renderHook(() => useChatModel(current));
    expect(hook.result.current.avatarState).toBe('idle');
    act(() => hook.result.current.submit('Find the plan'));
    expect(hook.result.current.avatarState).toBe('listening');
    await act(async () => response.push('event: agent_step\ndata: {"type":"thinking","message":"Evaluating sources"}\n\n'));
    expect(hook.result.current.avatarState).toBe('thinking');
    await act(async () => response.push('data: {"choices":[{"delta":{"content":"The release is ready."}}]}\n\n'));
    expect(hook.result.current.avatarState).toBe('speaking');
    await act(async () => response.push('data: [DONE]\n\n'));
    await waitFor(() => expect(hook.result.current.avatarState).toBe('done'));
    expect(current.onCanvasTurnEnd).toHaveBeenCalledWith(2, 'complete');
  });

  it('waits for a decision instead of celebrating an unapplied proposal', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(`event: chat_proposal\ndata: ${JSON.stringify(proposal)}\n\ndata: [DONE]\n\n`));
    const hook = renderHook(() => useChatModel(props()));
    act(() => hook.result.current.submit('Prepare changes'));
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    expect(hook.result.current.avatarState).toBe('asking');
  });

  it('shows authorized proposal application even when the applying proposal is earlier in the conversation', () => {
    const hook = renderHook(() => useChatModel(props()));
    act(() => hook.result.current.commit([{ ...assistant, proposal, proposalState: 'applying' }, { ...assistant, id: 3 }]));
    expect(hook.result.current.avatarState).toBe('writing');
    act(() => hook.result.current.commit([{ ...assistant, proposal, proposalState: 'applied' }]));
    expect(hook.result.current.avatarState).toBe('idle');
  });

  it('surfaces proposal and connection failures without a success pose', () => {
    const hook = renderHook(() => useChatModel(props()));
    act(() => hook.result.current.commit([{ ...assistant, proposal, proposalState: 'pending', proposalError: 'Please retry' }]));
    expect(hook.result.current.avatarState).toBe('error');
    act(() => hook.result.current.setConnection('checking'));
    expect(hook.result.current.avatarState).toBe('checking');
    act(() => hook.result.current.setError('Unavailable'));
    expect(hook.result.current.avatarState).toBe('error');
  });
});

describe('Symbi success is confirmed after refresh', () => {
  it('clears old completion feedback when resetting a conversation so it cannot interrupt the next answer', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(async () => new Response('data: [DONE]\n\n'));
    const hook = renderHook(() => useChatModel(props()));
    await act(async () => hook.result.current.submit('Finish the first answer'));
    expect(hook.result.current.avatarState).toBe('done');
    act(() => hook.result.current.cancelConversation());
    expect(hook.result.current.avatarState).toBe('idle');
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => hook.result.current.submit('Finish the next answer'));
    expect(hook.result.current.avatarState).toBe('done');
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(hook.result.current.avatarState).toBe('done');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(hook.result.current.avatarState).toBe('idle');
  });

  it('never celebrates while a failed canvas refresh is pending or after it fails', async () => {
    let rejectRefresh!: (reason: Error) => void;
    const refresh = new Promise<{ created: []; updated: [] }>((_resolve, reject) => { rejectRefresh = reject; });
    const current = props(); current.onCanvasChanged = vi.fn(() => refresh);
    vi.mocked(fetch).mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n'));
    const hook = renderHook(() => useChatModel(current));
    act(() => hook.result.current.submit('Review the plan'));
    await waitFor(() => expect(current.onCanvasChanged).toHaveBeenCalled());
    expect(hook.result.current.justFinished).toBe(false);
    expect(hook.result.current.avatarState).toBe('speaking');
    await act(async () => rejectRefresh(new Error('Refresh unavailable')));
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    expect(hook.result.current.avatarState).toBe('error');
    expect(hook.result.current.justFinished).toBe(false);
    expect(current.onCanvasTurnEnd).toHaveBeenCalledWith(2, 'stopped');
    expect(current.onCanvasTurnEnd).not.toHaveBeenCalledWith(2, 'complete');
  });

  it('does not celebrate after cancellation while refresh is awaiting readback', async () => {
    let resolveRefresh!: (value: { created: []; updated: [] }) => void;
    const refresh = new Promise<{ created: []; updated: [] }>(resolve => { resolveRefresh = resolve; });
    const current = props(); current.onCanvasChanged = vi.fn(() => refresh);
    vi.mocked(fetch).mockResolvedValue(new Response('data: [DONE]\n\n'));
    const hook = renderHook(() => useChatModel(current));
    act(() => hook.result.current.submit('Review the plan'));
    await waitFor(() => expect(current.onCanvasChanged).toHaveBeenCalled());
    act(() => hook.result.current.activeRef.current?.abort());
    await act(async () => resolveRefresh({ created: [], updated: [] }));
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    expect(hook.result.current.justFinished).toBe(false);
    expect(hook.result.current.avatarState).toBe('idle');
    expect(current.onCanvasTurnEnd).toHaveBeenCalledWith(2, 'stopped');
    expect(current.onCanvasTurnEnd).not.toHaveBeenCalledWith(2, 'complete');
  });
});
