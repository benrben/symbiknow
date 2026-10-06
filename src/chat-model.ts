import type { AIElementsChatProps } from './chat-types';
import { useChatState } from './chat-state';
import { chatViewState } from './chat-view-state';
import { useChatRun } from './chat-run';
import { useChatInvestigations } from './chat-investigations';
import { useChatProposals } from './chat-proposals';
import { useChatPromptQueue } from './chat-prompt-queue';
import { useChatPersistence } from './chat-persistence';

export function useChatModel(props: AIElementsChatProps) {
  const state = useChatState();
  const view = chatViewState(props, state);
  const run = useChatRun(props, state, view.activeScope);
  const investigations = useChatInvestigations(props, state, run.submit);
  const proposals = useChatProposals(props, state);
  useChatPersistence(props, state, view.avatarState);
  useChatPromptQueue(props, state, run.submit);
  return { ...props, ...state, ...view, ...run, ...investigations, ...proposals };
}
export type ChatModel = ReturnType<typeof useChatModel>;
