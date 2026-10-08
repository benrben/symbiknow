import { jevApiPrincipal } from './jev-api-principal.js';
import { requireApprove, requireCanvas, requireTool } from './jev/authorization.js';
import { applyFileProposal, fileProposalCanvas, getFileProposal, undoFileProposal } from './file-branch-proposals.js';
import { ApiError } from './errors.js';
import { ChatProposalConflict } from './chat-proposals.js';
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

async function chatProposalAccess(context: RouteContext, id: string, operation?: 'apply' | 'undo') {
  const principal = await jevApiPrincipal(context.store, context.request, false);
  requireTool(principal, [operation ? operation + '_file_proposal' : 'read_file_proposal']);
  if (operation) requireApprove(principal);
  requireCanvas(principal, await fileProposalCanvas(context.store, id));
  return principal.id;
}
export const chatProposalEndpoints: Endpoint[] = [
  { method: 'GET', path: /^\/api\/chat\/proposals\/([^/]+)$/, handle: async (context, match) => {
    await chatProposalAccess(context, match[1]);
    sendJson(context.response, 200, await getFileProposal(context.store, match[1]));
  } },
  { method: 'POST', path: /^\/api\/chat\/proposals\/([^/]+)\/apply$/, handle: async (context, match) => {
    const body = await readBody(context.request);
    const ids = selectedChanges(body.changeIds);
    await proposalResponse(context, () => context.store.jevExecutor.serialized(async () => {
      const actor = await chatProposalAccess(context, match[1], 'apply');
      return applyFileProposal(context.store, match[1], ids, actor);
    }));
  } },
  { method: 'POST', path: /^\/api\/chat\/proposals\/([^/]+)\/undo$/, handle: async (context, match) => {
    await proposalResponse(context, () => context.store.jevExecutor.serialized(async () => {
      const actor = await chatProposalAccess(context, match[1], 'undo');
      return undoFileProposal(context.store, match[1], actor);
    }));
  } },
];
