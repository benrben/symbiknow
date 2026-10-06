import type { ServerResponse } from 'node:http';
import { ApiError } from './storage.js';
import type { ChatAgentStep, ChatStreamEvent, ChatStreamSession } from './chat-agent.js';
import { combinedSignal } from './chat-cancellation.js';

function sseChunk(model: string, content: string, finishReason: 'stop' | null = null): string {
  return `data: ${JSON.stringify({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
}

function sseStep(step: ChatAgentStep): string {
  return `event: agent_step\ndata: ${JSON.stringify(step)}\n\n`;
}

function startEvents(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
}

const eventNames = {
  answer_canvas: 'answer_canvas', navigate: 'canvas_navigation',
  research_patch: 'research_canvas_patch',
  proposal: 'chat_proposal',
};

function eventPayload(event: Exclude<ChatStreamEvent, { kind: 'text' | 'step' | 'reset' }>): unknown {
  const payloads = { answer_canvas: 'canvas', navigate: 'target',
    research_patch: 'patch', proposal: 'proposal' };
  return (event as unknown as Record<string, unknown>)[payloads[event.kind]];
}

function writeEvent(response: ServerResponse, event: ChatStreamEvent, model: string): void {
  if (event.kind === 'step') { response.write(sseStep(event.step)); return; }
  if (event.kind === 'reset') { response.write('event: answer_reset\ndata: {}\n\n'); return; }
  if (event.kind === 'text') { response.write(sseChunk(model, event.content)); return; }
  response.write(`event: ${eventNames[event.kind]}\ndata: ${JSON.stringify(eventPayload(event))}\n\n`);
}

async function* textEvents(iterator: AsyncGenerator<string>): AsyncGenerator<ChatStreamEvent> {
  for await (const content of iterator) yield { kind: 'text', content };
}

async function writeAnswer(response: ServerResponse, iterator: AsyncGenerator<ChatStreamEvent>, first: IteratorResult<ChatStreamEvent>, model: string): Promise<void> {
  if (!first.done) writeEvent(response, first.value, model);
  for await (const event of iterator) writeEvent(response, event, model);
}

function writeStreamError(response: ServerResponse, error: unknown): void {
  if (!response.headersSent) throw error;
  const message = error instanceof ApiError ? error.message : 'Chat stream stopped. Check the model settings.';
  response.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
}

function finishEvents(response: ServerResponse, model: string, signal: AbortSignal): void {
  if (signal.aborted || !response.headersSent) return;
  response.end(sseChunk(model, '', 'stop') + 'data: [DONE]\n\n');
}

export async function sendChatStream(response: ServerResponse, session: ChatStreamSession, requestSignal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const signal = combinedSignal(requestSignal, controller.signal)!;
  const abort = () => controller.abort();
  response.on('close', abort);
  const iterator = session.events?.(signal) ?? textEvents(session.tokens(signal));
  try {
    const first = await iterator.next();
    if (signal.aborted) return;
    startEvents(response);
    await writeAnswer(response, iterator, first, session.model);
  } catch (error) {
    if (signal.aborted) return;
    writeStreamError(response, error);
  } finally {
    response.off('close', abort);
    finishEvents(response, session.model, signal);
  }
}
