import { chat } from './chat.js';
import type { RouteContext } from './api-context.js';
import { createChatStream, sendChatStream } from './chat-stream.js';
import { sendJson, readBody } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';
import { chatProposalEndpoints } from './api-chat-proposals.js';

import { documentSearch } from './api-search.js';
import { createStoreApiFetcher } from './api-inprocess.js';

export { investigationRoutes } from './api-chat-investigations.js';

const searchEndpoints: Endpoint[] = [
  { method: 'POST', path: '/api/chat', handle: async context => {
    sendJson(context.response, 200, await chat(context.store, await readBody(context.request), {
      signal: context.signal, agentFactory: context.agentFactory,
      mcpFetcher: createStoreApiFetcher(context.store, context),
    }));
  } },
];

export async function searchAndChat(context: RouteContext): Promise<boolean> {
  return await documentSearch(context) || runEndpoints(context, searchEndpoints);
}

const chatEndpoints: Endpoint[] = [
  ...chatProposalEndpoints,
  { method: 'POST', path: '/api/chat/stream', handle: async context => {
    const session = await createChatStream(context.store, await readBody(context.request),
      context.agentFactory, { signal: context.signal, mcpFetcher: createStoreApiFetcher(context.store, context) });
    await sendChatStream(context.response, session, context.signal);
  } },
];

export function streamingChat(context: RouteContext): Promise<boolean> { return runEndpoints(context, chatEndpoints); }
