import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { JevPrincipal } from '../shared/jev-types.js';
import { accessToken, accessTokens, bearerToken, hasApiAccess, internalToken, isInternal, safeEqual } from './auth.js';
import { ApiError } from './errors.js';
import type { CanvasStore } from './storage.js';

const proofHeader = 'x-symbiknow-jev-principal';

/** Only the authenticated HTTP MCP host can issue a proof for its loopback call. */
export function jevPrincipalHeaders(id: string): Record<string, string> {
  const signature = createHmac('sha256', internalToken).update(id).digest('hex');
  return { [proofHeader]: `${id}.${signature}` };
}

function proofId(request: IncomingMessage): string {
  const proof = request.headers[proofHeader];
  if (typeof proof !== 'string') throw new ApiError(403, 'An authenticated agent identity is required');
  const separator = proof.lastIndexOf('.');
  const id = proof.slice(0, separator);
  const expected = createHmac('sha256', internalToken).update(id).digest('hex');
  if (separator < 1 || !safeEqual(proof.slice(separator + 1), expected)) throw new ApiError(403, 'Invalid agent identity');
  return id;
}

async function currentIdentity(store: CanvasStore, id: string): Promise<JevPrincipal> {
  const settings = await store.secretSettings();
  const token = settings.mcpTokens?.find(item => item.id === id);
  if (token) return { id, kind: 'token', access: token.access ?? 'write', allowedCanvasIds: token.allowedCanvasIds,
    tools: token.tools, canConfigure: false, canApprove: false };
  const fixed: Record<string, string | undefined> = {
    'env-token-primary': process.env.SYMBIKNOW_MCP_TOKEN, 'env-token-legacy': process.env.ALLTEAM_MCP_TOKEN,
    'access-token-primary': process.env.SYMBIKNOW_ACCESS_TOKEN, 'access-token-legacy': process.env.ALLTEAM_ACCESS_TOKEN,
  };
  if (!fixed[id]) throw new ApiError(403, 'The agent token is no longer authorized');
  return { id, kind: 'token', access: 'write', canConfigure: false, canApprove: false };
}

export async function jevApiPrincipal(store: CanvasStore, request: IncomingMessage, agent: boolean): Promise<JevPrincipal> {
  if (isInternal(request)) return currentIdentity(store, proofId(request));
  const identity = await store.mcpTokenIdentity(bearerToken(request));
  if (identity) return { ...identity, kind: 'token', canConfigure: false, canApprove: false };
  requireSessionAccess(request);
  if (agent) return { id: 'local-stdio-agent', kind: 'token', access: 'write', canConfigure: false, canApprove: false };
  requireOwnerOrigin(request);
  return { id: 'workspace-owner', kind: 'user', access: 'write', canConfigure: true, canApprove: true };
}

function requireSessionAccess(request: IncomingMessage): void {
  const presented = bearerToken(request);
  if (presented && !accessTokens().some(token => safeEqual(presented, token))) throw new ApiError(401, 'The agent token is no longer authorized');
  if (!hasApiAccess(request)) throw new ApiError(401, 'Sign in with the workspace access token');
}

function requireOwnerOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (origin && !sameOrigin(origin, request.headers.host)) throw new ApiError(403, 'Workspace review requires a same-origin session');
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
  if (!accessToken() && !local) throw new ApiError(403, 'Configure workspace authentication before remote review');
}

function sameOrigin(origin: string, host?: string): boolean {
  try { return new URL(origin).host === host; }
  catch { return false; }
}

export async function hasJevApiAccess(store: CanvasStore, request: IncomingMessage): Promise<boolean> {
  return hasApiAccess(request) || Boolean(await store.mcpTokenIdentity(bearerToken(request)));
}
