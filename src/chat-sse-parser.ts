import type { Handlers } from './chat-stream-types';
import { isAgentStep, isAnswerCanvas, isChatProposal, isNavigation,
  isResearchPatch } from './chat-stream-validation';

type EventConsumer = (payload: unknown, handlers: Handlers) => void;

function checkedEvent<T>(validate: (payload: unknown) => payload is T, callback: (handlers: Handlers) => ((payload: T) => void) | undefined): EventConsumer {
  return (payload, handlers) => {
    if (validate(payload)) callback(handlers)?.(payload);
  };
}

const eventConsumers = new Map<string, EventConsumer>(Object.entries({
  agent_step: (payload, handlers) => {
    if (isAgentStep(payload)) handlers.onStep?.({ type: payload.type, id: payload.id, name: payload.name, message: payload.message });
  },
  answer_reset: (_payload, handlers) => handlers.onReset?.(),
  answer_canvas: checkedEvent(isAnswerCanvas, handlers => handlers.onAnswerCanvas),
  canvas_navigation: checkedEvent(isNavigation, handlers => handlers.onNavigation),
  research_canvas_patch: checkedEvent(isResearchPatch, handlers => handlers.onResearchPatch),
  chat_proposal: checkedEvent(isChatProposal, handlers => handlers.onProposal),
  error: payload => { throw new Error((payload as { message?: string }).message || 'The assistant stopped. Please retry.'); },
} satisfies Record<string, EventConsumer>));

function frameData(frame: string): string {
  return frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
}

function frameEvent(frame: string): string {
  return frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim() ?? '';
}

function consumeCompletion(payload: unknown, handlers: Handlers) {
  const chunk = payload as { error?: string; choices?: Array<{ delta?: { content?: string } }> };
  if (chunk.error) throw new Error(chunk.error);
  const content = chunk.choices?.[0]?.delta?.content;
  if (typeof content === 'string') handlers.onChunk(content);
}

function consumeFrame(frame: string, handlers: Handlers): boolean {
  const data = frameData(frame);
  if (data === '[DONE]') return true;
  if (!data) return false;
  const payload = JSON.parse(data) as unknown;
  const consume = eventConsumers.get(frameEvent(frame)) ?? consumeCompletion;
  consume(payload, handlers);
  return false;
}

export async function consumeChatStream(body: ReadableStream<Uint8Array>, handlers: Handlers): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0) {
        if (consumeFrame(pending.slice(0, boundary), handlers)) return;
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf('\n\n');
      }
      if (done) throw new Error('The assistant connection closed before the reply completed. Please retry.');
    }
  } finally {
    // Reader cancellation can fail after an otherwise completed reply; releasing the lock is still required.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
