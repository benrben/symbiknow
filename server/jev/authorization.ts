import type { JevActionRequest, JevJob, JevMutation, JevPrincipal, JevReceipt, JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import { ApiError } from '../errors.js';
import { createHash } from 'node:crypto';
import type { DocumentJob } from './runtime-document.js';
import { requireCurrentMutation, retiredTaskMutation } from './mutations.js';

export const automationPrincipal: JevPrincipal = { id: 'jev-workspace-automation', kind: 'automation', access: 'write' };

export function canvasAllowed(principal: JevPrincipal, canvasId: string): boolean {
  return !principal.allowedCanvasIds || principal.allowedCanvasIds.includes(canvasId);
}

export function mutationCanvases(mutation: JevMutation): string[] {
  if (mutation.kind === 'vocabulary') return mutation.term.members.map(member => member.canvasId);
  if (mutation.kind === 'derived') return [];
  if (mutation.kind === 'document') return [mutation.canvasId, ...(mutation.patch.crossLinks ?? []).map(link => link.canvasId)];
  return mutation.kind === 'move' ? [mutation.canvasId, mutation.targetCanvasId] : [mutation.canvasId];
}

export function requireTool(principal: JevPrincipal, names: string[]): void {
  if (principal.tools && !names.some(name => principal.tools!.includes(name))) throw new ApiError(403, 'This Jev operation is outside the tool grant');
}

export function requireCanvas(principal: JevPrincipal, canvasId: string): void {
  if (!canvasAllowed(principal, canvasId)) throw new ApiError(404, 'Document scope not found');
}

export function requireResetOwner(principal: JevPrincipal): void {
  if (!principal.canConfigure || principal.access !== 'write' || principal.allowedCanvasIds !== undefined)
    throw new ApiError(403, 'Workspace owner authorization is required to reset all Jev results');
}

export async function currentPrincipal(store: CanvasStore, principal: JevPrincipal): Promise<JevPrincipal> {
  if (!principal?.id || !['user', 'token', 'automation'].includes(principal.kind)) throw new ApiError(403, 'Trusted Jev authorization is required');
  if (principal.kind !== 'token') return principal;
  const token = (await store.getSettings()).mcpTokens?.find(item => item.id === principal.id);
  if (!token) return fixedPrincipal(principal);
  // getSettings normalizes the access field of legacy persisted tokens.
  return { id: token.id, kind: 'token', access: token.access!, allowedCanvasIds: token.allowedCanvasIds,
    tools: token.tools, canApprove: Boolean(token.canApprove), canConfigure: Boolean(token.canConfigure) };
}

function fixedPrincipal(principal: JevPrincipal): JevPrincipal {
    const fixed: Record<string, string | undefined> = {
      'env-token-primary': process.env.SYMBIKNOW_MCP_TOKEN, 'env-token-legacy': process.env.ALLTEAM_MCP_TOKEN,
      'access-token-primary': process.env.SYMBIKNOW_ACCESS_TOKEN, 'access-token-legacy': process.env.ALLTEAM_ACCESS_TOKEN,
    };
    if (principal.id !== 'local-stdio-agent' && !fixed[principal.id]) throw new ApiError(403, 'The agent authorization was revoked');
    return { id: principal.id, kind: 'token', access: 'write', canConfigure: false, canApprove: false };
}

export function requireWrite(principal: JevPrincipal): void {
  if (principal.access !== 'write') throw new ApiError(403, 'This Jev operation requires write access');
}

export function requireApprove(principal: JevPrincipal): void {
  requireWrite(principal);
  if (!principal.canApprove) throw new ApiError(403, 'An authorized reviewer must approve the proposal');
}

export async function rejectRetiredTaskMutation(store: CanvasStore, supplied: JevPrincipal,
  mutation: JevMutation, tools: string[]): Promise<void> {
  if (!retiredTaskMutation(mutation)) return;
  const principal = await currentPrincipal(store, supplied);
  requireApprove(principal);
  requireTool(principal, tools);
  for (const id of mutationCanvases(mutation)) requireCanvas(principal, id);
  requireCurrentMutation(mutation);
}

export function principalFingerprint(principal: JevPrincipal): string {
  const fixed: Record<string, string | undefined> = {
    'env-token-primary': process.env.SYMBIKNOW_MCP_TOKEN, 'env-token-legacy': process.env.ALLTEAM_MCP_TOKEN,
    'access-token-primary': process.env.SYMBIKNOW_ACCESS_TOKEN, 'access-token-legacy': process.env.ALLTEAM_ACCESS_TOKEN,
    'local-stdio-agent': process.env.SYMBIKNOW_ACCESS_TOKEN ?? process.env.ALLTEAM_ACCESS_TOKEN ?? 'local',
  };
  const grants = [principal.id, principal.kind, principal.access, Boolean(principal.canApprove), Boolean(principal.canConfigure),
    principal.allowedCanvasIds === undefined ? null : [...principal.allowedCanvasIds].sort(),
    principal.tools === undefined ? null : [...principal.tools].sort()];
  return createHash('sha256').update(JSON.stringify(grants)).update(fixed[principal.id] ?? '').digest('hex');
}

export function scopedState(state: JevWorkspaceState, principal: JevPrincipal): JevWorkspaceState {
  const allowedSources = (sources: Array<{ canvasId: string }>) => sources.every(source => canvasAllowed(principal, source.canvasId));
  const proposals = state.proposals.filter(item => allowedSources(item.sources) && mutationCanvases(item.mutation).every(id => canvasAllowed(principal, id)));
  const proposalIds = new Set(proposals.map(item => item.id));
  const jobs = state.jobs.filter(item => canvasAllowed(principal, item.request.canvasId) && allowedSources(item.sources)
    && ((item as JevJob & { contextCanvasIds?: string[] }).contextCanvasIds ?? []).every(id => canvasAllowed(principal, id))).map(publicJevJob);
  const vocabulary = state.vocabulary.filter(term => term.members.every(member => canvasAllowed(principal, member.canvasId)));
  const profiles = Object.fromEntries(Object.entries(state.profiles).filter(([key, value]) => canvasAllowed(principal, key.split(':')[0])
    && (!Array.isArray(value.scopedCanvasIds) || value.scopedCanvasIds.every(id => typeof id === 'string' && canvasAllowed(principal, id)))));
  return { ...state, jobs, proposals, vocabulary, profiles, receipts: state.receipts.filter(item => proposalIds.has(item.proposalId)).map(publicJevReceipt),
    prepared: [], suppressions: [], settings: { ...state.settings, schedules: [] } };
}

export function publicJevJob(job: JevJob): JevJob {
  const { id, request, state, createdAt, updatedAt, error, sources, proposalIds, result, questionVersion } = job;
  const plan = (job as DocumentJob).documentPlan;
  const documentPlan = plan ? { version: plan.version, originalSources: plan.originalSources.slice(0, 1),
    completedActions: plan.completedActions, claimPreparedAt: plan.claimPreparedAt,
    completionPreparedAt: plan.completionPreparedAt, queueWaitMs: plan.queueWaitMs,
    failedAction: plan.failedAction, failureReason: plan.failureReason } : undefined;
  return structuredClone({ id, request, state, createdAt, updatedAt, error, sources, proposalIds, result, questionVersion,
    ...(documentPlan ? { documentPlan } : {}) });
}
export function publicJevReceipt(receipt: JevReceipt): JevReceipt {
  const { id, proposalId, action, createdAt, actor, before, after, sourcesAfter, state, automatic } = receipt;
  return structuredClone({ id, proposalId, action, createdAt, actor, before, after, sourcesAfter, state, automatic });
}

export function runToolNames(request: JevActionRequest): string[] {
  return ['jev_do', request.action, `jev_${request.action}`];
}
