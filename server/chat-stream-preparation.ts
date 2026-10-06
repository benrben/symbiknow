import type { CanvasStore } from './storage.js';
import { selectAnswerCanvas } from './answer-canvas.js';
import type { AnswerCanvasResult } from '../shared/answer-canvas.js';
import type { ChatStreamSession, DeepAgentFactory } from './chat-agent.js';
import { asksForSources } from './chat-input.js';
import { cancellable } from './chat-cancellation.js';
import { outsideTools } from './chat-stream-context.js';
import { agentSession } from './chat-stream-session.js';
import type { AgentConfiguration, ExternalTools, PreparedRequest } from './chat-stream-types.js';

async function answerSources(store: CanvasStore, request: PreparedRequest, config: AgentConfiguration,
  signal?: AbortSignal): Promise<AnswerCanvasResult | null> {
  if (!config.plugins.includes('document_read')) return null;
  if (!request.requestedResearchCanvas && !asksForSources(request.context.latest)) return null;
  try {
    return await cancellable(selectAnswerCanvas(store, request.canvasId, request.context.latest, request.currentView), signal);
  } catch (error) {
    signal?.throwIfAborted();
    // Local filesystem/index failures are Errors; cancellation preserves its
    // reason above. Provider and agent factory calls occur outside this catch.
    console.warn('Local chat source retrieval unavailable; continuing with document tools.', (error as Error).name);
    return null;
  }
}

function closeOnAbort(external: ExternalTools, signal?: AbortSignal): () => Promise<void> {
  const abort = () => { void external.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  return async () => { signal?.removeEventListener('abort', abort); await external.close(); };
}

export async function preparedChatStream(store: CanvasStore, request: PreparedRequest, config: AgentConfiguration,
  agentFactory: DeepAgentFactory, signal?: AbortSignal): Promise<ChatStreamSession> {
  const warnings: string[] = [];
  const outside = outsideTools(config, warnings, signal);
  let close: (() => Promise<void>) | undefined;
  try {
    const external = await cancellable(outside, signal);
    close = closeOnAbort(external, signal);
    signal?.throwIfAborted();
    const answerCanvas = await answerSources(store, request, config, signal);
    signal?.throwIfAborted();
    return agentSession(store, request, config, answerCanvas, external, warnings, close, agentFactory, signal);
  } catch (error) {
    if (close) await close();
    // Return the original preparation error; an eventual connection still needs closing.
    else void outside.then(external => external.close()).catch(() => undefined);
    throw error;
  }
}
