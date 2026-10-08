import { createHash } from 'node:crypto';
import type { CanvasDocument } from '../shared/types.js';
import type { RouteContext } from './api-context.js';
import { bearerToken, isInternal } from './auth.js';
import { ApiError } from './errors.js';
import { jevApiPrincipal } from './jev-api-principal.js';
import { groupLabels } from './jev/group-labels.js';
import { projectCanvasJevStatus } from './jev-canvas-status.js';

/** Resolve the current agent scope before conditional or summary reads can return. */
export async function canvasReadScope(context: RouteContext, canvasId: string): Promise<string[] | undefined> {
  if (context.mcpPrincipal) {
    return permittedCanvasIds(context.mcpPrincipal.allowedCanvasIds, canvasId);
  }
  const proof = context.request.headers['x-symbiknow-jev-principal'];
  if (!proof && (!bearerToken(context.request) || isInternal(context.request))) return undefined;
  const principal = await jevApiPrincipal(context.store, context.request, true);
  return permittedCanvasIds(principal.allowedCanvasIds, canvasId);
}
function permittedCanvasIds(allowed: string[] | undefined, canvasId: string): string[] | undefined {
  if (allowed && !allowed.includes(canvasId)) throw new ApiError(403, 'This token does not permit that canvas');
  return allowed;
}

export async function projectCanvasLabels(context: RouteContext, canvas: CanvasDocument, allowedCanvasIds?: string[]): Promise<CanvasDocument> {
  return projectCanvasJevStatus(context.store, { ...canvas, groupLabels: await groupLabels(context.store.root, canvas, allowedCanvasIds) });
}

/** Vocabulary renames and narrower permissions must invalidate an earlier canvas response. */
export function canvasLabelRevision(revision: string, labels?: Record<string, string>): string {
  if (!labels) return revision;
  return `"${createHash('sha256').update(revision).update(JSON.stringify(labels)).digest('hex')}"`;
}
