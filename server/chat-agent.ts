import { ChatOpenAI } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { createDeepAgent, FilesystemBackend } from 'deepagents';
import { toolCallLimitMiddleware } from 'langchain';
import type { AgentRun, AgentSnapshot, AgentStreamItem, ChatStreamEvent, DeepAgentFactory, ProgressState } from './chat-agent-types.js';
import { agentFailure } from './chat-agent-failure.js';
import { completedSnapshot, tokenEvents, streamItem } from './chat-agent-events.js';

export type { ModelSettings, AgentRun, DeepAgentFactory, ChatAgentStep, ChatStreamEvent, ProgressState, ChatStreamSession } from './chat-agent-types.js';
export { finalAnswer, textPieces } from './chat-agent-output.js';

const defaultBaseUrl = 'https://openrouter.ai/api/v1';

/** Deep Agents with any OpenAI-compatible chat model. Streams both state snapshots and model tokens. */
export const chatAgent: DeepAgentFactory = (settings, tools, systemPrompt, environment) => {
  const model = new ChatOpenAI({
    model: settings.model, apiKey: settings.apiKey, streamUsage: false, useResponsesApi: false, streaming: true,
    configuration: { baseURL: settings.baseURL ?? defaultBaseUrl, defaultHeaders: settings.headers ?? {
      'HTTP-Referer': 'http://localhost:5173', 'X-Title': 'SymbiKnow',
    } },
  });
  const agent = createDeepAgent({
    model, tools, systemPrompt,
    ...(environment ? { backend: new FilesystemBackend({ rootDir: environment.workdir, virtualMode: true }) } : {}),
    middleware: [toolCallLimitMiddleware({ runLimit: 9_999, exitBehavior: 'error' })],
  });
  return (messages, signal) => agent.stream({ messages }, { streamMode: ['values', 'messages'], recursionLimit: 20_001, signal }) as Promise<AsyncIterable<AgentStreamItem>>;
};


function handleAgentFailure(error: unknown, signal: AbortSignal, provider: string): void {
  if (!signal.aborted) agentFailure(error, provider);
}

export async function* agentProgress(runAgent: AgentRun, messages: BaseMessage[], signal: AbortSignal, provider: string, progress: ProgressState):
  AsyncGenerator<ChatStreamEvent, AgentSnapshot | undefined> {
  let latest: AgentSnapshot | undefined;
  try {
    for await (const item of await runAgent(messages, signal)) {
      if (signal.aborted) return undefined;
      const { snapshot, token } = streamItem(item);
      if (token) yield* tokenEvents(token[0], token[1], progress);
      if (snapshot) {
        latest = snapshot;
        yield* completedSnapshot(snapshot, progress);
      }
    }
  } catch (error) { handleAgentFailure(error, signal, provider); }
  return latest;
}

export async function collectSnapshot(runAgent: AgentRun, messages: BaseMessage[], signal: AbortSignal, provider: string): Promise<AgentSnapshot | undefined> {
  let latest: AgentSnapshot | undefined;
  try {
    for await (const item of await runAgent(messages, signal)) {
      if (signal.aborted) return undefined;
      const { snapshot } = streamItem(item);
      if (snapshot) latest = snapshot;
    }
  } catch (error) {
    if (signal.aborted) return undefined;
    agentFailure(error, provider);
  }
  return latest;
}

