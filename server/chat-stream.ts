import type { CanvasStore } from './storage.js';
import { chatAgent, type ChatStreamSession, type DeepAgentFactory } from './chat-agent.js';
import { cancellable } from './chat-cancellation.js';
import { requestContext, agentConfiguration } from './chat-stream-context.js';
import { preparedChatStream } from './chat-stream-preparation.js';
import type { ChatStreamOptions } from './chat-stream-types.js';

export { chatAgent, openRouterAgent } from './chat-agent.js';
export type { DeepAgentFactory, ChatAgentStep, ChatStreamEvent, ChatStreamSession } from './chat-agent.js';
export { sendChatStream } from './chat-sse.js';

export type { ChatStreamOptions } from './chat-stream-types.js';

export async function createChatStream(store: CanvasStore, body: Record<string, unknown>, agentFactory: DeepAgentFactory = chatAgent,
  options: ChatStreamOptions = {}): Promise<ChatStreamSession> {
  options.signal?.throwIfAborted();
  const request = await cancellable(requestContext(store, body), options.signal);
  const config = await cancellable(agentConfiguration(store), options.signal);
  return preparedChatStream(store, request, config, agentFactory, options.signal);
}
