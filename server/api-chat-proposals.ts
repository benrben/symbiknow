import { ApiError } from './errors.js';
import { applyChatProposal, getChatProposal, undoChatProposal, ChatProposalConflict } from './chat-proposals.js';
import type { RouteContext } from './api-context.js';
import { readBody, sendJson } from './api-http.js';
import type { Endpoint } from './api-router.js';

async function proposalResponse(context: RouteContext, work: () => Promise<unknown>): Promise<void> {
  try { sendJson(context.response, 200, await work()); }
  catch (error) {
    if (!(error instanceof ChatProposalConflict)) throw error;
    sendJson(context.response, 409, { error: error.message, conflicts: error.conflicts });
  }
}

function selectedChanges(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) {
    throw new ApiError(400, 'changeIds must be an array of strings');
  }
  return value;
}

export const chatProposalEndpoints: Endpoint[] = [
  { method: 'GET', path: /^\/api\/chat\/proposals\/([^/]+)$/, handle: async (context, match) => {
    sendJson(context.response, 200, getChatProposal(context.store, match[1]));
  } },
  { method: 'POST', path: /^\/api\/chat\/proposals\/([^/]+)\/apply$/, handle: async (context, match) => {
    const body = await readBody(context.request);
    const ids = selectedChanges(body.changeIds);
    await proposalResponse(context, () => applyChatProposal(context.store, match[1], ids));
  } },
  { method: 'POST', path: /^\/api\/chat\/proposals\/([^/]+)\/undo$/, handle: async (context, match) => {
    await proposalResponse(context, () => undoChatProposal(context.store, match[1]));
  } },
];
