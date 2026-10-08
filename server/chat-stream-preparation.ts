import type { CanvasStore } from './storage.js';
import type { ChatStreamSession, DeepAgentFactory } from './chat-agent.js';
import { cancellable } from './chat-cancellation.js';
import { outsideTools } from './chat-stream-context.js';
import { agentSession } from './chat-stream-session.js';
import type { AgentConfiguration, ChatStreamOptions, ExternalTools, PreparedRequest } from './chat-stream-types.js';

function closeOnAbort(external: ExternalTools, signal?: AbortSignal): () => Promise<void> {
  const abort = () => { void external.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  return async () => { signal?.removeEventListener('abort', abort); await external.close(); };
}

export async function preparedChatStream(store: CanvasStore, request: PreparedRequest, config: AgentConfiguration,
  agentFactory: DeepAgentFactory, options: ChatStreamOptions = {}): Promise<ChatStreamSession> {
  const signal = options.signal;
  const warnings: string[] = [];
  const outside = outsideTools(config, warnings, signal);
  let close: (() => Promise<void>) | undefined;
  try {
    const external = await cancellable(outside, signal);
    close = closeOnAbort(external, signal);
    signal?.throwIfAborted();
    return await agentSession(store, request, config, external, warnings, close, agentFactory, options);
  } catch (error) {
    if (close) await close();
    // Return the original preparation error; an eventual connection still needs closing.
    else void outside.then(external => external.close()).catch(() => undefined);
    throw error;
  }
}
