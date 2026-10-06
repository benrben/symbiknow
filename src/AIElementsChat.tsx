import type { AIElementsChatProps } from './chat-types';
import { AIElementsChatView } from './AIElementsChatView';
import { useChatModel } from './chat-model';
import './ai-chat.css';

export function AIElementsChat(props: AIElementsChatProps) {
  return <AIElementsChatView {...useChatModel(props)} />;
}
