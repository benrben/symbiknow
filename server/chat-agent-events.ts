import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { messageContent } from './chat-input.js';
import type { AgentSnapshot, AgentStreamItem, ChatAgentStep, ChatStreamEvent, ProgressState } from './chat-agent-types.js';

function safeToolName(name: string | undefined): string {
  return (name || 'tool').replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 64) || 'tool';
}

function* aiToolSteps(message: AIMessage): Generator<ChatAgentStep> {
  if (!message.tool_calls) return;
  for (const call of message.tool_calls) {
    const name = safeToolName(call.name);
    yield { type: 'tool_start', id: call.id, name, message: `Running ${name}` };
  }
}

function* messageSteps(messages: BaseMessage[]): Generator<ChatAgentStep> {
  for (const message of messages) {
    if (message instanceof AIMessage) yield* aiToolSteps(message);
    if (message instanceof ToolMessage) {
      const name = safeToolName(message.name);
      yield { type: 'tool_end', id: message.tool_call_id, name, message: `Finished ${name}` };
      yield { type: 'thinking', message: 'Reviewing the tool result' };
    }
  }
}

function* snapshotEvents(snapshot: AgentSnapshot, progress: ProgressState): Generator<ChatStreamEvent> {
  yield* startProgress(progress);
  for (const step of messageSteps(snapshot.messages?.slice(progress.seen) ?? [])) yield { kind: 'step', step };
  progress.seen = snapshot.messages?.length ?? progress.seen;
}
function hasToolChunks(message: AIMessageChunk): boolean { return Boolean(message.tool_call_chunks?.length); }

function isTopLevelModelToken(message: BaseMessage, metadata: Record<string, unknown>): message is AIMessageChunk {
  return message instanceof AIMessageChunk && metadata.langgraph_node === 'model_request'
    && !String(metadata.langgraph_checkpoint_ns ?? '').includes('|');
}

/** Stream model text as it arrives. Text written before a tool call was only a note, so it is reset. */
export function* tokenEvents(message: BaseMessage, metadata: Record<string, unknown>, progress: ProgressState): Generator<ChatStreamEvent> {
  if (!isTopLevelModelToken(message, metadata)) return;
  const toolChunks = hasToolChunks(message);
  if (toolChunks && progress.streamed) {
    progress.streamed = '';
    yield { kind: 'reset' };
    return;
  }
  const content = messageContent(message.content);
  if (!content || toolChunks) return;
  yield* startProgress(progress);
  progress.streamed += content;
  yield { kind: 'text', content };
}

export function streamItem(item: AgentStreamItem): { snapshot?: AgentSnapshot; token?: [BaseMessage, Record<string, unknown>] } {
  if (!Array.isArray(item)) return { snapshot: item };
  if (item[0] === 'values') return { snapshot: item[1] as AgentSnapshot };
  if (item[0] === 'messages' && Array.isArray(item[1])) return { token: item[1] as [BaseMessage, Record<string, unknown>] };
  return {};
}

function* startProgress(progress: ProgressState): Generator<ChatStreamEvent> {
  if (!progress.started) yield { kind: 'step', step: { type: 'thinking', message: 'Working on your request' } };
  progress.started = true;
}

export function* completedSnapshot(snapshot: AgentSnapshot, progress: ProgressState): Generator<ChatStreamEvent> {
  const last = snapshot.messages?.at(-1);
  if (last instanceof AIMessage && last.tool_calls?.length && progress.streamed) {
    progress.streamed = '';
    yield { kind: 'reset' };
  }
  yield* snapshotEvents(snapshot, progress);
}
