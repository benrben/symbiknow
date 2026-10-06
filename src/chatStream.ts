import { consumeChatStream } from './chat-sse-parser';
import type { StreamOptions } from './chat-stream-types';

export type { ChatTurn, AgentStep,
  ChatProposalChange, ChatProposal, ChatProposalReceipt, ChatProposalUndoReceipt } from './chat-stream-types';

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Canvas chat request failed (${response.status}). Retry in a moment.`;
}

function requestBody({ canvasId, messages, viewContext }: StreamOptions) {
  return JSON.stringify({ canvasId, messages, viewContext });
}

async function fetchChatResponse(options: StreamOptions): Promise<Response> {
  const { signal, fetcher = fetch } = options;
  try {
    return await fetcher('/api/chat/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Browser' },
      body: requestBody(options), signal,
    });
  } catch (failure) {
    if (signal.aborted) throw failure;
    throw new Error('Canvas server is unavailable. Check that it is running, then retry.');
  }
}

export async function streamCanvasChat(options: StreamOptions): Promise<void> {
  const response = await fetchChatResponse(options);
  if (options.signal.aborted) throw options.signal.reason;
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error('The assistant returned an empty stream. Please retry.');
  await consumeChatStream(response.body, options);
}
