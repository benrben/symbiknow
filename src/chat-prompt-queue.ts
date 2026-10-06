import { useEffect } from 'react';
import type { AIElementsChatProps } from './chat-types';

import type { ChatState } from './chat-state';
export function useChatPromptQueue(props: AIElementsChatProps, state: ChatState, submit: (text: string) => void) {
  const { canvasId, hasApiKey, promptRequest, onOpenSettings } = props;
  const { status, setError, activeRef, lastPromptSequence, pendingPrompts, settingsRequested } = state;
  useEffect(() => {
    enqueueRequest();
    if (!pendingPrompts.current.length || !canvasId) return;
    if (!hasApiKey) { askForSettings(); return; }
    settingsRequested.current = false;
    if (activeRef.current) return;
    const next = pendingPrompts.current.shift()!;
    submit(next.text);
  }, [promptRequest?.sequence, promptRequest?.text, canvasId, hasApiKey, status]);
  function enqueueRequest() {
    if (promptRequest && lastPromptSequence.current !== promptRequest.sequence) {
      pendingPrompts.current.push({ text: promptRequest.text, sequence: promptRequest.sequence });
      lastPromptSequence.current = promptRequest.sequence;
    }

  }
  function askForSettings() {
    if (settingsRequested.current) return;
    settingsRequested.current = true;
    setError('Connect a chat model in Settings before using the assistant.');
    onOpenSettings();
  }
}
