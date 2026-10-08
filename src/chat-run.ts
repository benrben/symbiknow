import { useRef } from 'react';
import type { ChatViewContext } from '../shared/answer-canvas';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { api } from './api';
import { chatScopeOptions, requestContextForScope } from './chat-context';
import { createRunEvents } from './chat-run-events';
import { errorText, settledAssistant } from './chat-turn-state';
import type { AIElementsChatProps, DisplayTurn } from './chat-types';
import { streamCanvasChat } from './chatStream';

import type { ChatState } from './chat-state';
type ConversationRequest = {
  canvasId: string; viewContext: ChatViewContext;
  conversationId?: string;
  messages: Array<Pick<DisplayTurn, 'role' | 'content'>>;
};
export function useChatRun(props: AIElementsChatProps, state: ChatState, activeScope: ReturnType<typeof chatScopeOptions>[number]) {
  const { canvasId, canvas, viewContext, hasApiKey, onOpenSettings, onCanvasChanged, onCanvasTurnEnd } = props;
  const failedAssistantId = useRef<number | null>(null);
  const failedRequest = useRef<ConversationRequest | null>(null);
  const { setInput, setStatus, setError, setJustFinished, turnsRef, activeRef, nextId, finishTimer, commit } = state;
  function appendAssistant(base: DisplayTurn[]): DisplayTurn[] {
    const next = [...base, { id: ++nextId.current, role: 'assistant' as const, content: '', activities: [] }];
    commit(next);
    return next;
  }
  async function runConversation(current: DisplayTurn[], request: ConversationRequest, beforeBlocks?: CanvasBlock[]) {
    const assistantId = current.at(-1)!.id;
    const controller = new AbortController();
    activeRef.current = controller;
    const isCurrent = () => activeRef.current === controller;
    const isActive = () => isCurrent() && !controller.signal.aborted;
    failedAssistantId.current = null;
    failedRequest.current = null;
    setError('');
    setJustFinished(false);
    if (finishTimer.current) clearTimeout(finishTimer.current);
    setStatus('submitted');
    try {
      const completed = await executeAttempt(request, beforeBlocks, assistantId, controller, isActive);
      if (!completed) failRun(undefined, assistantId, controller, request, isCurrent);
    } catch (failure) {
      failRun(failure, assistantId, controller, request, isCurrent);
    } finally {
      if (isCurrent()) {
        activeRef.current = null;
        setStatus('ready');
      }
    }
  }
  async function executeAttempt(request: ConversationRequest, beforeBlocks: CanvasBlock[] | undefined,
    assistantId: number, controller: AbortController, isActive: () => boolean) {
    const baseline = beforeBlocks ?? await retryBaseline(request.canvasId, controller.signal);
    if (!isActive()) return false;
    await streamCanvasChat({
        canvasId: request.canvasId,
        conversationId: request.conversationId,
        viewContext: request.viewContext,
        messages: request.messages,
        signal: controller.signal,
        ...createRunEvents(props, state, assistantId, isActive),
    });
    return finishRun(assistantId, baseline, request.canvasId, isActive);
  }
  async function finishRun(assistantId: number, beforeBlocks: CanvasBlock[], requestCanvasId: string, isActive: () => boolean) {
    if (!isActive()) return false;
    await rememberCanvasChanges(assistantId, beforeBlocks, requestCanvasId, isActive);
    if (!isActive()) return false;
    commit(settledAssistant(turnsRef.current, assistantId, 'complete'));
    onCanvasTurnEnd(assistantId, 'complete');
    setJustFinished(true);
    finishTimer.current = setTimeout(() => { setJustFinished(false); finishTimer.current = null; }, 900);
    return true;
  }
  async function rememberCanvasChanges(assistantId: number, beforeBlocks: CanvasBlock[], requestCanvasId: string, isActive: () => boolean) {
    const changes = await onCanvasChanged(requestCanvasId, beforeBlocks);
    if (!isActive()) return;
    if (changes.created.length || changes.updated.length) commit(turnsRef.current.map(turn => turn.id === assistantId
      ? { ...turn, createdBlocks: changes.created, editedBlocks: changes.updated, createdCanvasId: requestCanvasId } : turn));
  }
  function lastQuestion(current: ConversationRequest['messages']) { return current.filter(turn => turn.role === 'user').at(-1)?.content || ''; }
  function failRun(failure: unknown, assistantId: number, controller: AbortController, request: ConversationRequest, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    setJustFinished(false);
    commit(settledAssistant(turnsRef.current, assistantId, 'stopped'));
    onCanvasTurnEnd(assistantId, 'stopped');
    if (!controller.signal.aborted) {
      failedAssistantId.current = assistantId;
      failedRequest.current = request;
      const message = errorText(failure);
      setError(message);
      if (message.includes('server is unavailable')) setInput(value => value || lastQuestion(request.messages));
    }

  }
  function submit(text: string) {
    if (activeRef.current) return;
    failedAssistantId.current = null;
    failedRequest.current = null;
    if (!canStart()) return;
    const next = [...turnsRef.current, { id: ++nextId.current, role: 'user' as const, content: text, activities: [] }];
    setInput('');
    const conversation = appendAssistant(next);
    const request = conversationRequest(conversation, canvasId, requestContextForScope(viewContext, activeScope));
    void runConversation(conversation, request, structuredClone(canvas?.blocks ?? []));
  }
  function canStart() {
    if (!canvasId) { setError('Open a canvas before using the assistant.'); return false; }
    if (!hasApiKey) { setError('Connect a chat model in Settings before using the assistant.'); onOpenSettings(); return false; }
    return !activeRef.current;
  }
  function retry() {
    if (failedAssistantId.current !== turnsRef.current.at(-1)?.id) { submit(state.input.trim()); return; }
    if (!canStart()) return;
    const history = turnsRef.current.slice(0, -1);
    const conversation = appendAssistant(history);
    setInput('');
    // A failed assistant ID is assigned together with this original request snapshot.
    void runConversation(conversation, failedRequest.current!);
  }
  return { submit, retry };
}

function conversationRequest(current: DisplayTurn[], canvasId: string, viewContext: ChatViewContext): ConversationRequest {
  return structuredClone({ canvasId, viewContext, conversationId: `chat-${current.find(turn => turn.role === 'user')!.id}`,
    messages: current.slice(0, -1).filter(turn => turn.content.trim()).map(({ role, content }) => ({ role, content })) });
}

async function retryBaseline(canvasId: string, signal: AbortSignal): Promise<CanvasBlock[]> {
  const current = await api<CanvasDocument>('/canvases/' + encodeURIComponent(canvasId), { cache: 'no-store', signal });
  return structuredClone(current.blocks);
}
