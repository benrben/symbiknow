import { useRef } from 'react';
import type { ChatViewContext } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';
import { chatScopeOptions, requestContextForScope } from './chat-context';
import { createRunEvents } from './chat-run-events';
import { errorText, settledAssistant } from './chat-turn-state';
import type { AIElementsChatProps, DisplayTurn } from './chat-types';
import { streamCanvasChat } from './chatStream';

import type { ChatState } from './chat-state';
export function useChatRun(props: AIElementsChatProps, state: ChatState, activeScope: ReturnType<typeof chatScopeOptions>[number]) {
  const { canvasId, canvas, viewContext, hasApiKey, onOpenSettings, onCanvasChanged, onCanvasTurnEnd } = props;
  const failedAssistantId = useRef<number | null>(null);
  const { setInput, setStatus, setError, setJustFinished, turnsRef, activeRef, nextId, finishTimer, commit } = state;
  function appendAssistant(base: DisplayTurn[]): DisplayTurn[] {
    const next = [...base, { id: ++nextId.current, role: 'assistant' as const, content: '', activities: [] }];
    commit(next);
    return next;
  }
  async function runConversation(current: DisplayTurn[], beforeBlocks: CanvasBlock[], requestCanvasId: string,
    requestView: ChatViewContext) {
    const assistantId = current.at(-1)!.id;
    const controller = new AbortController();
    activeRef.current = controller;
    const isCurrent = () => activeRef.current === controller;
    const isActive = () => isCurrent() && !controller.signal.aborted;
    failedAssistantId.current = null;
    setError('');
    setJustFinished(false);
    if (finishTimer.current) clearTimeout(finishTimer.current);
    setStatus('submitted');
    try {
      await streamCanvasChat({
        canvasId: requestCanvasId,
        viewContext: requestView,
        messages: current.filter(turn => turn.id !== assistantId && turn.content.trim()).map(({ role, content }) => ({ role, content })),
        signal: controller.signal,
        ...createRunEvents(props, state, assistantId, isActive),
      });
      const completed = await finishRun(assistantId, beforeBlocks, requestCanvasId, isActive);
      if (!completed) failRun(undefined, assistantId, controller, current, isCurrent);
    } catch (failure) {
      failRun(failure, assistantId, controller, current, isCurrent);
    } finally {
      if (isCurrent()) {
        activeRef.current = null;
        setStatus('ready');
      }
    }
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
  function lastQuestion(current: DisplayTurn[]) { return current.filter(turn => turn.role === 'user').at(-1)?.content || ''; }
  function failRun(failure: unknown, assistantId: number, controller: AbortController, current: DisplayTurn[], isCurrent: () => boolean) {
    if (!isCurrent()) return;
    setJustFinished(false);
    commit(settledAssistant(turnsRef.current, assistantId, 'stopped'));
    onCanvasTurnEnd(assistantId, 'stopped');
    if (!controller.signal.aborted) {
      failedAssistantId.current = assistantId;
      const message = errorText(failure);
      setError(message);
      if (message.includes('server is unavailable')) setInput(value => value || lastQuestion(current));
    }

  }
  function submit(text: string) {
    if (activeRef.current) return;
    failedAssistantId.current = null;
    if (!canStart()) return;
    const next = [...turnsRef.current, { id: ++nextId.current, role: 'user' as const, content: text, activities: [] }];
    setInput('');
    const conversation = appendAssistant(next);
    void runConversation(conversation, canvas?.blocks ?? [], canvasId, requestContextForScope(viewContext, activeScope));
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
    void runConversation(conversation, canvas?.blocks ?? [], canvasId, requestContextForScope(viewContext, activeScope));
  }
  return { submit, retry };
}
