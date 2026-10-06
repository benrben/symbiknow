import type { ChatReply } from '../shared/types.js';
import { CanvasStore } from './storage.js';
import { createChatStream, type DeepAgentFactory, type ChatStreamOptions } from './chat-stream.js';
import type { ChatStreamEvent } from './chat-agent.js';
import { requiredString } from './chat-input.js';

export type ChatOptions = ChatStreamOptions & { agentFactory?: DeepAgentFactory };

async function canvasState(store: CanvasStore, canvasId: string): Promise<string> {
  const canvas = await store.getCanvas(canvasId);
  return JSON.stringify({ blocks: canvas.blocks.map(block => ({ ...block, lock: undefined })) });
}

function accumulate(reply: { message: string; proposalId?: string }, event: ChatStreamEvent): void {
  if (event.kind === 'text') reply.message += event.content;
  if (event.kind === 'reset') reply.message = '';
  if (event.kind === 'proposal') reply.proposalId = event.proposal.id;
}

/** JSON compatibility endpoint using the same agent, permissions and review flow as streaming chat. */
export async function chat(store: CanvasStore, body: Record<string, unknown>, options: ChatOptions = {}): Promise<ChatReply> {
  const signal = options.signal ?? new AbortController().signal;
  const session = await createChatStream(store, body, options.agentFactory, { signal });
  const canvasId = requiredString(body.canvasId, 'canvasId');
  const before = await canvasState(store, canvasId);
  const reply: { message: string; proposalId?: string } = { message: '' };
  for await (const event of session.events!(signal)) {
    signal.throwIfAborted();
    accumulate(reply, event);
  }
  signal.throwIfAborted();
  const changed = before !== await canvasState(store, canvasId);
  return { ...reply, changed };
}
