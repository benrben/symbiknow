import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { ApiError } from './storage.js';
import { messageContent } from './chat-input.js';
import type { AgentSnapshot } from './chat-agent-types.js';

function lastMessage(snapshot: AgentSnapshot | undefined): BaseMessage | undefined { return snapshot?.messages?.at(-1); }

export function finalAnswer(snapshot: AgentSnapshot | undefined, provider: string): string {
  const message = lastMessage(snapshot);
  if (!(message instanceof AIMessage) || message.tool_calls?.length) {
    throw new ApiError(502, `${provider} returned no final answer`);
  }
  const content = messageContent(message.content);
  if (!content) throw new ApiError(502, `${provider} returned no text`);
  return content;
}

export function* textPieces(content: string): Generator<string> {
  for (let index = 0; index < content.length; index += 256) yield content.slice(index, index + 256);
}
