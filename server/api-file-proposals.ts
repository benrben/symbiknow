import type { RouteContext } from './api-context.js';
import { readBody, sendJson } from './api-http.js';
import { ApiError } from './errors.js';
import { jevApiPrincipal } from './jev-api-principal.js';
import { requireApprove, requireCanvas, requireTool } from './jev/authorization.js';
import { applyFileProposal, fileProposalCanvas, getFileProposal, undoFileProposal, withFileProposalWrite } from './file-branch-proposals.js';

type ProposalValue = { branch?: string; changes?: Array<{ blockId: string }>; documents?: Array<{ after?: { id: string } | null; before?: { id: string } | null }> };
function proposalReceiptId(document: NonNullable<ProposalValue['documents']>[number]): string | undefined {
  return document.after?.id;
}
function proposalDocument(value: ProposalValue): string | undefined {
  const change = value.changes?.[0];
  if (change) return change.blockId;
  const document = value.documents?.[0];
  return document ? proposalReceiptId(document) : undefined;
}
async function proposalReadback(context: RouteContext, canvasId: string, before: ProposalValue, value: unknown) {
  const blockId = proposalDocument(before);
  if (!blockId) return value;
  const history = await context.store.documentHistory(canvasId, blockId);
  const branch = before.branch ?? history.current;
  const block = await context.store.readDocumentBranch(canvasId, blockId, branch);
  return { ...value as Record<string, unknown>, canvasId, blockId, branch, revision: block.revision,
    contentHash: block.contentHash, saved: true };
}
async function executeProposalOperation(context: RouteContext, id: string, canvasId: string, operation: 'apply' | 'undo' | undefined, actor: string) {
  const before = await getFileProposal(context.store, id);
  if (!operation) return before;
  const value = operation === 'apply' ? await applyFileProposal(context.store, id, undefined, actor) : await undoFileProposal(context.store, id, actor);
  return proposalReadback(context, canvasId, before, value);
}
async function fileProposalAccess(context: RouteContext, id: string, operation: 'apply' | 'undo' | undefined, requested: unknown) {
  const principal = await jevApiPrincipal(context.store, context.request, true);
  requireTool(principal, [operation ? `${operation}_file_proposal` : 'read_file_proposal']);
  if (operation) requireApprove(principal);
  const canvasId = await fileProposalCanvas(context.store, id);
  requireCanvas(principal, canvasId);
  if (requested !== canvasId) throw new ApiError(404, 'File proposal not found in the requested canvas');
  return { canvasId, actor: principal.id };
}
async function authorizedProposal(context: RouteContext, id: string, operation: 'apply' | 'undo' | undefined, requested: unknown) {
  const { canvasId, actor } = await fileProposalAccess(context, id, operation, requested);
  return executeProposalOperation(context, id, canvasId, operation, actor);
}
async function reviewedProposal(context: RouteContext, id: string, operation: 'apply' | 'undo' | undefined, requested: unknown) {
  const work = () => authorizedProposal(context, id, operation, requested);
  if (!operation) return context.store.jevExecutor.serialized(work);
  await fileProposalAccess(context, id, operation, requested);
  return withFileProposalWrite(context.store, id, work);
}
export async function fileProposalRoutes(context: RouteContext): Promise<boolean> {
  const match = context.route.match(/^\/api\/file-proposals\/([^/]+)(?:\/(apply|undo))?$/);
  if (!match || (match[2] ? context.method !== 'POST' : context.method !== 'GET')) return false;
  const operation = match[2] as 'apply' | 'undo' | undefined;
  const requested = operation ? (await readBody(context.request)).canvasId : context.url.searchParams.get('canvasId');
  const value = await reviewedProposal(context, match[1], operation, requested);
  sendJson(context.response, 200, value);
  return true;
}
