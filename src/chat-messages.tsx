import { Message, MessageContent } from './components/ai-elements/message';
import { AssistantContent } from './ChatAssistantContent';
import type { TurnMessageProps } from './chat-message-types';

export { ChatComposer } from './ChatComposer';

export function TurnMessage(props: TurnMessageProps) {
  const { turn, status, latestId } = props;
  if (turn.role === 'user') return <Message from="user" className="ai-chat__user-turn"><MessageContent className="ai-chat__user-bubble">{turn.content}</MessageContent></Message>;
  const streaming = status !== 'ready' && turn.id === latestId;
  return <Message from="assistant" className="ai-chat__assistant-turn">
    <MessageContent className="ai-chat__assistant-content"><AssistantContent {...props} streaming={streaming} /></MessageContent>
  </Message>;
}
